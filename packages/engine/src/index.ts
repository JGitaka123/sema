/**
 * `@sema/engine` — the conversation engine (docs/CONVERSATION_ENGINE.md).
 *
 * The whole pipeline now lives here: the safety lexicon and classifier
 * (Phase 4), then the router, the agent with its tools, and the guardrail
 * post-check (Phase 5).
 *
 * ## Wiring it in
 *
 * ```ts
 * const classification = await classify(
 *   { message: body, recent, clinicSpecialty, clinicId },
 *   { client, cache },
 * );
 * const decision = route({ classification, clinic, conversation, now });
 *
 * await recordRouteAudit({ clinicId, conversationId, entry: decision.audit }, deps);
 * if (decision.escalation) await recordEscalation(…, deps);
 * for (const reply of decision.replies) enqueueOutbound(reply);   // never send directly
 *
 * if (decision.runAgent) {
 *   const context = await loadAgentContext({ withTenantDb }, ids);
 *   const run = await runAgent({ …ids, message, context, patientLanguage }, agentDeps);
 *   for (const reply of run.replies) enqueueOutbound(reply);
 *   if (run.escalation) await recordEscalation(…);
 * }
 * ```
 *
 * Three rules the caller cannot opt out of: `classify` runs on **every**
 * inbound message before any other model call (hard rule 1); the agent runs
 * only when `decision.runAgent` is true; and every reply the agent produces has
 * already been through `checkReply` — `runAgent` never returns unchecked text.
 */

export * from "./agent.js";
export * from "./cache.js";
export * from "./classifier.js";
export * from "./client.js";
export * from "./context.js";
export * from "./escalation.js";
export * from "./guardrails.js";
export * from "./language.js";
export * from "./logging.js";
export * from "./models.js";
export * from "./notifier.js";
export * from "./replies.js";
export * from "./router.js";
export * from "./safety/index.js";
export * from "./summaries.js";
export * from "./tools/index.js";
export * from "./types.js";
export {
  AGENT_PROMPT_VERSION,
  GUARDRAIL_PROMPT_VERSION,
  PROMPT_VERSION,
  SUMMARY_PROMPT_VERSION,
  classifierSystemPrompt,
} from "./prompts/index.js";
