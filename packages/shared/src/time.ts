import { addMinutes, endOfDay, startOfDay } from "date-fns";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";

import { AppError } from "./errors.js";

/**
 * Time helpers.
 *
 * CLAUDE.md: "store UTC `timestamptz`. Clinic has `timezone`; render in clinic
 * tz. Slot math uses the clinic tz via `date-fns-tz`."
 *
 * The rule this module exists to enforce: a `Date` in Sema is *always* an
 * absolute instant (UTC). Timezones only appear when we format for a human or
 * when we interpret a wall-clock string a human typed. Nothing else should
 * import date-fns-tz directly.
 */

/** IANA timezone, e.g. "Africa/Nairobi". */
export type TimeZone = string;

export const DEFAULT_TIMEZONE: TimeZone = "Africa/Nairobi";

/** Injectable clock so scheduling and reminder tests can time-travel. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock frozen at `instant`, for tests and replayed fixtures. */
export function fixedClock(instant: Date): Clock {
  return { now: () => new Date(instant.getTime()) };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function assertTimeZone(tz: TimeZone): void {
  if (!isValidTimeZone(tz)) {
    throw new AppError("VALIDATION_FAILED", "Unknown timezone.", { meta: { timezone: tz } });
  }
}

/**
 * Interpret a wall-clock time in `tz` and return the absolute instant.
 * Use for anything a human typed: "Tue 09:30 at the clinic".
 */
export function zonedToUtc(wallClock: Date | string, tz: TimeZone): Date {
  assertTimeZone(tz);
  return fromZonedTime(wallClock, tz);
}

/**
 * Shift an instant into `tz` wall-clock fields. The returned Date's *fields*
 * (getHours() etc.) read as clinic-local — only ever use it for field access
 * or date-fns calendar maths, never persist it.
 */
export function utcToZoned(instant: Date, tz: TimeZone): Date {
  assertTimeZone(tz);
  return toZonedTime(instant, tz);
}

/** Format an instant in the clinic's timezone. */
export function formatInTz(instant: Date, tz: TimeZone, pattern: string): string {
  assertTimeZone(tz);
  return formatInTimeZone(instant, tz, pattern);
}

/** "Tue 12 Aug, 9:30 AM" — the shape used in patient confirmations. */
export function formatAppointmentTime(instant: Date, tz: TimeZone): string {
  return formatInTz(instant, tz, "EEE d MMM, h:mm a");
}

/** ISO-8601 with the clinic's offset, e.g. 2026-08-12T09:30:00+03:00. */
export function toIsoInTz(instant: Date, tz: TimeZone): string {
  return formatInTz(instant, tz, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

/** Calendar date in the clinic's timezone: "2026-08-12". */
export function toClinicDate(instant: Date, tz: TimeZone): string {
  return formatInTz(instant, tz, "yyyy-MM-dd");
}

/** The instant at which the clinic-local day containing `instant` begins. */
export function startOfDayInTz(instant: Date, tz: TimeZone): Date {
  return zonedToUtc(startOfDay(utcToZoned(instant, tz)), tz);
}

/** The instant at which the clinic-local day containing `instant` ends. */
export function endOfDayInTz(instant: Date, tz: TimeZone): Date {
  return zonedToUtc(endOfDay(utcToZoned(instant, tz)), tz);
}

/** Half-open interval [start, end). Slot maths is exclusive at the end. */
export interface Interval {
  readonly start: Date;
  readonly end: Date;
}

export function intervalOf(start: Date, durationMin: number): Interval {
  if (!Number.isFinite(durationMin) || durationMin <= 0) {
    throw new AppError("VALIDATION_FAILED", "Duration must be a positive number of minutes.");
  }
  return { start, end: addMinutes(start, durationMin) };
}

/** True when the two half-open intervals share any instant. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function minutesBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 60_000);
}
