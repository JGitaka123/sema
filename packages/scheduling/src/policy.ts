import type { Clock } from "@sema/shared";

import { isClinicInitiated, type Actor } from "./types.js";

/**
 * Cancellation and reschedule policy — pure, clock-injected, no database.
 *
 * The policy lives on `clinic.cancellation_policy` as
 * `{free_reschedule_hours, forfeit_hours}` (DATA_MODEL.md). It is evaluated in
 * code rather than in SQL so that the outcome can be explained to a patient in
 * their own language, and so it can be unit-tested without Postgres.
 *
 * **This module decides; it never moves money** (CLAUDE.md hard rule 5). A
 * `forfeit` outcome records that the clinic may keep the deposit — the actual
 * refund, if any, is the clinic's own action on their M-Pesa.
 */

export interface CancellationPolicy {
  /** Free to move the appointment at least this many hours before it starts. */
  readonly freeRescheduleHours: number;
  /** Inside this many hours, the deposit may be kept. */
  readonly forfeitHours: number;
}

/** ADR-free defaults, matching the Afyanex seed and the DATA_MODEL sketch. */
export const DEFAULT_CANCELLATION_POLICY: CancellationPolicy = {
  freeRescheduleHours: 24,
  forfeitHours: 2,
};

function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Read `clinic.cancellation_policy` defensively.
 *
 * The column defaults to `{}` and is edited by staff in the inbox (Phase 8), so
 * a missing or nonsense value must fall back rather than throw in the middle of
 * a patient conversation. A `forfeit_hours` larger than
 * `free_reschedule_hours` is clamped: the free window can never be inside the
 * forfeit window.
 */
export function parseCancellationPolicy(raw: unknown): CancellationPolicy {
  const source = (raw ?? {}) as Record<string, unknown>;
  const free =
    positiveNumber(source["free_reschedule_hours"]) ??
    DEFAULT_CANCELLATION_POLICY.freeRescheduleHours;
  const forfeitRaw =
    positiveNumber(source["forfeit_hours"]) ?? DEFAULT_CANCELLATION_POLICY.forfeitHours;
  return { freeRescheduleHours: free, forfeitHours: Math.min(forfeitRaw, free) };
}

/**
 * `free`   — outside the free window, nothing owed.
 * `fee`    — late, but not last minute: the clinic's late fee may apply.
 * `forfeit`— inside the forfeit window: the clinic may keep the deposit.
 */
export type PolicyOutcome = "free" | "fee" | "forfeit";

export interface PolicyDecision {
  readonly outcome: PolicyOutcome;
  /** False when the change is not allowed at all — see the notes below. */
  readonly allowed: boolean;
  /** Negative once the appointment has started. */
  readonly hoursUntilStart: number;
  /** Whether the clinic may keep any deposit already paid. */
  readonly depositForfeited: boolean;
  readonly clinicInitiated: boolean;
  readonly policy: CancellationPolicy;
  /** Stable reason string, safe for `audit_log.reason`. */
  readonly reason: string;
}

export interface PolicyInput {
  readonly policy: CancellationPolicy;
  /** When the appointment starts. */
  readonly start: Date;
  readonly clock: Clock;
  readonly actor: Actor;
}

const HOUR_MS = 3_600_000;

function decide(input: PolicyInput, kind: "cancel" | "reschedule"): PolicyDecision {
  const { policy, start, clock, actor } = input;
  const hoursUntilStart = (start.getTime() - clock.now().getTime()) / HOUR_MS;
  const clinicInitiated = isClinicInitiated(actor);

  // The clinic moving its own appointment never costs the patient anything,
  // and staff must always be able to clean up a calendar — including one that
  // has already started.
  if (clinicInitiated) {
    return {
      outcome: "free",
      allowed: true,
      hoursUntilStart,
      depositForfeited: false,
      clinicInitiated,
      policy,
      reason: `${kind}.clinic_initiated`,
    };
  }

  // A patient cannot cancel or move an appointment that has already begun; it
  // is an arrival, a completion or a no-show by then (Phase 7 marks those).
  if (hoursUntilStart < 0) {
    return {
      outcome: "forfeit",
      allowed: false,
      hoursUntilStart,
      depositForfeited: true,
      clinicInitiated,
      policy,
      reason: `${kind}.already_started`,
    };
  }

  if (hoursUntilStart >= policy.freeRescheduleHours) {
    return {
      outcome: "free",
      allowed: true,
      hoursUntilStart,
      depositForfeited: false,
      clinicInitiated,
      policy,
      reason: `${kind}.free_window`,
    };
  }

  if (hoursUntilStart >= policy.forfeitHours) {
    return {
      outcome: "fee",
      allowed: true,
      hoursUntilStart,
      depositForfeited: false,
      clinicInitiated,
      policy,
      reason: `${kind}.late`,
    };
  }

  return {
    outcome: "forfeit",
    allowed: true,
    hoursUntilStart,
    depositForfeited: true,
    clinicInitiated,
    policy,
    reason: `${kind}.forfeit_window`,
  };
}

/** Evaluate moving an appointment. Allowed unless it has already started. */
export function evaluateReschedule(input: PolicyInput): PolicyDecision {
  return decide(input, "reschedule");
}

/** Evaluate cancelling an appointment. */
export function evaluateCancellation(input: PolicyInput): PolicyDecision {
  return decide(input, "cancel");
}

/** `cancelled_by_patient` / `cancelled_by_clinic` (DATA_MODEL.md enums). */
export function cancellationStatus(actor: Actor): "cancelled_by_patient" | "cancelled_by_clinic" {
  return isClinicInitiated(actor) ? "cancelled_by_clinic" : "cancelled_by_patient";
}
