import { addMinutes } from "date-fns";
import { overlaps, utcToZoned, type Interval, type TimeZone } from "@sema/shared";

import { addDaysToKey, dateKeyInTz, endOfKey } from "./calendar.js";
import { assertPositiveInt } from "./errors.js";
import type { AvailabilityWindow } from "./availability.js";
import type { BusyInterval, Slot } from "./types.js";

/**
 * Slot generation — the pure heart of `searchSlots`.
 *
 * No database and no ambient clock: `now` is passed in, so every rule below
 * (min notice, booking window, DST) is a unit test rather than a hope.
 */

export interface SlotGenerationConfig {
  readonly timezone: TimeZone;
  /** Search range, half open. */
  readonly from: Date;
  readonly to: Date;
  /** "Now" from the injected `Clock`. */
  readonly now: Date;
  readonly durationMin: number;
  readonly bufferMin: number;
  readonly granularityMin: number;
  readonly minNoticeMin: number;
  readonly bookingWindowDays: number;
}

/**
 * The last instant a patient may book into: the end of the clinic-local day
 * `booking_window_days` after today. Expressed in calendar days rather than
 * milliseconds so "30 days out" means the same thing through a DST change.
 */
export function bookingHorizon(config: {
  now: Date;
  timezone: TimeZone;
  bookingWindowDays: number;
}): Date {
  const todayKey = dateKeyInTz(config.now, config.timezone);
  const lastKey = addDaysToKey(todayKey, Math.max(0, config.bookingWindowDays));
  return endOfKey(lastKey, config.timezone);
}

/**
 * Round `instant` up to the next point on the clinic-local slot grid.
 *
 * The grid is anchored to clinic-local midnight, not to UTC: with a 15-minute
 * granularity a patient expects 09:00, 09:15, 09:30 on the clinic's clock, and
 * a zone at a half-hour offset (or a DST shift) would break a UTC-anchored
 * grid.
 */
export function alignToGrid(instant: Date, timezone: TimeZone, granularityMin: number): Date {
  assertPositiveInt(granularityMin, "slot_granularity_min");
  const local = utcToZoned(instant, timezone);
  // Zone offsets are whole minutes, so the sub-minute part is zone-independent.
  const subMinuteMs = local.getSeconds() * 1_000 + local.getMilliseconds();
  const truncated = new Date(instant.getTime() - subMinuteMs);

  const minutesOfDay = local.getHours() * 60 + local.getMinutes();
  const remainder = minutesOfDay % granularityMin;
  const delta =
    remainder === 0 ? (subMinuteMs === 0 ? 0 : granularityMin) : granularityMin - remainder;
  return delta === 0 ? truncated : addMinutes(truncated, delta);
}

/**
 * Is `block` occupied for `providerId`?
 *
 * A busy interval with a `null` provider is a clinic-wide closure and blocks
 * everyone.
 *
 * Exported because the write path has to ask this question on its own:
 * `holdSlot` must tell "the clinic would never offer this time" (the caller
 * sent something wrong) apart from "this time is offerable but taken" (the
 * caller lost a race). Collapsing those into one error code is what made a
 * losing racer look like a malformed request.
 */
export function isBlocked(
  busy: readonly BusyInterval[],
  providerId: string,
  block: Interval,
): boolean {
  return busy.some(
    (b) => (b.providerId === null || b.providerId === providerId) && overlaps(b, block),
  );
}

/**
 * Generate every bookable slot inside `windows`.
 *
 * Rules applied, in the order a receptionist would apply them:
 *  1. the appointment itself must finish inside the working window (the
 *     turnaround buffer may run past closing — it is cleanup, not care);
 *  2. it must start no earlier than `min_notice_min` from now, and no earlier
 *     than the requested `from`;
 *  3. it must start inside `booking_window_days` and before `to`;
 *  4. the whole occupied block — appointment *plus* buffer — must be free of
 *     appointments, unexpired holds and time off.
 */
export function generateSlots(input: {
  windows: readonly AvailabilityWindow[];
  busy: readonly BusyInterval[];
  config: SlotGenerationConfig;
}): Slot[] {
  const { windows, busy, config } = input;
  assertPositiveInt(config.durationMin, "duration_min");
  assertPositiveInt(config.granularityMin, "slot_granularity_min");
  if (config.bufferMin < 0 || !Number.isInteger(config.bufferMin)) {
    throw new Error("buffer_min must be a non-negative whole number");
  }

  const earliest = new Date(
    Math.max(config.from.getTime(), addMinutes(config.now, config.minNoticeMin).getTime()),
  );
  const horizon = bookingHorizon(config);
  const limit = new Date(Math.min(config.to.getTime(), horizon.getTime()));
  if (limit <= earliest) return [];

  const slots: Slot[] = [];
  for (const window of windows) {
    let start = alignToGrid(window.start, config.timezone, config.granularityMin);
    // Stepping in absolute minutes (not wall-clock minutes) is what makes a
    // 25-hour day produce 25 hours of slots: an appointment is a duration.
    for (; start < limit; start = addMinutes(start, config.granularityMin)) {
      const end = addMinutes(start, config.durationMin);
      if (end > window.end) break;
      if (start < earliest) continue;

      const blockEnd = addMinutes(end, config.bufferMin);
      if (isBlocked(busy, window.providerId, { start, end: blockEnd })) continue;

      slots.push({
        providerId: window.providerId,
        locationId: window.locationId,
        start,
        end,
        blockEnd,
      });
    }
  }

  return slots;
}
