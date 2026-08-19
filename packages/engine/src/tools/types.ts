import type { WithTenantDb } from "@sema/db";
import type { Scheduler } from "@sema/scheduling";
import type { Clock } from "@sema/shared";
import type { z } from "zod";

import type { AgentContext } from "../context.js";
import type { EscalationKind } from "../types.js";

/**
 * The agent's tools (CONVERSATION_ENGINE.md §3.2).
 *
 * Four properties hold for every tool in this directory, and the tests in
 * `tools/*.test.ts` assert each of them:
 *
 *  1. **Zod-validated.** The model's `input` is untrusted JSON. It is parsed
 *     before a single line of the handler runs, and a parse failure comes back
 *     to the model as a structured error rather than throwing.
 *  2. **Tenant-scoped.** Every read and write goes through `withTenantDb` (or
 *     through `@sema/scheduling`, which does the same), so RLS is in force and
 *     a hallucinated id from another clinic simply does not resolve.
 *  3. **Audited.** One `audit_log` row per call (hard rule 7), with ids, codes
 *     and outcomes — never a message body or a patient's own words.
 *  4. **Policy lives here, not in the prompt.** Cancellation windows and
 *     deposit requirements are decided by code the model cannot argue with
 *     (SAFETY.md §8: "Policies live in tools. Prompts are defence in depth, not
 *     the only defence.").
 */

/**
 * What a tool hands back to the loop.
 *
 * `result` is serialised to JSON and returned to the model verbatim. `facts`
 * are the strings the guardrail may treat as grounded for this turn — a price
 * or a time the agent quotes must appear in one of them (CONVERSATION_ENGINE.md
 * §4.2). Keeping them separate from `result` means a tool can ground a value it
 * did not literally print, and can decline to ground one it did.
 */
export interface ToolOutcome {
  readonly ok: boolean;
  readonly result: Record<string, unknown>;
  readonly facts?: readonly string[];
  readonly effects?: ToolEffects;
}

/** Side effects the loop, not the tool, is responsible for carrying out. */
export interface ToolEffects {
  /** The agent asked for a human. The loop records it and stops after this turn. */
  readonly escalate?: { readonly kind: EscalationKind; readonly reason: string };
  /** Send the clinic's map pin alongside the text reply. */
  readonly sendLocation?: {
    readonly latitude: number;
    readonly longitude: number;
    readonly name?: string;
    readonly address?: string;
  };
  /**
   * Tappable choices to attach to the reply (INTEGRATIONS.md §1: "Interactive
   * buttons (≤3) for slot picks").
   *
   * Set by the tool rather than written by the model, so a button can only ever
   * offer something the scheduler actually returned — the same reason the
   * guardrail grounds times against tool results rather than against the
   * transcript.
   */
  readonly offerOptions?: readonly { readonly id: string; readonly title: string }[];
}

export interface AuditRecord {
  /** `agent.tool.search_slots` and friends. */
  readonly action: string;
  readonly entity: string;
  readonly entityId: string;
  /** PHI-free: ids, counts, enums, amounts. Never patient text. */
  readonly meta: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * A deposit request, behind an interface.
 *
 * **Phase 6 owns real M-Pesa** (BUILD_PLAN.md). This seam exists so the agent's
 * booking flow is complete and testable today: the stub records the intent as a
 * `payment_request` row and returns "requested", and Phase 6 replaces the
 * implementation with a Daraja STK Push without the agent, the tools or the
 * evals changing. Nothing here talks to Safaricom.
 */
export interface DepositRequester {
  request(input: DepositRequestInput): Promise<DepositRequestResult>;
}

export interface DepositRequestInput {
  readonly clinicId: string;
  readonly appointmentId: string;
  readonly patientId: string;
  readonly amountMinor: number;
  readonly currency: string;
}

export interface DepositRequestResult {
  readonly status: "requested" | "already_requested" | "not_required";
  readonly paymentRequestId: string | null;
  /** True while the stub is in place, so callers can be honest in the inbox. */
  readonly simulated: boolean;
}

export interface ToolDeps {
  readonly withTenantDb: WithTenantDb;
  readonly scheduler: Scheduler;
  readonly clock: Clock;
  readonly depositRequester: DepositRequester;
}

/** Everything a tool handler is given, beyond its own validated input. */
export interface ToolRuntime {
  readonly clinicId: string;
  readonly conversationId: string;
  readonly patientId: string;
  readonly context: AgentContext;
  readonly deps: ToolDeps;
  /** Write the audit row for this call. The loop supplies the implementation. */
  readonly audit: (record: AuditRecord) => Promise<void>;
}

export interface ToolDefinition<TInput = unknown> {
  readonly name: string;
  /** Shown to the model. Says what the tool does and when to reach for it. */
  readonly description: string;
  readonly schema: z.ZodType<TInput>;
  readonly jsonSchema: Record<string, unknown>;
  /** True for tools that change state — used by the loop's loop-detection. */
  readonly mutating: boolean;
  execute(input: TInput, runtime: ToolRuntime): Promise<ToolOutcome>;
}

/** A tool that has been type-erased for storage in the registry. */
export type AnyToolDefinition = ToolDefinition<never>;

/** Helper so each tool file can stay generic without casting at every call. */
export function defineTool<TInput>(definition: ToolDefinition<TInput>): AnyToolDefinition {
  return definition as unknown as AnyToolDefinition;
}
