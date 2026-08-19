import type { RouteDecision } from "./router.js";
import type { ClassifierResult } from "./types.js";

/**
 * PHI-free log projections.
 *
 * CLAUDE.md hard rule 4: "PHI never leaves the tenant boundary: no PHI in
 * logs, analytics, error tracking, or model training." The engine handles the
 * rawest PHI in the product — the message body — so it does not hand callers a
 * whole object and trust them to pick fields. These two functions are the only
 * shapes meant for pino, OpenTelemetry or Sentry, and `logging.test.ts` feeds
 * them messages stuffed with names, phone numbers and symptoms and asserts
 * none of it survives.
 */

export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export function classifierLogFields(result: ClassifierResult): LogFields {
  return {
    category: result.output.category,
    intent: result.output.intent,
    urgency: result.output.urgency,
    language: result.output.language,
    confidence: result.output.confidence,
    source: result.source,
    fallback_reason: result.fallbackReason ?? null,
    // Term *ids* ("chest_pain"), never the matched text.
    lexicon_terms: result.lexiconTerms.length === 0 ? null : result.lexiconTerms.join(","),
    latency_ms: result.latencyMs,
    prompt_version: result.promptVersion,
    model: result.model,
  };
}

export function routeLogFields(decision: RouteDecision): LogFields {
  return {
    route: decision.route,
    run_agent: decision.runAgent,
    // Counts and i18n keys only — a reply body is a patient-facing message and
    // an emergency script names the clinic, so bodies stay out of logs.
    reply_count: decision.replies.length,
    reply_keys: decision.replies.length === 0 ? null : decision.replies.map((r) => r.key).join(","),
    escalation_kind: decision.escalation?.kind ?? null,
    agent_addendum: decision.agentAddendum ?? null,
    action: decision.audit.action,
  };
}
