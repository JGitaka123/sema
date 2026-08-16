import { describe, expect, it } from "vitest";

import {
  DEFAULT_TIMEZONE,
  fixedClock,
  formatAppointmentTime,
  intervalOf,
  isValidTimeZone,
  minutesBetween,
  overlaps,
  startOfDayInTz,
  toClinicDate,
  utcToZoned,
  zonedToUtc,
} from "./time.js";

describe("timezone conversion", () => {
  it("interprets a clinic wall-clock time as UTC (+03:00 in Nairobi)", () => {
    const instant = zonedToUtc("2026-08-12T09:30:00", DEFAULT_TIMEZONE);
    expect(instant.toISOString()).toBe("2026-08-12T06:30:00.000Z");
  });

  it("renders a UTC instant in clinic time", () => {
    const instant = new Date("2026-08-12T06:30:00.000Z");
    expect(formatAppointmentTime(instant, DEFAULT_TIMEZONE)).toBe("Wed 12 Aug, 9:30 AM");
  });

  it("round-trips wall clock through UTC", () => {
    const wall = "2026-08-12T09:30:00";
    const instant = zonedToUtc(wall, DEFAULT_TIMEZONE);
    const back = utcToZoned(instant, DEFAULT_TIMEZONE);
    expect(back.getHours()).toBe(9);
    expect(back.getMinutes()).toBe(30);
  });

  it("gives the clinic-local calendar date, not the UTC one", () => {
    // 22:00 UTC is already the next day in Nairobi.
    const instant = new Date("2026-08-12T22:00:00.000Z");
    expect(toClinicDate(instant, DEFAULT_TIMEZONE)).toBe("2026-08-13");
  });

  it("handles a DST timezone correctly, for later Western markets", () => {
    // London is UTC+1 in August.
    expect(zonedToUtc("2026-08-12T09:30:00", "Europe/London").toISOString()).toBe(
      "2026-08-12T08:30:00.000Z",
    );
    // ...and UTC+0 in January.
    expect(zonedToUtc("2026-01-12T09:30:00", "Europe/London").toISOString()).toBe(
      "2026-01-12T09:30:00.000Z",
    );
  });

  it("computes the start of the clinic's day", () => {
    const instant = new Date("2026-08-12T14:00:00.000Z");
    expect(startOfDayInTz(instant, DEFAULT_TIMEZONE).toISOString()).toBe(
      "2026-08-11T21:00:00.000Z",
    );
  });

  it("rejects unknown timezones", () => {
    expect(isValidTimeZone("Africa/Nairobi")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(() => zonedToUtc("2026-08-12T09:30:00", "Mars/Olympus")).toThrowError();
  });
});

describe("intervals", () => {
  it("builds a half-open interval from a duration", () => {
    const start = new Date("2026-08-12T06:30:00.000Z");
    expect(intervalOf(start, 30).end.toISOString()).toBe("2026-08-12T07:00:00.000Z");
  });

  it("rejects non-positive durations", () => {
    expect(() => intervalOf(new Date(), 0)).toThrowError();
    expect(() => intervalOf(new Date(), -15)).toThrowError();
  });

  it("treats back-to-back appointments as non-overlapping", () => {
    const first = intervalOf(new Date("2026-08-12T06:00:00.000Z"), 30);
    const second = intervalOf(new Date("2026-08-12T06:30:00.000Z"), 30);
    expect(overlaps(first, second)).toBe(false);
  });

  it("detects a real overlap in both directions", () => {
    const first = intervalOf(new Date("2026-08-12T06:00:00.000Z"), 30);
    const overlapping = intervalOf(new Date("2026-08-12T06:15:00.000Z"), 30);
    expect(overlaps(first, overlapping)).toBe(true);
    expect(overlaps(overlapping, first)).toBe(true);
  });

  it("measures minutes between instants", () => {
    expect(minutesBetween(new Date("2026-08-12T06:00:00Z"), new Date("2026-08-12T06:45:00Z"))).toBe(
      45,
    );
  });
});

describe("fixedClock", () => {
  it("freezes now() for time-travel tests", () => {
    const clock = fixedClock(new Date("2026-08-12T06:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2026-08-12T06:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-08-12T06:00:00.000Z");
  });

  it("hands out copies so callers cannot mutate the frozen instant", () => {
    const clock = fixedClock(new Date("2026-08-12T06:00:00.000Z"));
    clock.now().setFullYear(1999);
    expect(clock.now().getFullYear()).toBe(2026);
  });
});
