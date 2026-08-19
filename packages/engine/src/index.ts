/**
 * `@sema/engine` — the conversation engine (docs/CONVERSATION_ENGINE.md).
 *
 * Phase 4 ships the first half of the pipeline: the safety lexicon, the
 * classifier, the router and the scripted safety replies. The agent, its
 * tools and the guardrail post-check are Phase 5 and are deliberately absent —
 * the seams they attach to are `RouteDecision.runAgent` and
 * `RouteDecision.agentAddendum`.
 *
 * ## Wiring it in (Phase 5's job, not this package's)
 *
 * ```ts
 * const classification = await classify(
 *   { message: body, recent, clinicSpecialty, clinicId },
 *   { client, cache },
 * );
 * const decision = route({ classification, clinic, conversation, now });
 *
 * await recordRouteAudit({ clinicId, conversationId, entry: decision.audit }, deps);
 * if (decision.escalation) {
 *   await recordEscalation(
 *     { clinicId, conversationId, request: decision.escalation, classification },
 *     deps,
 *   );
 * }
 * for (const reply of decision.replies) enqueueOutbox(reply);   // never send directly
 * if (decision.runAgent) await runAgent(...);                   // Phase 5
 * ```
 *
 * Two rules the caller cannot opt out of: `classify` runs on **every** inbound
 * message before any other model call (hard rule 1), and the agent runs only
 * when `decision.runAgent` is true.
 */

export * from "./cache.js";
export * from "./classifier.js";
export * from "./client.js";
export * from "./escalation.js";
export * from "./language.js";
export * from "./logging.js";
export * from "./models.js";
export * from "./notifier.js";
export * from "./replies.js";
export * from "./router.js";
export * from "./safety/index.js";
export * from "./types.js";
export { PROMPT_VERSION, classifierSystemPrompt } from "./prompts/index.js";
