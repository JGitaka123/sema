import { z } from "zod";

/**
 * The classifier vocabulary, verbatim from docs/CONVERSATION_ENGINE.md §2.
 *
 * These enums are mirrored by the `classifier_category` Postgres enum in
 * `packages/db` — adding a value here without a migration will store a string
 * the database cannot represent, so keep the two in step.
 */

export const CLASSIFIER_CATEGORIES = [
  "normal",
  "emergency",
  "distress",
  "out_of_scope",
  "abusive",
  "spam",
] as const;
export type ClassifierCategory = (typeof CLASSIFIER_CATEGORIES)[number];

export const CLASSIFIER_LANGUAGES = ["en", "sw", "sheng", "mixed", "other"] as const;
export type ClassifierLanguage = (typeof CLASSIFIER_LANGUAGES)[number];

export const CLASSIFIER_INTENTS = [
  "book",
  "reschedule",
  "cancel",
  "hours",
  "location",
  "price",
  "insurance",
  "provider_info",
  "prep",
  "payment",
  "complaint",
  "human",
  "greeting",
  "thanks",
  "other",
] as const;
export type ClassifierIntent = (typeof CLASSIFIER_INTENTS)[number];

export const CLASSIFIER_URGENCIES = ["none", "low", "high"] as const;
export type ClassifierUrgency = (typeof CLASSIFIER_URGENCIES)[number];

/**
 * The model's structured output. Every field is required: a partial object is
 * treated as malformed and fails safe (see `classifier.ts`), because a missing
 * `category` must never be read as "normal".
 */
export const classifierOutputSchema = z
  .object({
    category: z.enum(CLASSIFIER_CATEGORIES),
    language: z.enum(CLASSIFIER_LANGUAGES),
    intent: z.enum(CLASSIFIER_INTENTS),
    urgency: z.enum(CLASSIFIER_URGENCIES),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type ClassifierOutput = z.infer<typeof classifierOutputSchema>;

/**
 * Escalation kinds, mirroring the `escalation_kind` Postgres enum.
 *
 * Duplicated here rather than imported from `@sema/db` so the router stays a
 * pure module with no database dependency. `escalation.test.ts` asserts the two
 * lists are identical, so the duplication cannot drift.
 */
export const ESCALATION_KINDS = [
  "emergency",
  "distress",
  "complaint",
  "payment_issue",
  "low_confidence",
  "patient_requested",
  "abusive",
  "out_of_scope",
  "agent_error",
] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];

/** Where a classification came from. Audited; drives alerting on fallbacks. */
export const CLASSIFIER_SOURCES = [
  /** Deterministic regex lexicon hit — the model was never called. */
  "lexicon",
  /** Model returned well-formed structured output. */
  "model",
  /** Identical recent input, served from the in-process cache. */
  "cache",
  /** Timeout, transport error, refusal or malformed output — fail-safe result. */
  "fallback",
] as const;
export type ClassifierSource = (typeof CLASSIFIER_SOURCES)[number];

/** Why a fail-safe result was produced. `undefined` when `source !== "fallback"`. */
export const CLASSIFIER_FALLBACK_REASONS = [
  "timeout",
  "transport_error",
  "malformed_output",
  "empty_output",
  "refusal",
] as const;
export type ClassifierFallbackReason = (typeof CLASSIFIER_FALLBACK_REASONS)[number];

/**
 * What `classify()` hands to the router.
 *
 * Deliberately contains no message text: this object is what gets stamped on
 * `escalation.classifier_output` and logged, and hard rule 4 says no PHI in
 * logs. `lexiconTerms` holds term *ids* ("chest_pain"), never the matched text.
 */
export interface ClassifierResult {
  readonly output: ClassifierOutput;
  readonly source: ClassifierSource;
  readonly fallbackReason?: ClassifierFallbackReason;
  /** Term ids from the deterministic lexicon. PHI-free by construction. */
  readonly lexiconTerms: readonly string[];
  /** Wall-clock time spent inside `classify()`, for the p95 < 400ms target. */
  readonly latencyMs: number;
  /** Stamped on `message.meta.prompt_version` (CONVERSATION_ENGINE.md §10). */
  readonly promptVersion: string;
  /** Model id used, or `null` when the lexicon or fallback answered. */
  readonly model: string | null;
}
