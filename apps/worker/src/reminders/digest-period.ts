import { formatInTz, utcToZoned, zonedToUtc, type TimeZone } from "@sema/shared";
import { addDays, startOfDay, startOfWeek, subWeeks } from "date-fns";

/**
 * The windows a digest reports on.
 *
 * Pure, and the reason it is its own file: a digest that reports on the wrong
 * seven days is worse than no digest, and "wrong" here means one hour of
 * timezone drift. Every boundary is computed in the clinic's timezone and
 * returned as absolute instants, so the SQL can compare against `timestamptz`
 * without a single `at time zone` in a WHERE clause.
 *
 * Both windows are half-open `[from, to)`, matching every other interval in
 * Sema (`packages/shared/src/time.ts`).
 */

export interface DigestWindow {
  readonly from: Date;
  readonly to: Date;
  /** Stable, human-readable, and the digest's idempotency key. */
  readonly periodKey: string;
  readonly timezone: TimeZone;
}

/** The clinic-local day containing `now`: what the morning digest lists. */
export function morningDigestWindow(now: Date, timezone: TimeZone): DigestWindow {
  const localMidnight = startOfDay(utcToZoned(now, timezone));
  const from = zonedToUtc(localMidnight, timezone);
  const to = zonedToUtc(addDays(localMidnight, 1), timezone);
  return { from, to, periodKey: formatInTz(from, timezone, "yyyy-MM-dd"), timezone };
}

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The last **complete** clinic-local week before `now`.
 *
 * Complete is the point. A Monday-morning digest that included Monday itself
 * would report on a few hours of the current week and make every
 * week-over-week comparison a lie.
 */
export function weeklyDigestWindow(
  now: Date,
  timezone: TimeZone,
  weekStartsOn: Weekday = 1,
): DigestWindow {
  const currentWeekStart = startOfWeek(utcToZoned(now, timezone), { weekStartsOn });
  const previousWeekStart = subWeeks(currentWeekStart, 1);
  const from = zonedToUtc(previousWeekStart, timezone);
  const to = zonedToUtc(currentWeekStart, timezone);
  // The local date the week starts on. Sortable, unambiguous, and it survives
  // a clinic changing which weekday its week begins on — an ISO week number
  // would silently mean something different afterwards.
  return { from, to, periodKey: formatInTz(from, timezone, "yyyy-MM-dd"), timezone };
}

/**
 * Clinic-local hour (0–23) and weekday (0 = Sunday … 6 = Saturday, matching
 * `availability_rule`), for deciding whether a digest is due right now.
 *
 * Read off the shifted `Date`'s own fields rather than formatted and parsed
 * back: `utcToZoned` exists precisely so field access reads as clinic-local.
 */
export function localHour(now: Date, timezone: TimeZone): number {
  return utcToZoned(now, timezone).getHours();
}

export function localWeekday(now: Date, timezone: TimeZone): Weekday {
  return utcToZoned(now, timezone).getDay() as Weekday;
}
