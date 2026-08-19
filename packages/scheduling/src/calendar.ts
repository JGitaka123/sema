import { AppError, toClinicDate, zonedToUtc, type TimeZone } from "@sema/shared";

/**
 * Calendar-date arithmetic that never touches a timezone.
 *
 * "The day after 2026-03-29" is a question about the calendar, not about
 * instants: doing it by adding 86 400 000 ms to a `Date` is exactly how DST
 * bugs get in. Every day-stepping loop in this package walks `DateKey` strings
 * and only converts to an instant at the last moment, through `date-fns-tz`.
 */

/** A clinic-local calendar date, `YYYY-MM-DD`. */
export type DateKey = string;

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Postgres `time` renders as `HH:MM:SS`; accept `HH:MM`, and tolerate — then
 * drop — a fractional part, which the column type allows even though no clinic
 * opens at 09:00:00.5.
 */
const LOCAL_TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

function assertDateKey(key: string): void {
  if (!DATE_KEY_RE.test(key)) {
    throw new AppError("VALIDATION_FAILED", "Expected a YYYY-MM-DD calendar date.");
  }
}

/** Midnight UTC on `key` — an anchor for calendar maths, never a real instant. */
function anchor(key: DateKey): Date {
  assertDateKey(key);
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function keyOf(anchored: Date): DateKey {
  return anchored.toISOString().slice(0, 10);
}

export function addDaysToKey(key: DateKey, days: number): DateKey {
  const next = anchor(key);
  next.setUTCDate(next.getUTCDate() + days);
  return keyOf(next);
}

/** 0 = Sunday … 6 = Saturday, matching `availability_rule.weekday`. */
export function weekdayOfKey(key: DateKey): number {
  return anchor(key).getUTCDay();
}

/** The clinic-local calendar date `instant` falls on. */
export function dateKeyInTz(instant: Date, tz: TimeZone): DateKey {
  return toClinicDate(instant, tz);
}

/** Normalise a Postgres `time` to `HH:MM:SS` so string comparison is safe. */
export function normaliseLocalTime(value: string): string {
  const match = LOCAL_TIME_RE.exec(value.trim());
  if (!match) {
    throw new AppError("VALIDATION_FAILED", "Expected a local time of the form HH:MM[:SS].");
  }
  const [, hh, mm, ss] = match as unknown as [string, string, string, string | undefined];
  return `${hh}:${mm}:${ss ?? "00"}`;
}

/**
 * The absolute instant of a clinic-local wall clock.
 *
 * This is the only place a local date and a local time become a `Date`, and it
 * is DST-correct by construction: `date-fns-tz` resolves the offset that
 * actually applied on that date in that zone.
 */
export function instantAt(key: DateKey, localTime: string, tz: TimeZone): Date {
  assertDateKey(key);
  return zonedToUtc(`${key}T${normaliseLocalTime(localTime)}`, tz);
}

/** The instant the clinic-local day `key` begins. */
export function startOfKey(key: DateKey, tz: TimeZone): Date {
  return instantAt(key, "00:00:00", tz);
}

/**
 * The instant the clinic-local day `key` ends (exclusive) — i.e. the start of
 * the next day, which is also correct on a day that is 23 or 25 hours long.
 */
export function endOfKey(key: DateKey, tz: TimeZone): Date {
  return startOfKey(addDaysToKey(key, 1), tz);
}

/** Inclusive `[fromKey, toKey]` walk. Guarded so a bad range cannot spin. */
export function* eachDayKey(fromKey: DateKey, toKey: DateKey, maxDays = 400): Generator<DateKey> {
  assertDateKey(fromKey);
  assertDateKey(toKey);
  let key = fromKey;
  for (let i = 0; key <= toKey; i += 1) {
    if (i >= maxDays) {
      throw new AppError("VALIDATION_FAILED", "Date range is too long to expand.", {
        meta: { maxDays },
      });
    }
    yield key;
    key = addDaysToKey(key, 1);
  }
}
