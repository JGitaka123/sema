import { describe, expect, it } from "vitest";

import { decideReminderSend, type ReminderCandidate } from "./decide.js";

/**
 * The rules that decide whether a real patient's phone buzzes.
 *
 * COMPLIANCE.md §3 is the binding half of this file: templates need opt-in, a
 * STOP means stop. The rest is not wanting to be the bot that reminds someone
 * about an appointment they cancelled yesterday.
 */

const NOW = new Date("2026-08-17T04:00:00Z");

function candidate(overrides: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    kind: "pre_24h",
    dueAt: new Date("2026-08-17T03:59:00Z"),
    appointmentStatus: "confirmed",
    patientBlocked: false,
    serviceMessagesGranted: null,
    conversationId: "conv_01J000000000000000000000",
    conversationMode: "agent",
    ...overrides,
  };
}

describe("decideReminderSend", () => {
  it("sends for a confirmed appointment", () => {
    expect(decideReminderSend(candidate(), NOW)).toEqual({ action: "send" });
  });

  it("sends for booked and pending_deposit too — the slot is still held", () => {
    for (const status of ["booked", "pending_deposit"]) {
      expect(decideReminderSend(candidate({ appointmentStatus: status }), NOW).action).toBe("send");
    }
  });

  it.each([
    "cancelled_by_patient",
    "cancelled_by_clinic",
    "rescheduled",
    "no_show",
    "completed",
    "arrived",
    "held",
  ])("skips a pre-visit reminder for a %s appointment", (status) => {
    expect(decideReminderSend(candidate({ appointmentStatus: status }), NOW)).toEqual({
      action: "skip",
      reason: "appointment_inactive",
    });
  });

  it("skips a blocked patient", () => {
    expect(decideReminderSend(candidate({ patientBlocked: true }), NOW)).toEqual({
      action: "skip",
      reason: "patient_blocked",
    });
  });

  it("skips a patient who replied STOP (COMPLIANCE.md §3)", () => {
    expect(decideReminderSend(candidate({ serviceMessagesGranted: false }), NOW)).toEqual({
      action: "skip",
      reason: "opted_out",
    });
  });

  it("sends when consent was never explicitly recorded", () => {
    // Service messages about the patient's own appointment stay permitted; the
    // first-contact notice is the opt-in. Only an explicit `false` stops us.
    expect(decideReminderSend(candidate({ serviceMessagesGranted: null }), NOW).action).toBe(
      "send",
    );
    expect(decideReminderSend(candidate({ serviceMessagesGranted: true }), NOW).action).toBe(
      "send",
    );
  });

  it("skips when there is no conversation to reply on", () => {
    expect(decideReminderSend(candidate({ conversationId: null }), NOW)).toEqual({
      action: "skip",
      reason: "no_conversation",
    });
  });

  it("skips a muted conversation", () => {
    expect(decideReminderSend(candidate({ conversationMode: "muted" }), NOW)).toEqual({
      action: "skip",
      reason: "conversation_muted",
    });
  });

  it("still sends when staff have taken the thread over", () => {
    // Hard rule 3 silences the *agent*. A reminder is the clinic's own
    // scheduled notice, queued by `system`.
    expect(decideReminderSend(candidate({ conversationMode: "human" }), NOW).action).toBe("send");
  });

  it("refuses to send early", () => {
    expect(decideReminderSend(candidate({ dueAt: new Date("2026-08-17T04:00:01Z") }), NOW)).toEqual(
      { action: "skip", reason: "not_yet_due" },
    );
  });

  describe("rebook nudge", () => {
    const nudge = (overrides: Partial<ReminderCandidate> = {}): ReminderCandidate =>
      candidate({ kind: "no_show_rebook", appointmentStatus: "no_show", ...overrides });

    it("sends only for an appointment that is actually a no-show", () => {
      expect(decideReminderSend(nudge(), NOW).action).toBe("send");
    });

    it.each(["confirmed", "arrived", "completed", "cancelled_by_patient"])(
      "skips once the appointment has become %s",
      (status) => {
        // Staff corrected the status, or the patient walked in very late.
        expect(decideReminderSend(nudge({ appointmentStatus: status }), NOW)).toEqual({
          action: "skip",
          reason: "appointment_not_no_show",
        });
      },
    );

    it("still respects the opt-out", () => {
      expect(decideReminderSend(nudge({ serviceMessagesGranted: false }), NOW)).toEqual({
        action: "skip",
        reason: "opted_out",
      });
    });
  });
});
