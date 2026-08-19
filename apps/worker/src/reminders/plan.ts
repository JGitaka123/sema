import { utcToZoned, zonedToUtc, type TimeZone } from "@sema/shared";
import { subMinutes } from "date-fns";

import { PRE_VISIT_KINDS, type PreVisitKind, type ReminderConfig } from "./config.js";

/**
 * When a reminder is due, and when an appointment has become a no-show.
 *
 * Pure: every function takes the instant it should treat as "now", so the whole
 * module is driven by an injected `Clock` in production and by a fixed one in
 * tests (BUILD_PLAN Phase 7: "time-travel tests using fake clock").
 */

export interface PlannedReminder {
  readonly kind: PreVisitKind;
  readonly dueAt: Date;
}

/**
 * The instant `offsetMin` before `start`, **computed in the clinic timezone**.
 *
 * For Africa/Nairobi (no DST, the launch market) this is identical to plain
 * instant arithmetic. It stops being identical the moment Sema reaches a
 * market that changes its clocks, and the clinic-local reading is the one a
 * human means: a "day before" reminder for a 09:00 appointment should arrive at
 * 09:00 the previous day, not at 08:00 because the clocks went forward in
 * between. CLAUDE.md — "Slot math uses the clinic tz via `date-fns-tz`."
 */
export function reminderDueAt(start: Date, timezone: TimeZone, offsetMin: number): Date {
  return zonedToUtc(subMinutes(utcToZoned(start, timezone), offsetMin), timezone);
}

export interface PlanInput {
  readonly start: Date;
  readonly timezone: TimeZone;
  readonly config: ReminderConfig;
  readonly now: Date;
}

/**
 * The pre-visit reminders an appointment should have, soonest first.
 *
 * A reminder whose moment has already passed is **not** planned. Booking an
 * appointment three hours out must not fire an immediate "your appointment is
 * tomorrow" message; the patient just spoke to us, and a late reminder reads as
 * a system that does not know what day it is.
 */
export function planPreVisitReminders(input: PlanInput): PlannedReminder[] {
  if (!input.config.enabled) return [];

  const planned: PlannedReminder[] = [];
  for (const kind of PRE_VISIT_KINDS) {
    const offsetMin = input.config.offsetsMin[kind];
    if (offsetMin === null) continue;
    const dueAt = reminderDueAt(input.start, input.timezone, offsetMin);
    if (dueAt.getTime() <= input.now.getTime()) continue;
    planned.push({ kind, dueAt });
  }
  return planned.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

// ── No-show ──────────────────────────────────────────────────────────────────

/** SPEC §4.4: "30 min after slot start with no `arrived`". */
export function noShowDueAt(start: Date, afterMin: number): Date {
  return new Date(start.getTime() + afterMin * 60_000);
}

/**
 * Whether the grace period has elapsed.
 *
 * Inclusive at the boundary: at exactly `start + afterMin` the window is over.
 * The sweep runs on a timer, so the only observable effect of the choice is
 * which side of the boundary the tests pin — but leaving it undecided is how a
 * flake gets in.
 */
export function isNoShowDue(start: Date, now: Date, afterMin: number): boolean {
  return now.getTime() >= noShowDueAt(start, afterMin).getTime();
}

/**
 * How far back a no-show sweep looks.
 *
 * Without a floor, the first run after a deployment (or after an outage) would
 * mark every stale `booked` row in the clinic's history as a no-show and send
 * each of those patients a rebook nudge. Two days is long enough to survive a
 * weekend of worker downtime and short enough that nobody gets messaged about
 * an appointment they have forgotten.
 */
export const NO_SHOW_LOOKBACK_HOURS = 48;

/**
 * How far ahead the reminder reconciler looks for appointments.
 *
 * It has to be comfortably more than the largest offset it might schedule
 * (24 h by default) so a reminder row exists well before it is due.
 */
export const REMINDER_SYNC_HORIZON_HOURS = 72;
