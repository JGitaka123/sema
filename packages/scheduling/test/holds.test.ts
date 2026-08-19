import { AppError, newId } from "@sema/shared";
import { beforeAll, describe, expect, it } from "vitest";

import { HOLD_TTL_MINUTES } from "../src/index.js";
import {
  MONDAY_0900,
  countHolds,
  createSchedulingTenant,
  getHarness,
  insertExpiredHold,
  type Harness,
  type SchedulingFixture,
} from "./support/fixture.js";

/**
 * Holds against a real Postgres.
 *
 * The point of this suite is the one thing unit tests cannot show: that the
 * GiST exclusion constraint, not application code, is what stops two patients
 * taking the same slot (ARCHITECTURE.md §4).
 */

const maybeHarness = await getHarness();
const describeDb = maybeHarness ? describe : describe.skip;
const h = maybeHarness as Harness;

const MONDAY = new Date("2030-01-07T00:00:00Z");
const TUESDAY = new Date("2030-01-08T00:00:00Z");
const minutesAfter = (base: Date, m: number): Date => new Date(base.getTime() + m * 60_000);

describeDb("holdSlot", () => {
  let t: SchedulingFixture;

  beforeAll(async () => {
    t = await createSchedulingTenant(h, "holds");
  });

  it("reserves a slot for ten minutes and removes it from search", async () => {
    const start = minutesAfter(MONDAY_0900, 60); // 10:00 EAT
    const before = Date.now();
    const held = await t.scheduler.holdSlot({
      clinicId: t.clinicId,
      providerId: t.providerId,
      serviceId: t.serviceId,
      start,
      patientId: t.patientId,
      conversationId: t.conversationId,
    });

    expect(held.holdId.startsWith("hld_")).toBe(true);
    expect(held.start.toISOString()).toBe(start.toISOString());
    // duration 20, buffer 0 for the base service.
    expect(held.blockEnd.toISOString()).toBe(minutesAfter(start, 20).toISOString());
    expect(held.expiresAt.getTime()).toBeGreaterThan(before);
    expect(held.expiresAt.getTime()).toBeLessThan(before + (HOLD_TTL_MINUTES + 2) * 60_000);

    const { slots } = await t.scheduler.searchSlots({
      clinicId: t.clinicId,
      serviceId: t.serviceId,
      providerId: t.providerId,
      from: MONDAY,
      to: TUESDAY,
      limit: 200,
    });
    expect(slots.some((s) => s.start.getTime() === start.getTime())).toBe(false);
  });

  it("stores the turnaround buffer inside the reserved range", async () => {
    const start = minutesAfter(MONDAY_0900, 180); // 12:00 EAT
    const held = await t.scheduler.holdSlot({
      clinicId: t.clinicId,
      providerId: t.secondProviderId,
      serviceId: t.depositServiceId, // duration 30, buffer 15
      start,
      patientId: t.patientId,
    });
    expect(held.end.toISOString()).toBe(minutesAfter(start, 30).toISOString());
    expect(held.blockEnd.toISOString()).toBe(minutesAfter(start, 45).toISOString());
  });

  /**
   * The race the whole design exists for: two agent turns, one slot.
   * Postgres must reject exactly one, and the loser must see a domain error
   * rather than a driver error.
   */
  it("lets exactly one of two simultaneous holds win", async () => {
    const race = await createSchedulingTenant(h, "race");
    const start = minutesAfter(MONDAY_0900, 120);
    const attempt = () =>
      race.scheduler.holdSlot({
        clinicId: race.clinicId,
        providerId: race.providerId,
        serviceId: race.serviceId,
        start,
        patientId: race.patientId,
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const error = (rejected[0] as PromiseRejectedResult).reason as unknown;
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("SLOT_UNAVAILABLE");
    // Nothing about Postgres leaks to the patient.
    expect((error as AppError).message).not.toMatch(/constraint|conflict|gist/i);

    expect(await countHolds(h, race.clinicId)).toBe(1);
  });

  it("survives many concurrent attempts on one slot", async () => {
    const race = await createSchedulingTenant(h, "race-many");
    const start = minutesAfter(MONDAY_0900, 240);
    const attempts = Array.from({ length: 4 }, () =>
      race.scheduler.holdSlot({
        clinicId: race.clinicId,
        providerId: race.providerId,
        serviceId: race.serviceId,
        start,
        patientId: race.patientId,
      }),
    );
    const results = await Promise.allSettled(attempts);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter((r) => r.status === "rejected")) {
      expect(((result as PromiseRejectedResult).reason as AppError).code).toBe("SLOT_UNAVAILABLE");
    }
    expect(await countHolds(h, race.clinicId)).toBe(1);
  });

  /**
   * The exclusion constraint is unconditional (an index predicate must be
   * IMMUTABLE, and `now()` is not — packages/db/README.md), so an expired hold
   * would block its slot forever if `holdSlot` did not clear it first.
   */
  it("takes over a slot whose earlier hold has expired", async () => {
    const stale = await createSchedulingTenant(h, "stale");
    const start = minutesAfter(MONDAY_0900, 300);
    await insertExpiredHold(h, stale, start, 20);
    expect(await countHolds(h, stale.clinicId)).toBe(1);

    const held = await stale.scheduler.holdSlot({
      clinicId: stale.clinicId,
      providerId: stale.providerId,
      serviceId: stale.serviceId,
      start,
      patientId: stale.patientId,
    });

    expect(held.start.toISOString()).toBe(start.toISOString());
    // The stale row is gone, replaced by the new one — deleted in the same
    // transaction as the insert.
    expect(await countHolds(h, stale.clinicId)).toBe(1);
  });

  /**
   * The error taxonomy, and it matters: a `VALIDATION_FAILED` tells the agent
   * the patient asked for something impossible, while `SLOT_UNAVAILABLE` tells
   * it to offer another time. These two suites pin each side.
   */
  it("reports a structurally impossible time as VALIDATION_FAILED", async () => {
    const outside = [
      new Date("2030-01-07T03:00:00Z"), // 06:00 EAT — before opening
      new Date("2030-01-07T06:07:00Z"), // off the 15-minute grid
      new Date("2030-01-07T14:00:00Z"), // 17:00 EAT — after closing
      new Date("2030-01-06T06:00:00Z"), // a Sunday
      new Date("2031-01-06T06:00:00Z"), // beyond the 30-day booking window
    ];
    for (const start of outside) {
      await expect(
        t.scheduler.holdSlot({
          clinicId: t.clinicId,
          providerId: t.providerId,
          serviceId: t.serviceId,
          start,
          patientId: t.patientId,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });

  /**
   * The deterministic form of the race in the two suites above: by the time a
   * loser re-derives the day, the winner's hold is committed and visible, so
   * the slot is gone from the generated set. That must still read as
   * `SLOT_UNAVAILABLE` — it is a real slot, taken — and never as a validation
   * error. Doing it sequentially means a regression fails every run rather
   * than only when the scheduler interleaves unluckily.
   */
  it("reports a real slot that is already held as SLOT_UNAVAILABLE", async () => {
    const busy = await createSchedulingTenant(h, "busy-hold");
    const start = minutesAfter(MONDAY_0900, 420);
    const request = {
      clinicId: busy.clinicId,
      providerId: busy.providerId,
      serviceId: busy.serviceId,
      start,
      patientId: busy.patientId,
    };

    await busy.scheduler.holdSlot(request);
    await expect(busy.scheduler.holdSlot(request)).rejects.toMatchObject({
      code: "SLOT_UNAVAILABLE",
    });
  });

  it("reports a slot an appointment already occupies as SLOT_UNAVAILABLE", async () => {
    const taken = await createSchedulingTenant(h, "taken");
    const start = minutesAfter(MONDAY_0900, 360);
    const held = await taken.scheduler.holdSlot({
      clinicId: taken.clinicId,
      providerId: taken.providerId,
      serviceId: taken.serviceId,
      start,
      patientId: taken.patientId,
    });
    await taken.scheduler.book({
      clinicId: taken.clinicId,
      holdId: held.holdId,
      patientId: taken.patientId,
    });

    await expect(
      taken.scheduler.holdSlot({
        clinicId: taken.clinicId,
        providerId: taken.providerId,
        serviceId: taken.serviceId,
        start,
        patientId: taken.patientId,
      }),
    ).rejects.toMatchObject({ code: "SLOT_UNAVAILABLE" });
  });

  it("reports a slot covered by time off as SLOT_UNAVAILABLE", async () => {
    const away = await createSchedulingTenant(h, "away");
    const start = minutesAfter(MONDAY_0900, 60);
    await h.asOwner(away.clinicId, (client) =>
      client.query(
        `insert into time_off (id, clinic_id, provider_id, starts_at, ends_at, reason)
         values ($3, $1, $2, '2030-01-07T06:30:00Z', '2030-01-07T08:00:00Z', 'leave')`,
        [away.clinicId, away.providerId, newId("timeOff")],
      ),
    );

    await expect(
      away.scheduler.holdSlot({
        clinicId: away.clinicId,
        providerId: away.providerId,
        serviceId: away.serviceId,
        start,
        patientId: away.patientId,
      }),
    ).rejects.toMatchObject({ code: "SLOT_UNAVAILABLE" });
  });
});

describeDb("expireHolds", () => {
  it("sweeps expired holds per clinic and leaves live ones alone", async () => {
    const t = await createSchedulingTenant(h, "expiry");
    await insertExpiredHold(h, t, minutesAfter(MONDAY_0900, 60), 20);
    await insertExpiredHold(h, t, minutesAfter(MONDAY_0900, 120), 20);
    await t.scheduler.holdSlot({
      clinicId: t.clinicId,
      providerId: t.secondProviderId,
      serviceId: t.serviceId,
      start: minutesAfter(MONDAY_0900, 180),
      patientId: t.patientId,
    });
    expect(await countHolds(h, t.clinicId)).toBe(3);

    const result = await t.scheduler.expireHolds({ clinicIds: [t.clinicId] });
    expect(result).toEqual({ clinics: 1, deleted: 2 });
    expect(await countHolds(h, t.clinicId)).toBe(1);

    // Idempotent: a second sweep finds nothing.
    expect(await t.scheduler.expireHolds({ clinicIds: [t.clinicId] })).toEqual({
      clinics: 1,
      deleted: 0,
    });
  });

  it("rejects an id that is not a clinic id rather than opening a transaction", async () => {
    const t = await createSchedulingTenant(h, "expiry-guard");
    await expect(t.scheduler.expireHolds({ clinicIds: ["nope"] })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});
