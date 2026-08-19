import { describe, expect, it } from "vitest";

import { rankSlots } from "./ranking.js";
import type { Slot } from "./types.js";

const slot = (providerId: string, iso: string): Slot => ({
  providerId,
  locationId: null,
  start: new Date(iso),
  end: new Date(new Date(iso).getTime() + 20 * 60_000),
  blockEnd: new Date(new Date(iso).getTime() + 20 * 60_000),
});

const order = (slots: Slot[]): string[] =>
  slots.map((s) => `${s.providerId}@${s.start.toISOString().slice(11, 16)}`);

describe("rankSlots", () => {
  it("puts the soonest slot first, whatever the input order", () => {
    const ranked = rankSlots({
      slots: [
        slot("prv_b", "2030-01-07T09:00:00Z"),
        slot("prv_a", "2030-01-07T08:00:00Z"),
        slot("prv_a", "2030-01-07T10:00:00Z"),
      ],
    });
    expect(order(ranked)).toEqual(["prv_a@08:00", "prv_b@09:00", "prv_a@10:00"]);
  });

  it("prefers the requested provider when two are free at the same time", () => {
    const ranked = rankSlots({
      slots: [slot("prv_a", "2030-01-07T08:00:00Z"), slot("prv_b", "2030-01-07T08:00:00Z")],
      preferredProviderId: "prv_b",
    });
    expect(order(ranked)).toEqual(["prv_b@08:00", "prv_a@08:00"]);
  });

  it("balances load between providers who are equally soon", () => {
    const ranked = rankSlots({
      slots: [slot("prv_a", "2030-01-07T08:00:00Z"), slot("prv_b", "2030-01-07T08:00:00Z")],
      loadByProvider: { prv_a: 7, prv_b: 2 },
    });
    expect(order(ranked)).toEqual(["prv_b@08:00", "prv_a@08:00"]);
  });

  it("lets an explicit preference beat load balancing", () => {
    const ranked = rankSlots({
      slots: [slot("prv_a", "2030-01-07T08:00:00Z"), slot("prv_b", "2030-01-07T08:00:00Z")],
      preferredProviderId: "prv_a",
      loadByProvider: { prv_a: 9, prv_b: 0 },
    });
    expect(order(ranked)[0]).toBe("prv_a@08:00");
  });

  it("is deterministic when everything else ties", () => {
    const slots = [slot("prv_c", "2030-01-07T08:00:00Z"), slot("prv_a", "2030-01-07T08:00:00Z")];
    expect(order(rankSlots({ slots }))).toEqual(order(rankSlots({ slots: [...slots].reverse() })));
  });

  it("does not mutate its input", () => {
    const slots = [slot("prv_b", "2030-01-07T09:00:00Z"), slot("prv_a", "2030-01-07T08:00:00Z")];
    rankSlots({ slots });
    expect(slots[0]?.providerId).toBe("prv_b");
  });
});
