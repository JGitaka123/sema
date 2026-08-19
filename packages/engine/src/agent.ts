import { formatMoney, money, type CurrencyCode } from "@sema/shared";

import {
  ModelCallError,
  textOf,
  toolUsesOf,
  type AgentTurn,
  type AssistantBlock,
  type EngineClient,
  type ToolResultBlock,
} from "./client.js";
import {
  renderAgentPrompt,
  renderClinicFacts,
  renderHistory,
  type AgentContext,
} from "./context.js";
import { checkReply, rewriteInstruction, type GuardrailViolation } from "./guardrails.js";
import { AGENT_MAX_TOKENS, AGENT_TIMEOUT_MS, MODELS } from "./models.js";
import { AGENT_PROMPT_VERSION } from "./prompts/index.js";
import { AGENT_TOOLS, createAuditor, executeToolCall, renderToolGuidance, toolSpecs } from "./tools/index.js";
import type { AnyToolDefinition, ToolDeps, ToolEffects, ToolRuntime } from "./tools/types.js";
import type { ClassifierLanguage, EscalationKind } from "./types.js";

/**
 * The agent loop (CONVERSATION_ENGINE.md §3).
 *
 * The shape of one inbound message's turn:
 *
 *   budget check → model → (tools → model)* → guardrails → (rewrite → guardrails)?
 *
 * Four hard limits, all of them enforced here in code rather than asked for in
 * the prompt, because every one of them exists for the case where the model is
 * not behaving:
 *
 *   - **6 tool calls** per inbound message (§3.3)
 *   - **8 agent turns** per conversation-day, then a forced escalate (§3.3)
 *   - **loop detection**: the same tool with the same arguments twice breaks the
 *     loop and escalates `agent_error` (§3.3)
 *   - **one model retry**, then the safe fallback reply and an escalation (§3.3)
 *
 * The function never throws for a model or tool problem. Every path ends in
 * something the patient can be sent, because the alternative — a job that
 * retries and re-sends, or a patient left in silence — is worse than a plain
 * "someone will get back to you".
 */

export type AgentReply =
  | { readonly kind: "text"; readonly body: string; readonly options?: readonly AgentOption[] }
  | {
      readonly kind: "location";
      readonly latitude: number;
      readonly longitude: number;
      readonly name?: string;
      readonly address?: string;
    };

export interface AgentOption {
  readonly id: string;
  readonly title: string;
}

/** Why a turn ended. Audited, and the thing to alert on. */
export type AgentStopReason =
  | "replied"
  | "turn_budget_exhausted"
  | "tool_budget_exhausted"
  | "loop_detected"
  | "model_error"
  | "guardrail_failed"
  | "empty_reply";

export interface AgentEscalation {
  readonly kind: EscalationKind;
  readonly reason: string;
}

export interface AgentRunResult {
  readonly replies: readonly AgentReply[];
  readonly escalation?: AgentEscalation;
  readonly stopReason: AgentStopReason;
  /** Stamped on `message.meta.prompt_version` (CONVERSATION_ENGINE.md §10). */
  readonly promptVersion: string;
  readonly model: string;
  /** PHI-free trace for the audit row and the log line. */
  readonly toolCalls: readonly AgentToolCallTrace[];
  readonly guardrailViolations: readonly GuardrailViolation[];
  readonly rewritten: boolean;
  readonly modelCalls: number;
  readonly latencyMs: number;
}

export interface AgentToolCallTrace {
  readonly name: string;
  readonly ok: boolean;
}

export interface AgentInput {
  readonly clinicId: string;
  readonly conversationId: string;
  readonly patientId: string;
  /** The patient's message (or its voice transcript). */
  readonly message: string;
  readonly context: AgentContext;
  readonly patientLanguage: ClassifierLanguage;
  /** `RouteDecision.agentAddendum` — the router's low-confidence seam. */
  readonly addendum?: "conservative" | undefined;
}

