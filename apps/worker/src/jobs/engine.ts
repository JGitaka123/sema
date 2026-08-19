import type { OutboundMessage } from "@sema/channels";
import type { SqlExecutor, TenantClient, WithTenant, WithTenantDb } from "@sema/db";
import {
  AGENT_PROMPT_VERSION,
  classify,
  loadAgentContext,
  recordEscalation,
  recordRouteAudit,
  regenerateSummary,
  route,
  runAgent,
  shouldSummarise,
  type AgentClient,
  type AgentReply,
  type AgentRunResult,
  type ClassifierCache,
  type ClassifierMessage,
  type ClinicScriptConfig,
  type ConversationState,
  type DepositRequester,
  type EngineClient,
  type EscalationRequest,
  type ModelClient,
  type Notifier,
  type RouteDecision,
  type ScriptedReply,
} from "@sema/engine";
import type { Scheduler } from "@sema/scheduling";
import { DEFAULT_LANGUAGE, isE164, systemClock, type Clock, type E164, type Language } from "@sema/shared";

import { enqueueOutbound } from "./outbox.js";
import { row, rows } from "./sql.js";
import type { PersistedInbound } from "./inbound.js";

/**
 * The conversation pipeline: one inbound message, end to end.
 *
 *   classifier → router → scripted safety replies  (Phase 4)
 *                       → agent → guardrails       (Phase 5)
 *                       → outbox + audit
 *
 * This is the seam `inbound.ts` left as `onPersisted`. It lives in the worker
 * rather than in `@sema/engine` because it is the only place that knows about
 * the outbox, the queue and the channel — the engine stays a pure decision
 * package that can be unit tested without any of them.
 *
 * Three invariants:
 *
 *  1. **The classifier always runs first** (hard rule 1). There is no branch in
 *     this file that reaches `runAgent` without a `route()` that said to.
 *  2. **Nothing calls the channel.** Every outbound message is written to
 *     `outbox` and delivered by the outbox worker (CLAUDE.md §Conventions).
 *  3. **The agent stays silent in `human` mode** (hard rule 3). `inbound.ts`
 *     already gates on it; the router gates on it again, because a takeover can
 *     land between the two.
 */

export interface EngineDeps {
  readonly executor: SqlExecutor;
  readonly withTenant: WithTenant;
  readonly withTenantDb: WithTenantDb;
  readonly client: EngineClient;
  readonly scheduler: Scheduler;
  readonly depositRequester: DepositRequester;
  readonly cache?: ClassifierCache;
  readonly notifier?: Notifier;
  readonly clock?: Clock;
}

export type EngineOutcome =
  | { readonly status: "handled"; readonly route: RouteDecision["route"]; readonly agent?: AgentRunResult }
  /** A human has the conversation, or an abuse mute is in force. */
  | { readonly status: "silent"; readonly route: RouteDecision["route"] }
  /** Nothing to classify — an image or a location with no text. */
  | { readonly status: "skipped"; readonly reason: "no_text" | "no_patient_phone" };

interface ClinicRow {
  name: string;
  default_language: string;
  emergency_contact_phone: string | null;
  emergency_script_override: string | null;
  timezone: string;
  specialty: string | null;
}

interface MessageRow {
  body: string | null;
  transcript: string | null;
}

interface ConversationRow {
  mode: string;
  message_count: string | number;
}

interface PatientRow {
  phone_e164: string;
  language: string | null;
}

/** CONVERSATION_ENGINE.md §2: "last 3 messages + current". */
const RECENT_LIMIT = 3;

function asLanguage(value: string | null | undefined): Language {
  return value === "sw" || value === "en" ? value : DEFAULT_LANGUAGE;
}

/** SAFETY.md §7: "Three abusive messages → mute agent for 24h". */
const ABUSE_MUTE_MS = 24 * 60 * 60 * 1000;

interface RouterCounters {
  readonly abusiveStrikes: number;
  readonly outOfScopeStreak: number;
  /** When an abuse mute lifts, or null when none is in force. */
  readonly agentMutedUntil: Date | null;
}

