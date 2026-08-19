import { fixedClock } from "@sema/shared";
import { describe, expect, it } from "vitest";

import { DEFAULT_REMINDER_CONFIG, type ReminderConfig } from "./config.js";
import { isNoShowDue, noShowDueAt, planPreVisitReminders, reminderDueAt } from "./plan.js";

/**
 * Time travel, with no database and no wall clock (BUILD_PLAN Phase 7:
 * "time-travel tests using fake clock").
 *
 * Every assertion here is about a boundary someone will one day be paged for:
 * a reminder an hour out because a clinic's clocks moved, a no-show marked
 * while the patient was still parking.
 */

const NAIROBI = "Africa/Nairobi";
/** The only market in v1 with a DST rule, used to prove the tz maths. */
const NEW_YORK = "America/New_York";

const HOUR = 60 * 60_000;

function config(overrides: Partial<ReminderConfig> = {}): ReminderConfig {
  return { ...DEFAULT_REMINDER_CONFIG, ...overrides };
}

describe("reminderDueAt", () => {
  it("is exact instant arithmetic where there is no DST", () => {
    // Monday 2026-08-17, 09:00 Africa/Nairobi (UTC+3, always).
    const start = new Date("2026-08-17T06:00:00Z");
    expect(reminderDueAt(start, NAIROBI, 24 * 60).toISOString()).toBe("2026-08-16T06:00:00.000Z");
    expect(reminderDueAt(start, NAIROBI, 120).toISOString()).toBe("2026-08-17T04:00:00.000Z");
  });

  it("keeps the clinic-local hour across a spring-forward, so the gap is 23h", () => {
    // 2026-03-08 is the second Sunday in March: clocks go 02:00 → 03:00.
    // A 10:00 EDT appointment reminded "a day before" must land at 10:00 EST,
    // which is 23 absolute hours earlier, not 24.
    const start = new Date("2026-03-08T14:00:00Z"); // 10:00 EDT
    const due = reminderDueAt(start, NEW_YORK, 24 * 60);
    expect(due.toISOString()).toBe("2026-03-07T15:00:00.000Z"); // 10:00 EST
    expect(start.getTime() - due.getTime()).toBe(23 * HOUR);
  });

  it("keeps the clinic-local hour across a fall-back, so the gap is 25h", () => {
    // 2026-11-01, clocks go 02:00 → 01:00.
    const start = new Date("2026-11-01T15:00:00Z"); // 10:00 EST
    const due = reminderDueAt(start, NEW_YORK, 24 * 60);
    expect(due.toISOString()).toBe("2026-10-31T14:00:00.000Z"); // 10:00 EDT
    expect(due.getTime()).toBeLessThan(start.getTime());
    expect(start.getTime() - due.getTime()).toBe(25 * HOUR);
  });

  it("leaves a 2-hour reminder unaffected by a transition it does not cross", () => {
    const start = new Date("2026-03-08T14:00:00Z");
    const due = reminderDueAt(start, NEW_YORK, 120);
    expect(start.getTime() - due.getTime()).toBe(2 * HOUR);
  });
});

describe("planPreVisitReminders", () => {
  const start = new Date("2026-08-17T06:00:00Z"); // Mon 09:00 Nairobi

  it("plans both reminders for an appointment a week out, soonest first", () => {
    const clock = fixedClock(new Date("2026-08-10T06:00:00Z"));
    const planned = planPreVisitReminders({
      start,
      timezone: NAIROBI,
      config: config(),
      now: clock.now(),
    });
    expect(planned.map((p) => p.kind)).toEqual(["pre_24h", "pre_2h"]);
    expect(planned[0]?.dueAt.toISOString()).toBe("2026-08-16T06:00:00.000Z");
    expect(planned[1]?.dueAt.toISOString()).toBe("2026-08-17T04:00:00.000Z");
  });

  it("drops a reminder whose moment has already passed", () => {
    // Booked three hours before the appointment: the "day before" nudge is
    // nonsense, the two-hour one still has an hour to run.
    const now = new Date("2026-08-17T03:00:00Z");
    const planned = planPreVisitReminders({ start, timezone: NAIROBI, config: config(), now });
    expect(planned.map((p) => p.kind)).toEqual(["pre_2h"]);
  });

  it("plans nothing for a booking made inside the last offset", () => {
    const now = new Date("2026-08-17T05:30:00Z"); // 30 min before
    expect(planPreVisitReminders({ start, timezone: NAIROBI, config: config(), now })).toEqual([]);
  });

  it("treats the exact due instant as already gone", () => {
    const now = new Date("2026-08-17T04:00:00.000Z"); // exactly start - 2h
    const planned = planPreVisitReminders({ start, timezone: NAIROBI, config: config(), now });
    expect(planned).toEqual([]);
  });

  it("honours a disabled offset", () => {
    const now = new Date("2026-08-10T06:00:00Z");
    const planned = planPreVisitReminders({
      start,
      timezone: NAIROBI,
      config: config({ offsetsMin: { pre_24h: 1440, pre_2h: null } }),
      now,
    });
    expect(planned.map((p) => p.kind)).toEqual(["pre_24h"]);
  });

  it("plans nothing at all when the clinic has reminders switched off", () => {
    const now = new Date("2026-08-10T06:00:00Z");
    expect(
      planPreVisitReminders({ start, timezone: NAIROBI, config: config({ enabled: false }), now }),
    ).toEqual([]);
  });

  it("uses a custom offset, e.g. a 90-minute nudge for a scan", () => {
    const now = new Date("2026-08-10T06:00:00Z");
    const planned = planPreVisitReminders({
      start,
      timezone: NAIROBI,
      config: config({ offsetsMin: { pre_24h: null, pre_2h: 90 } }),
      now,
    });
    expect(planned[0]?.dueAt.toISOString()).toBe("2026-08-17T04:30:00.000Z");
  });
});

describe("no-show boundary", () => {
  const start = new Date("2026-08-17T06:00:00Z");

  it("is not a no-show at 29 minutes", () => {
    expect(isNoShowDue(start, new Date(start.getTime() + 29 * 60_000), 30)).toBe(false);
  });

  it("is a no-show at exactly 30 minutes", () => {
    expect(isNoShowDue(start, new Date(start.getTime() + 30 * 60_000), 30)).toBe(true);
  });

  it("is a no-show at 31 minutes", () => {
    expect(isNoShowDue(start, new Date(start.getTime() + 31 * 60_000), 30)).toBe(true);
  });

  it("respects a clinic that allows a longer grace period", () => {
    const at45 = new Date(start.getTime() + 45 * 60_000);
    expect(isNoShowDue(start, at45, 60)).toBe(false);
    expect(isNoShowDue(start, at45, 30)).toBe(true);
  });

  it("computes the deadline as an absolute instant", () => {
    expect(noShowDueAt(start, 30).toISOString()).toBe("2026-08-17T06:30:00.000Z");
  });
});
