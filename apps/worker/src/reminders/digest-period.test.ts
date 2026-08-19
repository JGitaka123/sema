import { describe, expect, it } from "vitest";

import {
  localHour,
  localWeekday,
  morningDigestWindow,
  weeklyDigestWindow,
} from "./digest-period.js";

/**
 * A digest that reports on the wrong days is worse than no digest, and "wrong"
 * here means a few hours of timezone drift. These are the boundaries.
 */

const NAIROBI = "Africa/Nairobi"; // UTC+3, no DST
const NEW_YORK = "America/New_York";

describe("morningDigestWindow", () => {
  it("covers the clinic-local day, not the UTC day", () => {
    // 07:00 Nairobi on Monday 2026-08-17 is 04:00 UTC.
    const window = morningDigestWindow(new Date("2026-08-17T04:00:00Z"), NAIROBI);
    expect(window.from.toISOString()).toBe("2026-08-16T21:00:00.000Z");
    expect(window.to.toISOString()).toBe("2026-08-17T21:00:00.000Z");
    expect(window.periodKey).toBe("2026-08-17");
  });

  it("still reports Monday for an instant that is already Tuesday in UTC", () => {
    // 23:30 Nairobi Monday = 20:30 UTC Monday; but 02:00 Tuesday Nairobi is
    // 23:00 Monday UTC, which is the case that catches naive UTC maths.
    const window = morningDigestWindow(new Date("2026-08-17T23:00:00Z"), NAIROBI);
    expect(window.periodKey).toBe("2026-08-18");
  });

  it("is exactly 24 hours long on an ordinary day", () => {
    const window = morningDigestWindow(new Date("2026-08-17T04:00:00Z"), NEW_YORK);
    expect(window.to.getTime() - window.from.getTime()).toBe(24 * 60 * 60_000);
  });

  it("is 23 hours long on a spring-forward day", () => {
    // 2026-03-08 in America/New_York loses an hour.
    const window = morningDigestWindow(new Date("2026-03-08T15:00:00Z"), NEW_YORK);
    expect(window.periodKey).toBe("2026-03-08");
    expect(window.to.getTime() - window.from.getTime()).toBe(23 * 60 * 60_000);
  });
});

describe("weeklyDigestWindow", () => {
  it("reports the last complete week, never the current one", () => {
    // Monday 2026-08-17, 08:00 Nairobi.
    const window = weeklyDigestWindow(new Date("2026-08-17T05:00:00Z"), NAIROBI, 1);
    // Monday 2026-08-10 00:00 Nairobi → 2026-08-09T21:00Z
    expect(window.from.toISOString()).toBe("2026-08-09T21:00:00.000Z");
    // Monday 2026-08-17 00:00 Nairobi → 2026-08-16T21:00Z
    expect(window.to.toISOString()).toBe("2026-08-16T21:00:00.000Z");
    expect(window.periodKey).toBe("2026-08-10");
  });

  it("is seven days long", () => {
    const window = weeklyDigestWindow(new Date("2026-08-17T05:00:00Z"), NAIROBI, 1);
    expect(window.to.getTime() - window.from.getTime()).toBe(7 * 24 * 60 * 60_000);
  });

  it("gives the same window for every instant inside the sending day", () => {
    const monday = weeklyDigestWindow(new Date("2026-08-17T05:00:00Z"), NAIROBI, 1);
    const laterThatWeek = weeklyDigestWindow(new Date("2026-08-20T11:00:00Z"), NAIROBI, 1);
    expect(laterThatWeek.periodKey).toBe(monday.periodKey);
  });

  it("moves on the following week", () => {
    const next = weeklyDigestWindow(new Date("2026-08-24T05:00:00Z"), NAIROBI, 1);
    expect(next.periodKey).toBe("2026-08-17");
  });

  it("follows a clinic whose week starts on Sunday", () => {
    const window = weeklyDigestWindow(new Date("2026-08-17T05:00:00Z"), NAIROBI, 0);
    expect(window.periodKey).toBe("2026-08-09");
  });

  it("excludes the sending day itself — the boundary is exclusive", () => {
    const window = weeklyDigestWindow(new Date("2026-08-17T05:00:00Z"), NAIROBI, 1);
    // 2026-08-16T21:00Z is Monday 00:00 Nairobi: the first instant of the week
    // being reported *on*, and therefore not part of the week reported.
    expect(window.to.toISOString()).toBe("2026-08-16T21:00:00.000Z");
  });
});

describe("localHour / localWeekday", () => {
  it("reads the clinic's clock, not the server's", () => {
    const instant = new Date("2026-08-17T04:00:00Z");
    expect(localHour(instant, NAIROBI)).toBe(7);
    expect(localHour(instant, "UTC")).toBe(4);
    expect(localHour(instant, NEW_YORK)).toBe(0);
  });

  it("reads the clinic's calendar day", () => {
    // 23:30 UTC Sunday is already Monday 02:30 in Nairobi.
    const instant = new Date("2026-08-16T23:30:00Z");
    expect(localWeekday(instant, "UTC")).toBe(0); // Sunday
    expect(localWeekday(instant, NAIROBI)).toBe(1); // Monday
  });
});
