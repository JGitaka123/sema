import type { ReminderKind } from "./config.js";

/**
 * Whether a due reminder may actually be sent.
 *
 * Pure and separate from the SQL on purpose: these are the rules that decide
 * whether a real patient's phone buzzes, and they should be readable and
 * testable without a database. Every "no" carries a machine reason, which is
 * what lands in `reminder.status = 'skipped'` and in the audit row.
 */

/** Appointment statuses a pre-visit reminder is still meaningful for. */
export const REMINDABLE_STATUSES = ["booked", "confirmed", "pending_deposit"] as const;

export type SkipReason =
  /** Cancelled, rescheduled away, already arrived, completed, or a no-show. */
  | "appointment_inactive"
  /** A rebook nudge for an appointment that is not (or no longer) a no-show. */
  | "appointment_not_no_show"
  /** `patient.flags.blocked` — the clinic does not want us messaging them. */
  | "patient_blocked"
  /** `patient_consent(service_messages).granted = false` (COMPLIANCE.md §3). */
  | "opted_out"
  /** The patient has never messaged this clinic, so there is nothing to reply on. */
  | "no_conversation"
  /** `conversation.mode = 'muted'` — abuse muting, or staff silencing the thread. */
  | "conversation_muted"
  /** Claimed before it was due. Defensive; the query should prevent it. */
  | "not_yet_due";

export type SendDecision = { action: "send" } | { action: "skip"; reason: SkipReason };

/** The facts the decision needs, all read inside one tenant transaction. */
export interface ReminderCandidate {
  readonly kind: ReminderKind;
  readonly dueAt: Date;
  readonly appointmentStatus: string;
  readonly patientBlocked: boolean;
  /**
   * The newest `patient_consent(kind = 'service_messages')` row, or `null` when
   * the patient has never been asked.
   *
   * `null` is treated as permitted: COMPLIANCE.md §3 keeps *service* messages
   * about a patient's own appointment allowed unless they opt out, and the
   * consent notice at first contact establishes that. Marketing is a separate
   * consent kind and Phase 7 never sends it.
   */
  readonly serviceMessagesGranted: boolean | null;
  readonly conversationId: string | null;
  readonly conversationMode: string | null;
}

export function decideReminderSend(candidate: ReminderCandidate, now: Date): SendDecision {
  if (candidate.dueAt.getTime() > now.getTime()) {
    return { action: "skip", reason: "not_yet_due" };
  }

  if (candidate.kind === "no_show_rebook") {
    if (candidate.appointmentStatus !== "no_show") {
      // The patient turned up late, or staff corrected the status. Nudging them
      // to rebook an appointment they attended is the worst kind of bot noise.
      return { action: "skip", reason: "appointment_not_no_show" };
    }
  } else if (!(REMINDABLE_STATUSES as readonly string[]).includes(candidate.appointmentStatus)) {
    return { action: "skip", reason: "appointment_inactive" };
  }

  if (candidate.patientBlocked) return { action: "skip", reason: "patient_blocked" };
  if (candidate.serviceMessagesGranted === false) return { action: "skip", reason: "opted_out" };
  if (!candidate.conversationId) return { action: "skip", reason: "no_conversation" };

  /**
   * `muted` is the only mode that stops a reminder. `human` means a staff
   * member has taken the thread over (hard rule 3) — that silences the *agent*,
   * and a reminder is not an agent turn: it is the clinic's own scheduled
   * notice, queued by `system`. Staff who want it stopped mute the thread.
   */
  if (candidate.conversationMode === "muted") {
    return { action: "skip", reason: "conversation_muted" };
  }

  return { action: "send" };
}