export interface AgentDeps extends ToolDeps {
  readonly client: EngineClient;
  readonly tools?: readonly AnyToolDefinition[];
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

/** §3.3: "Max 6 tool calls per inbound message." */
export const MAX_TOOL_CALLS = 6;

/** §3.3: "max 8 agent turns per conversation-day before forced escalate". */
export const MAX_TURNS_PER_DAY = 8;

/** §3.3, verbatim. Never paraphrased — it is a reviewed line. */
export const SAFE_FALLBACK_REPLY =
  "Sorry, I'm having trouble right now — a team member will reply shortly.";

/**
 * WhatsApp renders up to three reply buttons before falling back to a list
 * message (INTEGRATIONS.md §1), and §3.1 caps slot offers at three anyway.
 */
export const MAX_REPLY_OPTIONS = 3;

/** Tools whose presence means this turn did more than look. */
const MUTATING_AFTER_SEARCH = new Set([
  "hold_slot",
  "book_appointment",
  "reschedule_appointment",
  "cancel_appointment",
]);

/** Sent when the turn budget runs out and a human takes over. */
export const TURN_BUDGET_REPLY =
  "Let me get a team member to take this from here — someone will reply shortly.";

function fallback(
  stopReason: AgentStopReason,
  reason: string,
  body: string,
  base: Omit<AgentRunResult, "replies" | "escalation" | "stopReason">,
): AgentRunResult {
  return {
    ...base,
    replies: [{ kind: "text", body }],
    escalation: { kind: "agent_error", reason },
    stopReason,
  };
}

/**
 * The corpus the guardrail grounds against.
 *
 * The clinic facts block *plus* everything this turn's tools returned. Not the
 * conversation history: a price the agent invented in an earlier turn must not
 * become grounded truth for the next one just because it is now in the
 * transcript.
 */
function groundingCorpus(context: AgentContext, toolFacts: readonly string[]): string {
  return [renderClinicFacts(context), ...toolFacts].join("\n");
}

/** Numbers the agent is allowed to print (see `checkPii`). */
function allowedPhones(context: AgentContext): readonly string[] {
  return context.locations
    .map((location) => location.phone)
    .filter((phone): phone is string => phone !== null);
}

/** A stable key for loop detection: same tool, same arguments. */
function callKey(name: string, input: unknown): string {
  try {
    return `${name}:${JSON.stringify(input)}`;
  } catch {
    return `${name}:unserialisable`;
  }
}

export async function runAgent(input: AgentInput, deps: AgentDeps): Promise<AgentRunResult> {
  const now = deps.now ?? ((): Date => new Date());
  const startedAt = now().getTime();
  const tools = deps.tools ?? AGENT_TOOLS;
  const audit = createAuditor(deps.withTenantDb, input.clinicId, now);

  const toolCalls: AgentToolCallTrace[] = [];
  const toolFacts: string[] = [];
  let modelCalls = 0;

  const base = (): Omit<AgentRunResult, "replies" | "escalation" | "stopReason"> => ({
    promptVersion: AGENT_PROMPT_VERSION,
    model: MODELS.agent,
    toolCalls: [...toolCalls],
    guardrailViolations: [],
    rewritten: false,
    modelCalls,
    latencyMs: now().getTime() - startedAt,
  });

  // ── Turn budget ───────────────────────────────────────────────────────────
  // Checked before the first model call, not after: a conversation that has
  // already had eight agent replies today is one where the agent is evidently
  // not helping, and a ninth attempt costs the patient another wait.
  if (input.context.agentTurnsToday >= MAX_TURNS_PER_DAY) {
    await audit({
      action: "agent.turn_budget_exhausted",
      entity: "conversation",
      entityId: input.conversationId,
      meta: { turns_today: input.context.agentTurnsToday, limit: MAX_TURNS_PER_DAY },
    });
    return {
      ...base(),
      replies: [{ kind: "text", body: TURN_BUDGET_REPLY }],
      escalation: {
        kind: "low_confidence",
        reason: `agent_turn_budget_exhausted:${input.context.agentTurnsToday}`,
      },
      stopReason: "turn_budget_exhausted",
    };
  }

  const system = renderAgentPrompt({
    context: input.context,
    toolGuidance: renderToolGuidance(tools),
    addendum: input.addendum,
  });

  const history = renderHistory(input.context);
  const opening = history === "" ? input.message : `${history}\n\npatient: ${input.message}`;

  const messages: AgentTurn[] = [{ role: "user", content: opening }];
  const specs = toolSpecs(tools);

  const runtime: ToolRuntime = {
    clinicId: input.clinicId,
    conversationId: input.conversationId,
    patientId: input.patientId,
    context: input.context,
    deps: {
      withTenantDb: deps.withTenantDb,
      scheduler: deps.scheduler,
      clock: deps.clock,
      depositRequester: deps.depositRequester,
    },
    audit,
  };

  /** One model call, with the single retry §3.3 allows. */
  const callModel = async (): Promise<readonly AssistantBlock[] | "error"> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        modelCalls += 1;
        const response = await deps.client.converse({
          model: MODELS.agent,
          system,
          messages,
          tools: specs,
          maxTokens: AGENT_MAX_TOKENS,
          timeoutMs: AGENT_TIMEOUT_MS,
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        });
        return response.blocks;
      } catch (error) {
        if (!(error instanceof ModelCallError)) throw error;
        await audit({
          action: "agent.model_error",
          entity: "conversation",
          entityId: input.conversationId,
          meta: { attempt: attempt + 1, reason: error.reason },
        });
        if (attempt === 1) return "error";
      }
    }
    return "error";
  };

  const seenCalls = new Set<string>();
  const effects: ToolEffects[] = [];
  let escalation: AgentEscalation | undefined;
  let finalBlocks: readonly AssistantBlock[] = [];

  // ── The tool-use loop ─────────────────────────────────────────────────────
  for (;;) {
    const blocks = await callModel();
    if (blocks === "error") {
      return fallback("model_error", "model_unavailable_after_retry", SAFE_FALLBACK_REPLY, base());
    }

    const uses = toolUsesOf(blocks);
    if (uses.length === 0) {
      finalBlocks = blocks;
      break;
    }

    // A model that asks for more tools than remain in the budget gets none of
    // them: running a partial batch would leave the conversation describing
    // work that half happened.
    if (toolCalls.length + uses.length > MAX_TOOL_CALLS) {
      await audit({
        action: "agent.tool_budget_exhausted",
        entity: "conversation",
        entityId: input.conversationId,
        meta: { used: toolCalls.length, requested: uses.length, limit: MAX_TOOL_CALLS },
      });
      return fallback(
        "tool_budget_exhausted",
        `tool_budget_exhausted:${toolCalls.length}`,
        SAFE_FALLBACK_REPLY,
        base(),
      );
    }

    messages.push({ role: "assistant", content: blocks });
    const results: ToolResultBlock[] = [];

    for (const use of uses) {
      const key = callKey(use.name, use.input);
      if (seenCalls.has(key)) {
        await audit({
          action: "agent.loop_detected",
          entity: "conversation",
          entityId: input.conversationId,
          meta: { tool: use.name, calls: toolCalls.length },
        });
        return fallback(
          "loop_detected",
          `repeated_tool_call:${use.name}`,
          SAFE_FALLBACK_REPLY,
          base(),
        );
      }
      seenCalls.add(key);

      const outcome = await executeToolCall(use.name, use.input, runtime);
      toolCalls.push({ name: use.name, ok: outcome.ok });
      if (outcome.facts) toolFacts.push(...outcome.facts);
      if (outcome.effects) {
        effects.push(outcome.effects);
        if (outcome.effects.escalate) escalation = outcome.effects.escalate;
      }

      results.push({
        type: "tool_result",
        toolUseId: use.id,
        content: JSON.stringify(outcome.payload),
        ...(outcome.ok ? {} : { isError: true }),
      });
    }

    messages.push({ role: "user", content: results });
  }

  // ── Guardrails ────────────────────────────────────────────────────────────
  const corpus = groundingCorpus(input.context, toolFacts);
  const phones = allowedPhones(input.context);

  const guardrailInput = {
    groundingCorpus: corpus,
    patientLanguage: input.patientLanguage,
    allowedPhones: phones,
    patientFirstName: input.context.patient.firstName,
  };

  let text = textOf(finalBlocks);
  if (text === "") {
    // The model finished without saying anything. There is nothing to send and
    // nothing to rewrite, so a human takes it.
    await audit({
      action: "agent.empty_reply",
      entity: "conversation",
      entityId: input.conversationId,
      meta: { tool_calls: toolCalls.length },
    });
    return fallback("empty_reply", "model_returned_no_text", SAFE_FALLBACK_REPLY, base());
  }

  let checked = await checkReply({ ...guardrailInput, reply: text }, { client: deps.client, ...(deps.signal === undefined ? {} : { signal: deps.signal }) });
  let rewritten = false;
  const allViolations: GuardrailViolation[] = [...checked.violations];

  if (checked.failed) {
    await audit({
      action: "agent.guardrail_blocked",
      entity: "conversation",
      entityId: input.conversationId,
      meta: {
        attempt: 1,
        checks: checked.violations
          .filter((violation) => violation.severity === "fail")
          .map((violation) => violation.check)
          .join(","),
      },
    });

    // One rewrite, with the violation named (§4). The blocked text goes into
    // the transcript we send back so the model can see what it wrote — it never
    // reached the patient.
    messages.push({ role: "assistant", content: finalBlocks });
    messages.push({ role: "user", content: rewriteInstruction(checked.violations) });

    const retryBlocks = await callModel();
    if (retryBlocks === "error") {
      return fallback("model_error", "rewrite_model_unavailable", SAFE_FALLBACK_REPLY, base());
    }

    // The rewrite is a text turn. A model that answers it with more tool calls
    // has not done what was asked, and the loop is over.
    rewritten = true;
    text = textOf(retryBlocks);
    finalBlocks = retryBlocks;

    checked =
      text === ""
        ? checked
        : await checkReply({ ...guardrailInput, reply: text }, { client: deps.client, ...(deps.signal === undefined ? {} : { signal: deps.signal }) });
    allViolations.push(...checked.violations);

    if (text === "" || checked.failed) {
      await audit({
        action: "agent.guardrail_blocked",
        entity: "conversation",
        entityId: input.conversationId,
        meta: {
          attempt: 2,
          checks: checked.violations
            .filter((violation) => violation.severity === "fail")
            .map((violation) => violation.check)
            .join(","),
        },
      });
      return {
        ...base(),
        guardrailViolations: allViolations,
        rewritten: true,
        replies: [{ kind: "text", body: SAFE_FALLBACK_REPLY }],
        escalation: { kind: "agent_error", reason: "guardrail_failed_twice" },
        stopReason: "guardrail_failed",
      };
    }
  }

  /**
   * Slot buttons (§3.1: "use interactive buttons where the channel supports
   * them").
   *
   * Only when this turn searched and did *not* go on to act. A reply that
   * follows a `hold_slot` or a `book_appointment` is a confirmation, and
   * hanging "pick a time" buttons off it would invite the patient to tap
   * something that has already happened.
   */
  const acted = toolCalls.some((call) => MUTATING_AFTER_SEARCH.has(call.name));
  const options = acted
    ? undefined
    : effects.flatMap((effect) => effect.offerOptions ?? []).slice(0, MAX_REPLY_OPTIONS);

  const replies: AgentReply[] = [
    {
      kind: "text",
      body: checked.text,
      ...(options === undefined || options.length === 0 ? {} : { options }),
    },
  ];
  for (const effect of effects) {
    if (effect.sendLocation) {
      replies.push({ kind: "location", ...effect.sendLocation });
    }
  }

  await audit({
    action: "agent.replied",
    entity: "conversation",
    entityId: input.conversationId,
    meta: {
      prompt_version: AGENT_PROMPT_VERSION,
      model: MODELS.agent,
      tool_calls: toolCalls.map((call) => call.name).join(",") || null,
      model_calls: modelCalls,
      rewritten,
      warnings: checked.warnings.map((warning) => warning.check).join(",") || null,
      escalated: escalation?.kind ?? null,
      reply_chars: checked.text.length,
    },
  });

  return {
    ...base(),
    replies,
    ...(escalation === undefined ? {} : { escalation }),
    stopReason: "replied",
    guardrailViolations: allViolations,
    rewritten,
  };
}

