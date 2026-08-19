import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Eval corpus loader, shared by the model-backed runner (`run.ts`) and the
 * key-free lexicon test (`src/safety/lexicon.test.ts`).
 *
 * The datasets are JSONL so that adding a case is a one-line diff that reviews
 * cleanly — SAFETY.md §3 requires an eval case for every lexicon term, and a
 * format where that is annoying is a format people work around.
 */

/** What the case is expected to be classified as. */
export type ExpectedCategory = "emergency" | "distress" | "normal" | "out_of_scope";

export interface EvalCase {
  readonly id: string;
  readonly lang: "en" | "sw" | "sheng";
  readonly text: string;
  readonly expect: ExpectedCategory;
  readonly tags: readonly string[];
}

/**
 * Advice-extraction attempts. `refuse` means "anything but `normal`": the
 * classifier's job is to keep the message away from the booking agent, and
 * either `out_of_scope` (the usual answer) or a safety category (for attempts
 * that describe something acute) achieves that. Whether the *reply* refuses
 * correctly is Phase 5's guardrail suite, not this one.
 */
export interface AdviceCase {
  readonly id: string;
  readonly lang: "en" | "sw" | "sheng";
  readonly text: string;
  readonly expect: "refuse";
  readonly tags: readonly string[];
}

function loadJsonl<T>(name: string): T[] {
  const path = fileURLToPath(new URL(`./datasets/${name}`, import.meta.url));
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as T);
}

export function loadEmergencyCases(): EvalCase[] {
  return loadJsonl<EvalCase>("emergency.jsonl");
}

export function loadAdviceCases(): AdviceCase[] {
  return loadJsonl<AdviceCase>("advice_refusal.jsonl");
}

/**
 * A question whose answer is deliberately **absent** from the clinic knowledge
 * (CONVERSATION_ENGINE.md §9: "questions where the fact is absent → 0 invented
 * prices/hours"). `absent` names what is missing, so a failure report says
 * which gap the agent filled in rather than just "it made something up".
 */
export interface GroundingCase {
  readonly id: string;
  readonly lang: "en" | "sw" | "sheng";
  readonly text: string;
  /** "defer" — say you will check, escalate `low_confidence`, invent nothing. */
  readonly expect: "defer";
  readonly absent: string;
  readonly tags: readonly string[];
}

/**
 * One multi-turn scenario. `turns` are the patient's messages in order; the
 * assertions in `expect` are applied to the whole run, not turn by turn, so a
 * flow that reaches the right end state by a slightly different route still
 * passes — what is being scored is the tool sequence and the policy path, not
 * the wording.
 */
export interface BookingFlowCase {
  readonly id: string;
  readonly name: string;
  readonly lang: string;
  readonly turns: readonly string[];
  readonly expect: BookingFlowExpectations;
  readonly tags: readonly string[];
}

export interface BookingFlowExpectations {
  /** Tools that must have been called at least once across the flow. */
  readonly must_call?: readonly string[];
  /** Tools that must never have been called. */
  readonly must_not_call?: readonly string[];
  /** These tools must appear in this relative order (other calls may interleave). */
  readonly in_order?: readonly string[];
  /** `{tool: n}` — at least n calls. */
  readonly min_calls?: Readonly<Record<string, number>>;
  /** `{tool: n}` — at most n calls. */
  readonly max_calls?: Readonly<Record<string, number>>;
  /** `{a: b}` — `a` must not be called before `b` has been. */
  readonly must_not_call_before?: Readonly<Record<string, string>>;
  /** The appointment status the flow should end in. */
  readonly final_status?: string;
  /** A deposit must (or must not) have been requested. */
  readonly deposit_requested?: boolean;
  /** Substrings the final reply must contain. */
  readonly require_text?: readonly string[];
  /** Substrings no reply may contain. */
  readonly forbid_text?: readonly string[];
  /** The escalation kind the flow should raise. */
  readonly escalation_kind?: string;
  /** Every guardrail check must pass on every reply. */
  readonly forbid_clinical_advice?: boolean;
  readonly forbid_invented_amounts?: boolean;
  readonly forbid_invented_slots?: boolean;
  readonly forbid_invented_providers?: boolean;
  readonly forbid_invented_appointments?: boolean;
  readonly forbid_other_patient_data?: boolean;
  readonly verbatim_from_knowledge?: boolean;
  readonly handles_expired_hold?: boolean;
  readonly policy_reported?: boolean;
  readonly offers_human?: boolean;
  readonly one_question_per_turn?: boolean;
  readonly final_service?: string;
  readonly reply_language?: string;
}

/** The reply's language must match the patient's (CONVERSATION_ENGINE.md §9). */
export interface LanguageCase {
  readonly id: string;
  readonly lang: "en" | "sw" | "sheng" | "mixed";
  readonly text: string;
  /** `en` | `sw` | `any` — Sheng scores as `sw` (see `replies.ts`). */
  readonly expect_language: "en" | "sw" | "any";
  readonly tags: readonly string[];
}

export function loadGroundingCases(): GroundingCase[] {
  return loadJsonl<GroundingCase>("grounding.jsonl");
}

export function loadBookingFlowCases(): BookingFlowCase[] {
  return loadJsonl<BookingFlowCase>("booking_flows.jsonl");
}

export function loadLanguageCases(): LanguageCase[] {
  return loadJsonl<LanguageCase>("language.jsonl");
}

/** Cases whose expected category is a stop-and-escalate safety route. */
export function isSafetyCase(c: EvalCase): boolean {
  return c.expect === "emergency" || c.expect === "distress";
}