/**
 * The router's counters, derived from `audit_log`.
 *
 * `abusive_strikes`, `out_of_scope_streak` and `agent_muted_until` do not exist
 * as columns — the inbox settings that would surface them are Phase 8 — so they
 * are read back out of the audit trail, which already records every routing
 * decision and is already what an auditor would read. Both queries are bounded,
 * indexed lookups on one conversation.
 *
 * Two consequences worth being explicit about:
 *
 *  1. The out-of-scope figure is a **count over 24 hours, not a consecutive
 *     streak**: a patient who asked for advice twice in a day escalates even if
 *     they booked an appointment in between. That errs toward putting a human
 *     in the loop, which is the direction SAFETY.md asks for everywhere else.
 *  2. **The mute has to expire.** `route()` mutes by setting
 *     `conversation.mode = 'muted'`, and with no expiry column that would be
 *     permanent — a patient who swore three times in March would never hear
 *     from the agent again. `agentMutedUntil` is computed from the instant the
 *     mute was recorded, and `isMuted()` in the router checks it *before*
 *     falling back to `mode`, so the 24 hours in SAFETY.md §7 are real.
 */
async function loadCounters(
  client: TenantClient,
  clinicId: string,
  conversationId: string,
): Promise<RouterCounters> {
  const found = await rows<{ action: string; total: string | number }>(
    client,
    `select action, count(*) as total
       from audit_log
      where clinic_id = $1 and entity = 'conversation' and entity_id = $2
        and action in ('route.abusive.warned', 'route.abusive.muted', 'route.out_of_scope', 'route.out_of_scope.escalated')
        and at > now() - interval '24 hours'
      group by action`,
    [clinicId, conversationId],
  );

  const count = (...actions: string[]): number =>
    found
      .filter((r) => actions.includes(r.action))
      .reduce((total, r) => total + Number(r.total), 0);

  const muted = await row<{ at_ms: number }>(
    client,
    `select (extract(epoch from at) * 1000)::float8 as at_ms
       from audit_log
      where clinic_id = $1 and entity = 'conversation' and entity_id = $2
        and action = 'route.abusive.muted'
      order by at desc
      limit 1`,
    [clinicId, conversationId],
  );

  const mutedUntil =
    muted === undefined ? null : new Date(Math.round(Number(muted.at_ms)) + ABUSE_MUTE_MS);

  return {
    abusiveStrikes: count("route.abusive.warned", "route.abusive.muted"),
    outOfScopeStreak: count("route.out_of_scope", "route.out_of_scope.escalated"),
    agentMutedUntil: mutedUntil,
  };
}

/** Is the clinic open right now? Drives which holding message is sent (SAFETY.md §6). */
async function isInHours(client: TenantClient, clinicId: string, tz: string): Promise<boolean> {
  const found = await row<{ open: boolean }>(
    client,
    `select exists (
       select 1 from availability_rule
        where clinic_id = $1
          and weekday = extract(dow from (now() at time zone $2))::int
          and start_local <= (now() at time zone $2)::time
          and end_local   >  (now() at time zone $2)::time
     ) as open`,
    [clinicId, tz],
  );
  return found?.open ?? true;
}

/** Turn an engine reply into the channel-neutral outbound shape. */
function toOutbound(reply: AgentReply | ScriptedReply, to: E164): OutboundMessage {
  if ("key" in reply) return { kind: "text", to, body: reply.body };
  if (reply.kind === "location") {
    return {
      kind: "location",
      to,
      latitude: reply.latitude,
      longitude: reply.longitude,
      ...(reply.name === undefined ? {} : { name: reply.name }),
      ...(reply.address === undefined ? {} : { address: reply.address }),
    };
  }
  // Interactive when the agent offered tappable choices, plain text otherwise
  // (INTEGRATIONS.md §1: buttons for ≤ 3 options).
  if (reply.options !== undefined && reply.options.length > 0 && reply.options.length <= 3) {
    return {
      kind: "interactive",
      to,
      body: reply.body,
      options: reply.options.map((option) => ({ id: option.id, title: option.title })),
    };
  }
  return { kind: "text", to, body: reply.body };
}

