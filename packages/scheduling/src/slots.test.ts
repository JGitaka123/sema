import { describe, expect, it } from "vitest";

import type { AvailabilityWindow } from "./availability.js";
import { alignToGrid, bookingHorizon, generateSlots, type SlotGenerationConfig } from "./slots.js";
import type { BusyInterval } from "./types.js";

const NAIROBI = "Africa/Nairobi";
const LONDON = "Europe/London";
const PROVIDER = "prv_1";

const at = (iso: string): Date => new Date(iso);

/** Monday 2030-01-07, 09:00–12:00 Nairobi (06:00–09:00 UTC). */
const morning: AvailabilityWindow = {
  providerId: PROVIDER,
  locationId: "loc_1",
  start: at("2030-01-07T06:00:00Z"),
  end: at("2030-01-07T09:00:00Z"),
};

const config = (over: Partial<SlotGenerationConfig> = {}): SlotGenerationConfig => ({
  timezone: NAIROBI,
  from: at("2030-01-07T00:00:00Z"),
  to: at("2030-01-08T00:00:00Z"),
  now: at("2030-01-06T12:00:00Z"),
  durationMin: 20,
  bufferMin: 0,
  granularityMin: 15,
  minNoticeMin: 60,
  bookingWindowDays: 30,
  ...over,
});

/** Small wrapper so the tests read as data, not as plumbing. */
function run(
  over: Partial<SlotGenerationConfig> = {},
  busy: BusyInterval[] = [],
  windows: AvailabilityWindow[] = [morning],
): string[] {
  return generateSlots({ windows, busy, config: config(over) }).map((s) => s.start.toISOString());
}

describe("alignToGrid", () => {
  it("rounds up to the clinic-local grid, and leaves grid points alone", () => {
    expect(alignToGrid(at("2030-01-07T06:00:00Z"), NAIROBI, 15).toISOString()).toBe(
      "2030-01-07T06:00:00.000Z",
    );
    expect(alignToGrid(at("2030-01-07T06:01:00Z"), NAIROBI, 15).toISOString()).toBe(
      "2030-01-07T06:15:00.000Z",
    );
    expect(alignToGrid(at("2030-01-07T06:00:30Z"), NAIROBI, 15).toISOString()).toBe(
      "2030-01-07T06:15:00.000Z",
    );
  });

  it("anchors the grid to clinic-local midnight, not to UTC", () => {
    // Kathmandu is UTC+05:45: a UTC-anchored grid would be 45 minutes out.
    const aligned = alignToGrid(at("2030-01-07T00:00:00Z"), "Asia/Kathmandu", 30);
    expect(aligned.toISOString()).toBe("2030-01-07T00:15:00.000Z"); // 06:00 local
  });
});

describe("bookingHorizon", () => {
  it("is the end of the clinic-local day N days out", () => {
    expect(
      bookingHorizon({
        now: at("2030-01-07T06:00:00Z"),
        timezone: NAIROBI,
        bookingWindowDays: 0,
      }).toISOString(),
    ).toBe("2030-01-07T21:00:00.000Z"); // midnight EAT
    expect(
      bookingHorizon({
        now: at("2030-01-07T06:00:00Z"),
        timezone: NAIROBI,
        bookingWindowDays: 2,
      }).toISOString(),
    ).toBe("2030-01-09T21:00:00.000Z");
  });
});

