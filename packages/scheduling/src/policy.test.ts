import { fixedClock } from "@sema/shared";
import { describe, expect, it } from "vitest";

import {
  cancellationStatus,
  DEFAULT_CANCELLATION_POLICY,
  evaluateCancellation,
  evaluateReschedule,
  parseCancellationPolicy,
} from "./policy.js";
import type { Actor } from "./types.js";

const NOW = new Date("2026-08-16T09:00:00Z");
const clock = fixedClock(NOW);
const inHours = (h: number): Date => new Date(NOW.getTime() + h * 3_600_000);

const PATIENT: Actor = { kind: "patient" };
const AGENT: Actor = { kind: "agent" };
const STAFF: Actor = { kind: "staff", staffUserId: "usr_1" };
const SYSTEM: Actor = { kind: "system" };

const policy = parseCancellationPolicy({ free_reschedule_hours: 24, forfeit_hours: 2 });

describe("parseCancellationPolicy", () => {
  it("falls back to the documented defaults for an empty or broken value", () => {
    expect(parseCancellationPolicy({})).toEqual(DEFAULT_CANCELLATION_POLICY);
    expect(parseCancellationPolicy(null)).toEqual(DEFAULT_CANCELLATION_POLICY);
    expect(parseCancellationPolicy({ free_reschedule_hours: "nope" })).toEqual(
      DEFAULT_CANCELLATION_POLICY,
    );
    expect(parseCancellationPolicy({ free_reschedule_hours: -3 })).toEqual(
      DEFAULT_CANCELLATION_POLICY,
    );
  });

  it("accepts numeric strings, because jsonb edited by hand often has them", () => {
    expect(parseCancellationPolicy({ free_reschedule_hours: "48", forfeit_hours: "4" })).toEqual({
      freeRescheduleHours: 48,
      forfeitHours: 4,
    });
  });

  it("never lets the forfeit window swallow the free window", () => {
    expect(parseCancellationPolicy({ free_reschedule_hours: 4, forfeit_hours: 12 })).toEqual({
      freeRescheduleHours: 4,
      forfeitHours: 4,
    });
  });

  it("supports a zero-hour policy: everything is free", () => {
    const lenient = parseCancellationPolicy({ free_reschedule_hours: 0, forfeit_hours: 0 });
    expect(
      evaluateCancellation({ policy: lenient, start: inHours(0.1), clock, actor: PATIENT }).outcome,
    ).toBe("free");
  });
});

describe("evaluateCancellation", () => {
  const decide = (hours: number, actor: Actor = PATIENT) =>
    evaluateCancellation({ policy, start: inHours(hours), clock, actor });

  it("is free outside the free-reschedule window", () => {
    const d = decide(48);
    expect(d).toMatchObject({ outcome: "free", allowed: true, depositForfeited: false });
    expect(d.hoursUntilStart).toBe(48);
  });

  it("is exactly free on the boundary", () => {
    expect(decide(24).outcome).toBe("free");
    expect(decide(23.9).outcome).toBe("fee");
  });

  it("charges a fee inside the free window but outside the forfeit window", () => {
    expect(decide(6)).toMatchObject({ outcome: "fee", allowed: true, depositForfeited: false });
  });

  it("forfeits the deposit inside the forfeit window", () => {
    expect(decide(2).outcome).toBe("fee");
    expect(decide(1.9)).toMatchObject({
      outcome: "forfeit",
      depositForfeited: true,
      allowed: true,
    });
  });

  it("refuses once the appointment has started", () => {
    expect(decide(-0.5)).toMatchObject({ allowed: false, outcome: "forfeit" });
  });

  it("treats the agent as the patient — it acts on the patient's behalf", () => {
    expect(decide(1, AGENT)).toMatchObject({ depositForfeited: true, clinicInitiated: false });
  });

  it("never penalises the patient when the clinic cancels, even late", () => {
    for (const actor of [STAFF, SYSTEM]) {
      expect(decide(0.25, actor)).toMatchObject({
        outcome: "free",
        allowed: true,
        depositForfeited: false,
        clinicInitiated: true,
      });
    }
    // Staff must be able to clean up a calendar that has already moved on.
    expect(decide(-3, STAFF).allowed).toBe(true);
  });
});

describe("evaluateReschedule", () => {
  it("mirrors cancellation but labels its reasons for the audit trail", () => {
    const late = evaluateReschedule({ policy, start: inHours(1), clock, actor: PATIENT });
    expect(late.outcome).toBe("forfeit");
    expect(late.allowed).toBe(true);
    expect(late.reason).toBe("reschedule.forfeit_window");

    const free = evaluateReschedule({ policy, start: inHours(30), clock, actor: PATIENT });
    expect(free.reason).toBe("reschedule.free_window");
  });

  it("blocks a patient moving an appointment that has begun", () => {
    expect(evaluateReschedule({ policy, start: inHours(-1), clock, actor: PATIENT })).toMatchObject(
      { allowed: false, reason: "reschedule.already_started" },
    );
  });
});

describe("cancellationStatus", () => {
  it("records who cancelled", () => {
    expect(cancellationStatus(PATIENT)).toBe("cancelled_by_patient");
    expect(cancellationStatus(AGENT)).toBe("cancelled_by_patient");
    expect(cancellationStatus(STAFF)).toBe("cancelled_by_clinic");
    expect(cancellationStatus(SYSTEM)).toBe("cancelled_by_clinic");
  });
});
