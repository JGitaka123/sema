import { describe, expect, it } from "vitest";

import { expandAvailability, type AvailabilityRule } from "./availability.js";
import { addDaysToKey, dateKeyInTz, endOfKey, instantAt, weekdayOfKey } from "./calendar.js";

const NAIROBI = "Africa/Nairobi";
/** Europe/London has DST; Africa/Nairobi does not. Both must work. */
const LONDON = "Europe/London";

const rule = (over: Partial<AvailabilityRule> = {}): AvailabilityRule => ({
  providerId: "prv_1",
  weekday: 1,
  startLocal: "09:00:00",
  endLocal: "17:00:00",
  ...over,
});

const hours = (from: Date, to: Date): number => (to.getTime() - from.getTime()) / 3_600_000;

describe("calendar keys", () => {
  it("steps days without touching a timezone", () => {
    expect(addDaysToKey("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDaysToKey("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDaysToKey("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("uses the same weekday numbering as availability_rule (0 = Sunday)", () => {
    expect(weekdayOfKey("2026-03-29")).toBe(0);
    expect(weekdayOfKey("2030-01-07")).toBe(1);
  });

  it("puts an instant on the clinic's calendar day, not UTC's", () => {
    // 22:30 UTC is already tomorrow in Nairobi (UTC+3).
    const instant = new Date("2026-08-12T22:30:00Z");
    expect(dateKeyInTz(instant, NAIROBI)).toBe("2026-08-13");
    expect(dateKeyInTz(instant, LONDON)).toBe("2026-08-12");
  });

  it("ends a DST day after 23 hours, not 24", () => {
    // 2026-03-29, Europe/London: 01:00 becomes 02:00.
    const start = instantAt("2026-03-29", "00:00", LONDON);
    expect(hours(start, endOfKey("2026-03-29", LONDON))).toBe(23);
    expect(hours(instantAt("2026-10-25", "00:00", LONDON), endOfKey("2026-10-25", LONDON))).toBe(
      25,
    );
    expect(hours(instantAt("2026-03-29", "00:00", NAIROBI), endOfKey("2026-03-29", NAIROBI))).toBe(
      24,
    );
  });
});

describe("expandAvailability", () => {
  it("emits one window per matching weekday in range", () => {
    // 2030-01-07 is a Monday.
    const windows = expandAvailability([rule()], {
      timezone: NAIROBI,
      from: new Date("2030-01-05T00:00:00Z"),
      to: new Date("2030-01-26T00:00:00Z"),
    });
    expect(windows).toHaveLength(3);
    for (const w of windows) expect(hours(w.start, w.end)).toBe(8);
    expect(windows[0]?.start.toISOString()).toBe("2030-01-07T06:00:00.000Z"); // 09:00 EAT
  });

  it("ignores rules for other weekdays and outside their validity dates", () => {
    const base = {
      timezone: NAIROBI,
      // Sunday 6th and Monday 7th only.
      from: new Date("2030-01-06T00:00:00Z"),
      to: new Date("2030-01-08T00:00:00Z"),
    };
    expect(expandAvailability([rule({ weekday: 3 })], base)).toHaveLength(0);
    expect(expandAvailability([rule({ validFrom: "2030-02-01" })], base)).toHaveLength(0);
    expect(expandAvailability([rule({ validTo: "2029-12-31" })], base)).toHaveLength(0);
    expect(expandAvailability([rule({ validFrom: "2030-01-07" })], base)).toHaveLength(1);
  });

  it("keeps wall-clock hours across a DST change, so UTC hours move", () => {
    // Sundays: 2026-03-22 (GMT) and 2026-03-29 (the spring-forward day).
    const windows = expandAvailability([rule({ weekday: 0 })], {
      timezone: LONDON,
      from: new Date("2026-03-20T00:00:00Z"),
      to: new Date("2026-03-31T00:00:00Z"),
    });
    expect(windows).toHaveLength(2);
    expect(windows[0]?.start.toISOString()).toBe("2026-03-22T09:00:00.000Z"); // GMT
    expect(windows[1]?.start.toISOString()).toBe("2026-03-29T08:00:00.000Z"); // BST
    for (const w of windows) expect(hours(w.start, w.end)).toBe(8);
  });

  it("loses an hour on the spring-forward day and gains one in autumn", () => {
    const overnight = rule({ weekday: 0, startLocal: "00:00", endLocal: "06:00" });
    const spring = expandAvailability([overnight], {
      timezone: LONDON,
      from: new Date("2026-03-29T00:00:00Z"),
      to: new Date("2026-03-30T00:00:00Z"),
    });
    expect(hours(spring[0]!.start, spring[0]!.end)).toBe(5);

    const autumn = expandAvailability([overnight], {
      timezone: LONDON,
      from: new Date("2026-10-24T12:00:00Z"),
      to: new Date("2026-10-26T00:00:00Z"),
    });
    expect(hours(autumn[0]!.start, autumn[0]!.end)).toBe(7);
  });

  it("treats end <= start as an overnight shift and still finds yesterday's", () => {
    const night = rule({ weekday: 1, startLocal: "20:00", endLocal: "02:00" });
    const windows = expandAvailability([night], {
      timezone: NAIROBI,
      // Tuesday morning only: the window began on Monday evening.
      from: new Date("2030-01-07T22:00:00Z"),
      to: new Date("2030-01-08T06:00:00Z"),
    });
    expect(windows).toHaveLength(1);
    expect(hours(windows[0]!.start, windows[0]!.end)).toBe(6);
    expect(windows[0]?.end.toISOString()).toBe("2030-01-07T23:00:00.000Z"); // 02:00 EAT Tue
  });

  it("returns nothing for an empty rule set or an inverted range", () => {
    const range = { timezone: NAIROBI, from: new Date("2030-01-05"), to: new Date("2030-01-12") };
    expect(expandAvailability([], range)).toEqual([]);
    expect(expandAvailability([rule()], { ...range, from: range.to, to: range.from })).toEqual([]);
  });
});
