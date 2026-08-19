import {
  abuseWarningReply,
  consentNoticeReply,
  distressReply,
  emergencyReply,
  handoverReply,
  outOfScopeReply,
  resolveReplyLanguage,
  type ClinicScriptConfig,
  type ScriptedReply,
} from "./replies.js";
import type { ClassifierResult, EscalationKind } from "./types.js";

/**
 * The router (CONVERSATION_ENGINE.md §1).
 *
 * ```
 * emergency      → scripted emergency reply + escalate(emergency) + STOP
 * distress       → empathetic scripted reply + escalate(distress) + STOP
 * abusive/spam   → scripted or silence + flag; STOP
 * out_of_scope   → scripted redirect (no advice) + offer booking/human; STOP
 * normal         → AGENT
 * ```
 *
 * A **pure function**: classification + clinic config + conversation counters
 * in, a decision object out. It performs no I/O, so the whole decision table is
 * unit-testable without a database, and Phase 5 can execute the decision
 * (write to `outbox`, create the escalation, update counters) transactionally
 * without the safety logic being tangled up in that transaction.
 */

export type Route =
  | "emergency"
  | "distress"
  | "abusive"
  | "spam"
  | "out_of_scope"
  | "agent"
  /** Agent deliberately says nothing: human takeover, mute, or spam. */
  | "silent";

export type NotifyChannel = "inbox" | "emergency_contact";

export interface ConversationState {
  /** `conversation.mode`. `human` means a staff member has taken over. */
  readonly mode: "agent" | "human" | "muted";
  /** Abusive messages counted *before* this one (SAFETY.md §7: three strikes). */
  readonly abusiveStrikes: number;
  /** Consecutive out-of-scope redirects already sent (SAFETY.md §5: "insists twice"). */
  readonly outOfScopeStreak: number;
  /** True for the very first inbound message from this patient (COMPLIANCE.md §1). */
  readonly isFirstContact: boolean;
  /** Set while an abuse mute is in force. */
  readonly agentMutedUntil?: Date | null;
  /** Whether the clinic is open now — picks the holding message (SAFETY.md §6). */
  readonly inHours?: boolean;
}

export interface RouterInput {
  readonly classification: ClassifierResult;
  readonly clinic: ClinicScriptConfig;
  readonly conversation: ConversationState;
  readonly now: Date;
}

export interface EscalationRequest {
  readonly kind: EscalationKind;
  /** PHI-free. Goes into `escalation.reason` and the audit row. */
  readonly reason: string;
  /** Emergencies pin the conversation to the top of the inbox (SAFETY.md §3). */
  readonly pinConversation: boolean;
  readonly notify: readonly NotifyChannel[];
}

export interface ConversationUpdates {
  readonly mode?: "muted";
  readonly mutedUntil?: Date;
  readonly abusiveStrikes?: number;
  readonly outOfScopeStreak?: number;
  readonly pinned?: boolean;
}

export interface RouteDecision {
  readonly route: Route;
  /** Hard rule 1/2: only ever true for `agent`. */
  readonly runAgent: boolean;
  readonly replies: readonly ScriptedReply[];
  readonly escalation?: EscalationRequest;
  readonly conversationUpdates: ConversationUpdates;
  /**
   * Phase 5 seam. When set, the agent's system prompt gets the conservative
   * addendum (CONVERSATION_ENGINE.md §2: a low-confidence classification means
   * "agent runs with a conservative system prompt addendum").
   */
  readonly agentAddendum?: "conservative";
  readonly audit: AuditEntry;
}

export interface AuditEntry {
  readonly action: string;
  /** PHI-free by construction — ids, counts, enums only (hard rule 4 + 7). */
  readonly meta: Readonly<Record<string, string | number | boolean | null>>;
}

/** Below this the router treats the classification as unreliable. */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

/** SAFETY.md §7: "Three abusive messages → mute agent for 24h". */
export const ABUSE_STRIKE_LIMIT = 3;
export const ABUSE_MUTE_MS = 24 * 60 * 60 * 1000;

/** SAFETY.md §5: "if the patient insists twice, escalate `out_of_scope`". */
export const OUT_OF_SCOPE_ESCALATE_AT = 2;

