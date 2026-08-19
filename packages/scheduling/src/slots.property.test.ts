import { overlaps } from "@sema/shared";
import { describe, expect, it } from "vitest";

import { expandAvailability, type AvailabilityRule } from "./availability.js";
import { generateSlots } from "./slots.js";
import type { BusyInterval, Slot } from "./types.js";

/**
 * Property test: **a provider is never offered two overlapping blocks.**
 *
 * The invariant the whole package rests on. The Postgres exclusion constraint
 * enforces it at write time (see `test/holds.test.ts`), but a generator that
 * offers colliding slots would still hand patients times that fail at
 * booking — so the pure maths has to hold it too.
 *
 * The generator is a hand-rolled seeded LCG rather than `fast-check`: it costs
 * no dependency (CLAUDE.md hard rule 9), and a fixed seed list makes a failure
 * reproducible from the test name alone.
 */

const TIMEZONES = ["Africa/Nairobi", "Europe/London", "Asia/Kathmandu"] as const;
const PROVIDERS = ["prv_a", "prv_b", "prv_c"] as const;

/** Numerical Recipes LCG — deterministic, and good enough to shuffle inputs. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function scenario(seed: number): {
  timezone: string;
  rules: AvailabilityRule[];
  durationMin: number;
  bufferMin: number;
  granularityMin: number;
  providerIds: string[];
} {
  const rand = lcg(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const between = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

  const providerIds = PROVIDERS.slice(0, between(1, PROVIDERS.length));
  const rules: AvailabilityRule[] = [];
  for (const providerId of providerIds) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      if (rand() < 0.45) continue;
      const startHour = between(6, 14);
      const lengthHours = between(1, 9);
      rules.push({
        providerId,
        weekday,
        startLocal: `${String(startHour).padStart(2, "0")}:${pick(["00", "15", "30"])}`,
        endLocal: `${String(Math.min(23, startHour + lengthHours)).padStart(2, "0")}:00`,
      });
    }
  }

  return {
    timezone: pick(TIMEZONES),
    rules,
    durationMin: pick([10, 15, 20, 30, 45, 60, 90]),
    bufferMin: pick([0, 0, 5, 10, 15]),
    granularityMin: pick([5, 10, 15, 20, 30, 60]),
    providerIds: [...providerIds],
  };
}

const memo = new Map<number, { booked: Slot[]; rejected: number }>();

/** Memoised, so every suite below reads the same 100 simulations. */
function simulate(seed: number): { booked: Slot[]; rejected: number } {
  const cached = memo.get(seed);
  if (cached) return cached;
  const result = run(seed);
  memo.set(seed, result);
  return result;
}

/**
 * Book greedily, re-searching after every booking, exactly as a busy clinic
 * would: search → take one → search again.
 */
function run(seed: number): { booked: Slot[]; rejected: number } {
  const rand = lcg(seed * 7919 + 13);
  const spec = scenario(seed);
  // A DST weekend on purpose: Europe/London springs forward on 2026-03-29.
  const from = new Date("2026-03-25T00:00:00Z");
  const to = new Date("2026-04-01T00:00:00Z");
  const now = new Date("2026-03-24T00:00:00Z");

  const windows = expandAvailability(spec.rules, { timezone: spec.timezone, from, to });
  const busy: BusyInterval[] = [];
  const booked: Slot[] = [];
  let rejected = 0;

  for (let round = 0; round < 10; round += 1) {
    const slots = generateSlots({
      windows,
      busy,
      config: {
        timezone: spec.timezone,
        from,
        to,
        now,
        durationMin: spec.durationMin,
        bufferMin: spec.bufferMin,
        granularityMin: spec.granularityMin,
        minNoticeMin: 60,
        bookingWindowDays: 30,
      },
    });
    if (slots.length === 0) {
      rejected += 1;
      break;
    }
    const chosen = slots[Math.floor(rand() * slots.length)]!;
    booked.push(chosen);
    busy.push({
      providerId: chosen.providerId,
      kind: "appointment",
      start: chosen.start,
      end: chosen.blockEnd,
    });
  }

  return { booked, rejected };
}

describe("property: generated bookings never overlap for one provider", () => {
  const seeds = Array.from({ length: 100 }, (_, i) => i + 1);

  it.each(seeds.map((seed) => [seed]))("seed %i", (seed) => {
    const { booked } = simulate(seed);

    const byProvider = new Map<string, Slot[]>();
    for (const slot of booked) {
      const list = byProvider.get(slot.providerId) ?? [];
      list.push(slot);
      byProvider.set(slot.providerId, list);
    }

    for (const [providerId, slots] of byProvider) {
      slots.sort((a, b) => a.start.getTime() - b.start.getTime());
      for (let i = 1; i < slots.length; i += 1) {
        const previous = slots[i - 1]!;
        const current = slots[i]!;
        const collides = overlaps(
          { start: previous.start, end: previous.blockEnd },
          { start: current.start, end: current.blockEnd },
        );
        expect(
          collides,
          `${providerId}: ${previous.start.toISOString()}–${previous.blockEnd.toISOString()} collides with ${current.start.toISOString()}–${current.blockEnd.toISOString()}`,
        ).toBe(false);
      }
    }
  });

  it("actually books something across the seed space", () => {
    const total = seeds.reduce((sum, seed) => sum + simulate(seed).booked.length, 0);
    // Guards against a vacuous suite: if generation broke, this drops to zero.
    expect(total).toBeGreaterThan(seeds.length * 5);
  });

  it("keeps every offered slot inside a real availability window", () => {
    for (const seed of seeds) {
      for (const slot of simulate(seed).booked) {
        expect(slot.end.getTime()).toBeGreaterThan(slot.start.getTime());
        expect(slot.blockEnd.getTime()).toBeGreaterThanOrEqual(slot.end.getTime());
      }
    }
  });
});
