/**
 * Model registry — the ONLY place in the repo where a model id may appear.
 *
 * CLAUDE.md §Tech stack: "`claude-haiku` class model for the safety/intent
 * classifier; `claude-sonnet` class model for the main conversation agent with
 * tool use. Model IDs live in `packages/engine/src/models.ts` only."
 *
 * A test in `models.test.ts` asserts nothing else in `src/` contains a
 * `claude-*` string, so a copy-pasted id fails the build rather than drifting.
 *
 * Changing a model id is a behaviour change: re-run `pnpm test:evals`
 * (SAFETY.md §9) before merging, because the emergency and advice suites are
 * measured against a specific model.
 */

export const MODELS = {
  /**
   * Safety + intent classifier. Pinned to a dated snapshot on purpose: this
   * call decides whether a patient in an emergency gets the emergency script,
   * so it must not silently change under us when an alias moves.
   *
   * Haiku class — CONVERSATION_ENGINE.md §2 requires p95 < 400ms.
   */
  classifier: "claude-haiku-4-5-20251001",

  /**
   * Main conversation agent (Phase 5). Declared here so Phase 5 has one place
   * to reach for; nothing in Phase 4 calls it.
   */
  agent: "claude-sonnet-5",
} as const;

export type ModelRole = keyof typeof MODELS;

/** Classifier budget. The output is one small JSON object. */
export const CLASSIFIER_MAX_TOKENS = 256;

/**
 * Agent budget. Replies are capped at 600 characters by the output rules
 * (CONVERSATION_ENGINE.md §3.1), but a turn may also emit tool calls whose
 * arguments carry ISO instants and ids, so the ceiling is generous relative to
 * the visible output.
 */
export const AGENT_MAX_TOKENS = 1024;

/**
 * Wall-clock deadline for one agent model call.
 *
 * TESTING.md §6 targets "reply p95 < 8s" end to end, and one inbound message
 * may make several of these calls plus tool round-trips, so no single call may
 * own the whole budget.
 */
export const AGENT_TIMEOUT_MS = 20_000;

/**
 * The guardrail's fast yes/no advice check (CONVERSATION_ENGINE.md §4.1) runs
 * on the classifier-class model and on a much tighter budget: it is a single
 * boolean about text we already have, and a slow one delays a reply that has
 * already been written.
 */
export const GUARDRAIL_MAX_TOKENS = 64;
export const GUARDRAIL_TIMEOUT_MS = 2_000;

/** Summary regeneration (CONVERSATION_ENGINE.md §8) runs off the hot path. */
export const SUMMARY_MAX_TOKENS = 512;
export const SUMMARY_TIMEOUT_MS = 10_000;

/**
 * CONVERSATION_ENGINE.md §2: "Timeout 1.5s → treat as `normal` with `low
 * confidence`". This is a hard wall-clock deadline on the whole call including
 * connect time; we never retry inside it (a retry would blow the budget and
 * the fail-safe path is safe by construction).
 */
export const CLASSIFIER_TIMEOUT_MS = 1500;

/**
 * Data-protection posture for every model call made by this package
 * (COMPLIANCE.md §2, CLAUDE.md hard rule 4).
 *
 * Zero data retention and no-training are **organisation-level** settings on
 * the Anthropic account, not per-request parameters — there is no request flag
 * that turns them on. What this package controls, and does:
 *
 *  1. sends the minimum context (last 3 messages + current + clinic specialty);
 *  2. never sends a patient's full name (COMPLIANCE.md §2 verbatim);
 *  3. scrubs phone-number-shaped digit runs before the text leaves the tenant
 *     boundary (`scrubIdentifiers`);
 *  4. attaches no `metadata.user_id` or any other tenant/patient identifier to
 *     the request, so nothing correlatable reaches the provider;
 *  5. disables SDK retries, so a timed-out prompt is not silently re-sent.
 *
 * The ODPC-facing claim lives in `legal/dpia.md`; this constant exists so the
 * code and the DPIA can be diffed against each other.
 */
export const MODEL_PRIVACY_POSTURE = {
  zeroRetention: true,
  noTraining: true,
  sendPatientNames: false,
  attachRequestMetadata: false,
  maxRetries: 0,
} as const;