function auditMeta(input: RouterInput, extra: AuditEntry["meta"] = {}): AuditEntry["meta"] {
  const { output, source, latencyMs, promptVersion, lexiconTerms, fallbackReason } =
    input.classification;
  return {
    category: output.category,
    intent: output.intent,
    urgency: output.urgency,
    language: output.language,
    confidence: output.confidence,
    classifier_source: source,
    classifier_latency_ms: latencyMs,
    prompt_version: promptVersion,
    lexicon_terms: lexiconTerms.length === 0 ? null : lexiconTerms.join(","),
    fallback_reason: fallbackReason ?? null,
    ...extra,
  };
}

/**
 * Whether an abuse mute is still in force.
 * `mode === "muted"` is the persisted flag; `agentMutedUntil` is the clock.
 */
function isMuted(conversation: ConversationState, now: Date): boolean {
  if (conversation.agentMutedUntil instanceof Date) {
    return conversation.agentMutedUntil.getTime() > now.getTime();
  }
  return conversation.mode === "muted";
}

/**
 * COMPLIANCE.md §1/§6 — the AI disclosure at first contact.
 *
 * On a safety route it goes *after* the safety script: the first thing someone
 * describing an emergency reads must be "call 999", not a privacy notice.
 * Everywhere else it goes first, because it is the opening of the
 * conversation.
 */
function withConsentNotice(
  input: RouterInput,
  replies: readonly ScriptedReply[],
  lang: ReturnType<typeof resolveReplyLanguage>,
  position: "before" | "after",
): readonly ScriptedReply[] {
  if (!input.conversation.isFirstContact) return replies;
  const notice = consentNoticeReply(input.clinic, lang);
  return position === "before" ? [notice, ...replies] : [...replies, notice];
}