describe("generateSlots", () => {
  it("steps by the clinic's granularity and never runs past closing", () => {
    expect(run({ durationMin: 60, granularityMin: 30 })).toEqual([
      "2030-01-07T06:00:00.000Z",
      "2030-01-07T06:30:00.000Z",
      "2030-01-07T07:00:00.000Z",
      "2030-01-07T07:30:00.000Z",
      "2030-01-07T08:00:00.000Z",
    ]);
  });

  it("stops when the appointment itself no longer fits the window", () => {
    const short: AvailabilityWindow = { ...morning, end: at("2030-01-07T07:00:00Z") };
    expect(run({ durationMin: 20, granularityMin: 15 }, [], [short])).toEqual([
      "2030-01-07T06:00:00.000Z",
      "2030-01-07T06:15:00.000Z",
      "2030-01-07T06:30:00.000Z",
    ]);
  });

  it("lets the turnaround buffer run past closing but not over another booking", () => {
    const short: AvailabilityWindow = { ...morning, end: at("2030-01-07T07:00:00Z") };
    const slots = generateSlots({
      windows: [short],
      busy: [],
      config: config({ durationMin: 30, bufferMin: 15, granularityMin: 30 }),
    });
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      "2030-01-07T06:00:00.000Z",
      "2030-01-07T06:30:00.000Z",
    ]);
    // The stored range covers the buffer — that is what the exclusion
    // constraint protects.
    expect(slots[1]?.end.toISOString()).toBe("2030-01-07T07:00:00.000Z");
    expect(slots[1]?.blockEnd.toISOString()).toBe("2030-01-07T07:15:00.000Z");
  });

  it("excludes a slot whose buffer would collide with an existing appointment", () => {
    const busy: BusyInterval[] = [
      {
        providerId: PROVIDER,
        kind: "appointment",
        start: at("2030-01-07T06:40:00Z"),
        end: at("2030-01-07T07:00:00Z"),
      },
    ];
    expect(run({ durationMin: 20, bufferMin: 10, granularityMin: 15 }, busy)).not.toContain(
      "2030-01-07T06:15:00.000Z",
    );
    expect(run({ durationMin: 20, bufferMin: 10, granularityMin: 15 }, busy)).toContain(
      "2030-01-07T06:00:00.000Z",
    );
  });

  it("treats ranges as half open, so back-to-back is allowed", () => {
    const busy: BusyInterval[] = [
      {
        providerId: PROVIDER,
        kind: "hold",
        start: at("2030-01-07T06:00:00Z"),
        end: at("2030-01-07T06:30:00Z"),
      },
    ];
    const result = run({ durationMin: 30, granularityMin: 30 }, busy);
    expect(result).not.toContain("2030-01-07T06:00:00.000Z");
    expect(result[0]).toBe("2030-01-07T06:30:00.000Z");
  });

  it("honours min notice", () => {
    expect(run({ now: at("2030-01-07T05:30:00Z"), minNoticeMin: 60, granularityMin: 30 })[0]).toBe(
      "2030-01-07T06:30:00.000Z",
    );
    expect(run({ now: at("2030-01-07T05:30:00Z"), minNoticeMin: 0, granularityMin: 30 })[0]).toBe(
      "2030-01-07T06:00:00.000Z",
    );
  });

  it("honours the booking window in whole clinic-local days", () => {
    // "Today" is the 7th; a zero-day window still allows the rest of today.
    expect(run({ now: at("2030-01-07T03:00:00Z"), bookingWindowDays: 0 }).length).toBeGreaterThan(
      0,
    );
    expect(run({ now: at("2030-01-06T03:00:00Z"), bookingWindowDays: 0 })).toEqual([]);
  });

  it("clips to the requested range", () => {
    expect(run({ from: at("2030-01-07T07:00:00Z"), granularityMin: 30, durationMin: 60 })).toEqual([
      "2030-01-07T07:00:00.000Z",
      "2030-01-07T07:30:00.000Z",
      "2030-01-07T08:00:00.000Z",
    ]);
    expect(run({ to: at("2030-01-07T06:31:00Z"), granularityMin: 30, durationMin: 60 })).toEqual([
      "2030-01-07T06:00:00.000Z",
      "2030-01-07T06:30:00.000Z",
    ]);
  });

  it("blocks every provider during a clinic-wide closure", () => {
    const busy: BusyInterval[] = [
      {
        providerId: null,
        kind: "time_off",
        start: at("2030-01-07T00:00:00Z"),
        end: at("2030-01-08T00:00:00Z"),
      },
    ];
    expect(run({}, busy)).toEqual([]);
  });

  it("ignores another provider's time off", () => {
    const busy: BusyInterval[] = [
      {
        providerId: "prv_2",
        kind: "time_off",
        start: at("2030-01-07T00:00:00Z"),
        end: at("2030-01-08T00:00:00Z"),
      },
    ];
    expect(run({}, busy).length).toBeGreaterThan(0);
  });

  it("produces real hours, not wall-clock hours, across a DST change", () => {
    // Europe/London, 2026-03-29: 00:00–06:00 local is five real hours.
    const springWindow: AvailabilityWindow = {
      providerId: PROVIDER,
      locationId: null,
      start: at("2026-03-29T00:00:00Z"),
      end: at("2026-03-29T05:00:00Z"),
    };
    const slots = generateSlots({
      windows: [springWindow],
      busy: [],
      config: config({
        timezone: LONDON,
        from: at("2026-03-28T00:00:00Z"),
        to: at("2026-03-30T00:00:00Z"),
        now: at("2026-03-27T00:00:00Z"),
        durationMin: 60,
        granularityMin: 60,
        minNoticeMin: 0,
      }),
    });
    expect(slots).toHaveLength(5);
    // The grid stays on the local clock: 00:00 and 02:00 local, no 01:00.
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      "2026-03-29T00:00:00.000Z",
      "2026-03-29T01:00:00.000Z",
      "2026-03-29T02:00:00.000Z",
      "2026-03-29T03:00:00.000Z",
      "2026-03-29T04:00:00.000Z",
    ]);
  });

  it("returns nothing when there is no availability", () => {
    expect(run({}, [], [])).toEqual([]);
  });
});