export async function handleInbound(
  persisted: PersistedInbound,
  deps: EngineDeps,
): Promise<EngineOutcome> {
  const clock = deps.clock ?? systemClock;
  const now = clock.now();
  const { clinicId, conversationId, patientId, messageId } = persisted;

  // ── Load what the classifier and router need, in one transaction ──────────
  const loaded = await deps.withTenant(clinicId, async (client) => {
    const clinic = await row<ClinicRow>(
      client,
      // The classifier gets the clinic's specialty so it can tell what is
      // routine here — a dental practice hears about tooth pain all day
      // (CONVERSATION_ENGINE.md §2). The lowest-sorted active provider is the
      // best proxy we have until a `clinic.specialty` column exists.
      `select c.name, c.default_language, c.emergency_contact_phone, c.emergency_script_override,
              c.timezone,
              (select p.specialty from provider p
                where p.clinic_id = c.id and p.is_active
                order by p.sort, p.id limit 1) as specialty
         from clinic c where c.id = $1 and c.deleted_at is null`,
      [clinicId],
    );
    if (!clinic) return undefined;

    const message = await row<MessageRow>(
      client,
      `select body, transcript from message where clinic_id = $1 and id = $2`,
      [clinicId, messageId],
    );

    const conversation = await row<ConversationRow>(
      client,
      `select c.mode,
              (select count(*) from message m
                where m.clinic_id = c.clinic_id and m.conversation_id = c.id) as message_count
         from conversation c where c.clinic_id = $1 and c.id = $2`,
      [clinicId, conversationId],
    );

    const patient = await row<PatientRow>(
      client,
      `select phone_e164, language from patient where clinic_id = $1 and id = $2`,
      [clinicId, patientId],
    );

    const recent = await rows<{ direction: string; body: string | null; transcript: string | null }>(
      client,
      `select direction, body, transcript from message
        where clinic_id = $1 and conversation_id = $2 and id <> $3
          and coalesce(body, transcript) is not null
        order by at desc, id desc
        limit $4`,
      [clinicId, conversationId, messageId, RECENT_LIMIT],
    );

    const counters = await loadCounters(client, clinicId, conversationId);
    const inHours = await isInHours(client, clinicId, clinic.timezone);

    return { clinic, message, conversation, patient, recent, counters, inHours };
  });

  if (!loaded?.clinic || !loaded.conversation) return { status: "skipped", reason: "no_text" };

  const text = (loaded.message?.body ?? loaded.message?.transcript ?? "").trim();
  if (text === "") {
    // Media with no caption. CONVERSATION_ENGINE.md §7 keeps the agent away
    // from images entirely; the message is stored and the inbox shows it.
    return { status: "skipped", reason: "no_text" };
  }

  const phone = loaded.patient?.phone_e164;
  if (!isE164(phone)) return { status: "skipped", reason: "no_patient_phone" };

  const clinicConfig: ClinicScriptConfig = {
    name: loaded.clinic.name,
    defaultLanguage: asLanguage(loaded.clinic.default_language),
    emergencyScriptOverride: loaded.clinic.emergency_script_override,
  };

  const conversationState: ConversationState = {
    mode: loaded.conversation.mode === "human" || loaded.conversation.mode === "muted"
      ? loaded.conversation.mode
      : "agent",
    abusiveStrikes: loaded.counters.abusiveStrikes,
    outOfScopeStreak: loaded.counters.outOfScopeStreak,
    agentMutedUntil: loaded.counters.agentMutedUntil,
    // The consent notice goes out with the first reply of the conversation
    // (COMPLIANCE.md §1): one stored message means this is it.
    isFirstContact: Number(loaded.conversation.message_count) <= 1,
    inHours: loaded.inHours,
  };

  // ── 1. Classifier. Always, before anything else (hard rule 1) ─────────────
  const recent: ClassifierMessage[] = loaded.recent
    .slice()
    .reverse()
    .map((message) => ({
      role: message.direction === "in" ? ("patient" as const) : ("clinic" as const),
      text: message.body ?? message.transcript ?? "",
    }));

  const classification = await classify(
    {
      message: text,
      recent,
      clinicId,
      ...(loaded.clinic.specialty === null ? {} : { clinicSpecialty: loaded.clinic.specialty }),
    },
    { client: deps.client as ModelClient, ...(deps.cache === undefined ? {} : { cache: deps.cache }) },
  );

  // ── 2. Router ─────────────────────────────────────────────────────────────
  const decision = route({
    classification,
    clinic: clinicConfig,
    conversation: conversationState,
    now,
  });

  const escalationDeps = {
    withTenantDb: deps.withTenantDb,
    ...(deps.notifier === undefined ? {} : { notifier: deps.notifier }),
    now: () => now,
  };

  await recordRouteAudit({ clinicId, conversationId, entry: decision.audit }, escalationDeps);

  const queue = async (
    messages: readonly OutboundMessage[],
    meta: Record<string, unknown>,
  ): Promise<void> => {
    if (messages.length === 0) return;
    await deps.withTenant(clinicId, async (client) => {
      for (const message of messages) {
        await enqueueOutbound(client, {
          clinicId,
          conversationId,
          message,
          sentBy: "agent",
          meta,
        });
      }
    });
  };

  const escalate = async (request: EscalationRequest): Promise<void> => {
    await recordEscalation(
      {
        clinicId,
        conversationId,
        request,
        classification,
        emergencyContactPhone: loaded.clinic?.emergency_contact_phone ?? null,
      },
      escalationDeps,
    );
  };

  // Scripted replies first: an emergency script must not wait behind the agent.
  await queue(
    decision.replies.map((reply) => toOutbound(reply, phone)),
    { prompt_version: classification.promptVersion, scripted: true },
  );
  if (decision.escalation) await escalate(decision.escalation);
  await applyConversationUpdates(deps, clinicId, conversationId, decision);

  if (!decision.runAgent) {
    return decision.route === "silent"
      ? { status: "silent", route: decision.route }
      : { status: "handled", route: decision.route };
  }

  // ── 3. Agent ──────────────────────────────────────────────────────────────
  const context = await loadAgentContext(
    { withTenantDb: deps.withTenantDb, now: () => now },
    { clinicId, conversationId, patientId },
  );

  const run = await runAgent(
    {
      clinicId,
      conversationId,
      patientId,
      message: text,
      context,
      patientLanguage: classification.output.language,
      ...(decision.agentAddendum === undefined ? {} : { addendum: decision.agentAddendum }),
    },
    {
      client: deps.client as EngineClient & AgentClient,
      withTenantDb: deps.withTenantDb,
      scheduler: deps.scheduler,
      clock,
      depositRequester: deps.depositRequester,
      now: () => now,
    },
  );

  // §10: every agent-authored message carries the prompt version that made it.
  await queue(
    run.replies.map((reply) => toOutbound(reply, phone)),
    {
      prompt_version: run.promptVersion,
      model: run.model,
      classifier_prompt_version: classification.promptVersion,
      stop_reason: run.stopReason,
      rewritten: run.rewritten,
      tool_calls: run.toolCalls.map((call) => call.name),
    },
  );

  if (run.escalation) {
    await escalate({
      kind: run.escalation.kind,
      reason: run.escalation.reason,
      pinConversation: false,
      notify: ["inbox"],
    });
  }

  /**
   * CONVERSATION_ENGINE.md §8. Once the thread is longer than the window the
   * agent reads in full, the summary is what stands in for the older half — so
   * it has to be kept current, or the agent loses the start of the
   * conversation.
   *
   * After the replies are queued, never before: the patient's message is
   * already answered by this point, so a slow or failing summariser costs
   * nobody a reply. A failure leaves the previous summary in place
   * (`regenerateSummary` never clears it) and is swallowed here, because a
   * conversation that was handled correctly must not fail its job over
   * housekeeping.
   */
  if (shouldSummarise(context)) {
    try {
      await regenerateSummary(
        { clinicId, conversationId, trigger: "length" },
        { withTenantDb: deps.withTenantDb, client: deps.client, now: () => now },
      );
    } catch {
      // Housekeeping. The conversation is already answered and audited.
    }
  }

  return { status: "handled", route: decision.route, agent: run };
}

/** Persist the router's counters: the mute, the pin. */
async function applyConversationUpdates(
  deps: EngineDeps,
  clinicId: string,
  conversationId: string,
  decision: RouteDecision,
): Promise<void> {
  const updates = decision.conversationUpdates;
  if (updates.mode === undefined && updates.pinned === undefined) return;

  await deps.withTenant(clinicId, async (client) => {
    await client.query(
      `update conversation
          set mode   = coalesce($3::conversation_mode, mode),
              pinned = coalesce($4::boolean, pinned),
              updated_at = now()
        where clinic_id = $1 and id = $2`,
      [clinicId, conversationId, updates.mode ?? null, updates.pinned ?? null],
    );
  });
}

/** Exported so the prompt-version stamp can be asserted without a database. */
export const ENGINE_PROMPT_VERSION = AGENT_PROMPT_VERSION;