export function route(input: RouterInput): RouteDecision {
  const { classification, clinic, conversation, now } = input;
  const category = classification.output.category;
  const lang = resolveReplyLanguage(classification.output.language, clinic.defaultLanguage);
  const isSafety = category === "emergency" || category === "distress";

  // ---------------------------------------------------------------- takeover
  // Hard rule 3: "A human can take over any conversation at any time, and the
  // agent stays silent until handed back." The agent sends nothing — but an
  // emergency still raises the alarm, because a staff member who opened the
  // thread an hour ago is not the same thing as a staff member watching it now.
  if (conversation.mode === "human") {
    return {
      route: isSafety ? category : "silent",
      runAgent: false,
      replies: [],
      ...(isSafety ? { escalation: safetyEscalation(category) } : {}),
      conversationUpdates: isSafety ? { pinned: true } : {},
      audit: {
        action: isSafety ? `route.${category}.human_mode` : "route.silent.human_mode",
        meta: auditMeta(input, { suppressed_replies: true }),
      },
    };
  }

  // -------------------------------------------------------------------- mute
  // An abuse mute silences the agent for 24h — but it must not silence a
  // safety script. Someone who swore at the desk three times can still have a
  // heart attack an hour later (SAFETY.md §7 mutes the *agent*, not the alarm).
  if (isMuted(conversation, now) && !isSafety) {
    return {
      route: "silent",
      runAgent: false,
      replies: [],
      conversationUpdates: {},
      audit: { action: "route.silent.muted", meta: auditMeta(input) },
    };
  }

  switch (category) {
    // ------------------------------------------------------------- emergency
    case "emergency":
      return {
        route: "emergency",
        runAgent: false,
        replies: withConsentNotice(input, [emergencyReply(clinic, lang)], lang, "after"),
        escalation: safetyEscalation("emergency"),
        conversationUpdates: { pinned: true, outOfScopeStreak: 0 },
        audit: { action: "route.emergency", meta: auditMeta(input) },
      };

    // -------------------------------------------------------------- distress
    case "distress":
      return {
        route: "distress",
        runAgent: false,
        replies: withConsentNotice(input, [distressReply(clinic, lang)], lang, "after"),
        escalation: safetyEscalation("distress"),
        conversationUpdates: { pinned: true, outOfScopeStreak: 0 },
        audit: { action: "route.distress", meta: auditMeta(input) },
      };

    // --------------------------------------------------------------- abusive
    case "abusive": {
      const strikes = conversation.abusiveStrikes + 1;
      const muted = strikes >= ABUSE_STRIKE_LIMIT;

      if (!muted) {
        return {
          route: "abusive",
          runAgent: false,
          replies: withConsentNotice(input, [abuseWarningReply(clinic, lang)], lang, "before"),
          conversationUpdates: { abusiveStrikes: strikes, outOfScopeStreak: 0 },
          audit: { action: "route.abusive.warned", meta: auditMeta(input, { strikes }) },
        };
      }

      // Third strike: stop replying entirely, mute for 24h, hand to staff.
      // Silence is the de-escalation — another scripted line is another thing
      // to argue with.
      return {
        route: "abusive",
        runAgent: false,
        replies: [],
        escalation: {
          kind: "abusive",
          reason: `abuse_strike_limit_reached:${strikes}`,
          pinConversation: false,
          notify: ["inbox"],
        },
        conversationUpdates: {
          abusiveStrikes: strikes,
          outOfScopeStreak: 0,
          mode: "muted",
          mutedUntil: new Date(now.getTime() + ABUSE_MUTE_MS),
        },
        audit: {
          action: "route.abusive.muted",
          meta: auditMeta(input, { strikes, mute_ms: ABUSE_MUTE_MS }),
        },
      };
    }

    // ------------------------------------------------------------------ spam
    // No reply at all: answering a bulk forward trains the sender and burns a
    // 24-hour session window for nothing.
    case "spam":
      return {
        route: "spam",
        runAgent: false,
        replies: [],
        conversationUpdates: { outOfScopeStreak: 0 },
        audit: { action: "route.spam", meta: auditMeta(input) },
      };

    // ---------------------------------------------------------- out_of_scope
    case "out_of_scope": {
      const streak = conversation.outOfScopeStreak + 1;
      const escalate = streak >= OUT_OF_SCOPE_ESCALATE_AT;
      const inHours = input.conversation.inHours ?? true;

      const replies: ScriptedReply[] = [outOfScopeReply(clinic, lang)];
      if (escalate) {
        // SAFETY.md §6: the agent must send a holding message when escalating.
        replies.push(handoverReply(clinic, lang, inHours));
      }

      return {
        route: "out_of_scope",
        runAgent: false,
        replies: withConsentNotice(input, replies, lang, "before"),
        ...(escalate
          ? {
              escalation: {
                kind: "out_of_scope" as const,
                reason: `advice_requested_repeatedly:${streak}`,
                pinConversation: false,
                notify: ["inbox" as const],
              },
            }
          : {}),
        conversationUpdates: { outOfScopeStreak: streak },
        audit: {
          action: escalate ? "route.out_of_scope.escalated" : "route.out_of_scope",
          meta: auditMeta(input, { streak }),
        },
      };
    }

    // ---------------------------------------------------------------- normal
    case "normal": {
      // The agent itself is Phase 5. The router's job ends at "this is safe to
      // hand over, and here is how carefully to hold it".
      const lowConfidence =
        classification.output.confidence < LOW_CONFIDENCE_THRESHOLD ||
        classification.source === "fallback";

      return {
        route: "agent",
        runAgent: true,
        replies: withConsentNotice(input, [], lang, "before"),
        conversationUpdates: { outOfScopeStreak: 0 },
        ...(lowConfidence ? { agentAddendum: "conservative" as const } : {}),
        audit: {
          action: lowConfidence ? "route.agent.low_confidence" : "route.agent",
          meta: auditMeta(input, { low_confidence: lowConfidence }),
        },
      };
    }

    default: {
      // Exhaustiveness guard. If a new category is added to the enum without a
      // branch here, this fails the build rather than silently reaching the
      // agent — which is the one outcome a safety router must never have.
      const exhaustive: never = category;
      throw new Error(`Unhandled classifier category: ${String(exhaustive)}`);
    }
  }
}

function safetyEscalation(kind: "emergency" | "distress"): EscalationRequest {
  return {
    kind,
    reason: kind === "emergency" ? "safety_emergency" : "safety_distress",
    pinConversation: true,
    // Both wake a human immediately: SAFETY.md §3 alerts the emergency contact
    // and on-duty staff; §4 requires distress to "escalate to a human
    // immediately", which the inbox alone does not guarantee out of hours.
    notify: ["inbox", "emergency_contact"],
  };
}
