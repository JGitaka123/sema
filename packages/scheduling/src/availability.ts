import type { Interval, TimeZone } from "@sema/shared";

import {
  addDaysToKey,
  dateKeyInTz,
  eachDayKey,
  instantAt,
  normaliseLocalTime,
  weekdayOfKey,
} from "./calendar.js";
import type { ProviderId } from "./types.js";

/**
 * Turning `availability_rule` rows into concrete working windows.
 *
 * Pure: no database, no clock, no `Date.now()`. Everything here is unit-tested
 * against a DST timezone as well as Africa/Nairobi, because "Tuesdays 09:00"
 * is a wall-clock promise and only the conversion knows what that costs in
 * UTC on any given week (docs/ARCHITECTURE.md §4: "All computations in clinic
 * timezone, stored UTC").
 */

/** One row of `availability_rule`, as the repository reads it. */
export interface AvailabilityRule {
  readonly providerId: ProviderId;
  /** 0 = Sunday … 6 = Saturday. */
  readonly weekday: number;
  /** Clinic-local wall clock, `HH:MM[:SS]`. */
  readonly startLocal: string;
  readonly endLocal: string;
  /** Inclusive `YYYY-MM-DD` bounds; `null` means unbounded. */
  readonly validFrom?: string | null;
  readonly validTo?: string | null;
  readonly locationId?: string | null;
}

/** A concrete stretch of working time, in UTC. */
export interface AvailabilityWindow extends Interval {
  readonly providerId: ProviderId;
  readonly locationId: string | null;
}

function withinValidity(rule: AvailabilityRule, key: string): boolean {
  if (rule.validFrom && key < rule.validFrom) return false;
  if (rule.validTo && key > rule.validTo) return false;
  return true;
}

/**
 * Expand weekly rules into the windows that intersect `[from, to)`.
 *
 * The walk starts one calendar day early so an overnight rule (end ≤ start,
 * e.g. 20:00–02:00) that began yesterday is still seen today. Windows are not
 * clipped to the range: clipping would move the start of the slot grid, and
 * the grid must line up with the clinic's working hours, not with whenever a
 * patient happened to ask.
 */
export function expandAvailability(
  rules: readonly AvailabilityRule[],
  options: { timezone: TimeZone; from: Date; to: Date },
): AvailabilityWindow[] {
  const { timezone, from, to } = options;
  if (to <= from || rules.length === 0) return [];

  const firstKey = addDaysToKey(dateKeyInTz(from, timezone), -1);
  const lastKey = dateKeyInTz(to, timezone);

  const windows: AvailabilityWindow[] = [];
  for (const key of eachDayKey(firstKey, lastKey)) {
    const weekday = weekdayOfKey(key);
    for (const rule of rules) {
      if (rule.weekday !== weekday) continue;
      if (!withinValidity(rule, key)) continue;

      const startLocal = normaliseLocalTime(rule.startLocal);
      const endLocal = normaliseLocalTime(rule.endLocal);
      // A rule that ends at or before it starts is an overnight shift.
      const endKey = endLocal <= startLocal ? addDaysToKey(key, 1) : key;

      const start = instantAt(key, startLocal, timezone);
      const end = instantAt(endKey, endLocal, timezone);
      if (end <= start) continue;
      if (end <= from || start >= to) continue;

      windows.push({
        providerId: rule.providerId,
        locationId: rule.locationId ?? null,
        start,
        end,
      });
    }
  }

  windows.sort((a, b) => a.start.getTime() - b.start.getTime());
  return windows;
}