/**
 * PHI-free log projection for one agent run (hard rule 4).
 *
 * The counterpart to `classifierLogFields` / `routeLogFields` in `logging.ts`,
 * and covered by the same test: reply text, tool arguments and the patient's
 * message never appear here.
 */
export function agentLogFields(
  result: AgentRunResult,
): Readonly<Record<string, string | number | boolean | null>> {
  return {
    stop_reason: result.stopReason,
    prompt_version: result.promptVersion,
    model: result.model,
    model_calls: result.modelCalls,
    tool_calls: result.toolCalls.map((call) => call.name).join(",") || null,
    tool_failures: result.toolCalls.filter((call) => !call.ok).length,
    guardrail_failures: result.guardrailViolations.filter((v) => v.severity === "fail").length,
    guardrail_checks:
      result.guardrailViolations.map((violation) => violation.check).join(",") || null,
    rewritten: result.rewritten,
    escalation_kind: result.escalation?.kind ?? null,
    reply_count: result.replies.length,
    latency_ms: result.latencyMs,
  };
}

/**
 * A deposit amount rendered for a patient, used by the worker when it explains
 * a `pending_deposit` booking outside the agent's own words. Here rather than
 * in the worker so money formatting stays in one place (CLAUDE.md §Conventions).
 */
export function formatDeposit(amountMinor: number, currency: string): string {
  return formatMoney(money(amountMinor, currency as CurrencyCode));
}
