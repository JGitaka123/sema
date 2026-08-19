import { AppError, newId } from "@sema/shared";
import { beforeAll, describe, expect, it } from "vitest";

import {
  MONDAY_0900,
  createSchedulingTenant,
  getHarness,
  type Harness,
  type SchedulingFixture,
} from "./support/fixture.js";

/**
 * `searchSlots` against a real database.
 *
 * Everything runs as the unprivileged probe role, so the `tenant_isolation`
 * policies are actually in force (see `support/fixture.ts` — as a superuser
 * every isolation assertion here would pass vacuously).
 */

const maybeHarness = await getHarness();
const describeDb = maybeHarness ? describe : describe.skip;
const h = maybeHarness as Harness;

const MONDAY = new Date("2030-01-07T00:00:00Z");
const TUESDAY = new Date("2030-01-08T00:00:00Z");
const iso = (d: Date): string => d.toISOString();

/** Stable ids for rows a test inserts directly and then mutates. */
const HELD_SLOT_ID = newId("slotHold");

describeDb("searchSlots", () => {
  let t: SchedulingFixture;

  beforeAll(async () => {
    t = await createSchedulingTenant(h, "search");
  });

  const search = (over: Partial<Parameters<typeof t.scheduler.searchSlots>[0]> = {}) =>
    t.scheduler.searchSlots({
      clinicId: t.clinicId,
      serviceId: t.serviceId,
      from: MONDAY,
      to: TUESDAY,
      limit: 200,
      ...over,
    });

  it("offers the clinic's working hours on the clinic's own grid", async () => {
    const { slots, timezone } = await search();
    expect(timezone).toBe("Africa/Nairobi");
    expect(slots.length).toBeGreaterThan(0);
    // 09:00 Africa/Nairobi on Monday, for both providers.
    expect(slots.filter((s) => iso(s.start) === iso(MONDAY_0900))).toHaveLength(2);
    // Nothing before opening or after closing.
    for (const slot of slots) {
      expect(iso(slot.start) >= "2030-01-07T06:00:00.000Z").toBe(true);
      expect(iso(slot.end) <= "2030-01-07T14:00:00.000Z").toBe(true);
    }
  });

  it("returns slots soonest first and respects the limit", async () => {
    const { slots, total } = await search({ limit: 5 });
    expect(slots).toHaveLength(5);
    expect(total).toBeGreaterThan(5);
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i]!.start.getTime()).toBeGreaterThanOrEqual(slots[i - 1]!.start.getTime());
    }
  });

  it("filters to a requested provider", async () => {
    const { slots } = await search({ providerId: t.secondProviderId });
    expect(slots.length).toBeGreaterThan(0);
    expect(new Set(slots.map((s) => s.providerId))).toEqual(new Set([t.secondProviderId]));
  });

  it("excludes a slot occupied by a booked appointment", async () => {
    await h.asOwner(t.clinicId, (client) =>
      client.query(
        `insert into appointment (id, clinic_id, patient_id, provider_id, service_id, slot, status)
         values ($5, $1, $2, $3, $4,
                 tstzrange('2030-01-07T06:00:00Z','2030-01-07T06:20:00Z','[)'), 'booked')`,
        [t.clinicId, t.patientId, t.providerId, t.serviceId, newId("appointment")],
      ),
    );
    const { slots } = await search();
    expect(
      slots.some((s) => s.providerId === t.providerId && iso(s.start) === iso(MONDAY_0900)),
    ).toBe(false);
    // The other provider is untouched.
    expect(
      slots.some((s) => s.providerId === t.secondProviderId && iso(s.start) === iso(MONDAY_0900)),
    ).toBe(true);
  });

  it("excludes a slot covered by an unexpired hold, and offers it again once expired", async () => {
    const range = `tstzrange('2030-01-07T07:00:00Z','2030-01-07T07:20:00Z','[)')`;
    const held = (expiresIn: string) =>
      h.asOwner(t.clinicId, (client) =>
        client.query(
          `insert into slot_hold (id, clinic_id, provider_id, service_id, slot, expires_at)
           values ($1, $2, $3, $4, ${range}, now() + $5::interval)
           on conflict (id) do update set expires_at = now() + $5::interval`,
          [HELD_SLOT_ID, t.clinicId, t.secondProviderId, t.serviceId, expiresIn],
        ),
      );

    await held("10 minutes");
    const live = await search({ providerId: t.secondProviderId });
    expect(live.slots.some((s) => iso(s.start) === "2030-01-07T07:00:00.000Z")).toBe(false);

    await held("-1 minutes");
    const expired = await search({ providerId: t.secondProviderId });
    expect(expired.slots.some((s) => iso(s.start) === "2030-01-07T07:00:00.000Z")).toBe(true);
  });

  it("respects provider time off and a clinic-wide closure", async () => {
    const off = await createSchedulingTenant(h, "timeoff");
    const searchOff = (providerId?: string) =>
      off.scheduler.searchSlots({
        clinicId: off.clinicId,
        serviceId: off.serviceId,
        providerId: providerId ?? null,
        from: MONDAY,
        to: TUESDAY,
        limit: 200,
      });

    await h.asOwner(off.clinicId, (client) =>
      client.query(
        `insert into time_off (id, clinic_id, provider_id, starts_at, ends_at, reason)
         values ($3, $1, $2,
                 '2030-01-07T06:00:00Z', '2030-01-07T09:00:00Z', 'leave')`,
        [off.clinicId, off.providerId, newId("timeOff")],
      ),
    );
    const first = await searchOff(off.providerId);
    expect(first.slots.every((s) => iso(s.start) >= "2030-01-07T09:00:00.000Z")).toBe(true);
    // The second provider is still available in the morning.
    expect(
      (await searchOff(off.secondProviderId)).slots.some(
        (s) => iso(s.start) < "2030-01-07T09:00:00.000Z",
      ),
    ).toBe(true);

    await h.asOwner(off.clinicId, (client) =>
      client.query(
        `insert into time_off (id, clinic_id, provider_id, starts_at, ends_at, reason)
         values ($2, $1, null,
                 '2030-01-07T00:00:00Z', '2030-01-08T00:00:00Z', 'public holiday')`,
        [off.clinicId, newId("timeOff")],
      ),
    );
    expect((await searchOff()).slots).toEqual([]);
  });

  it("honours min notice and the booking window from the clinic row", async () => {
    const narrow = await createSchedulingTenant(h, "window");
    await h.asOwner(narrow.clinicId, (client) =>
      client.query(`update clinic set booking_window_days = 0 where id = $1`, [narrow.clinicId]),
    );
    // The clock is the Saturday before; a zero-day window cannot reach Monday.
    const result = await narrow.scheduler.searchSlots({
      clinicId: narrow.clinicId,
      serviceId: narrow.serviceId,
      from: MONDAY,
      to: TUESDAY,
    });
    expect(result.slots).toEqual([]);
  });

  it("refuses a service that is not bookable by patients", async () => {
    const hidden = await createSchedulingTenant(h, "hidden");
    await h.asOwner(hidden.clinicId, (client) =>
      client.query(`update service set patient_bookable = false where id = $1`, [hidden.serviceId]),
    );
    await expect(
      hidden.scheduler.searchSlots({
        clinicId: hidden.clinicId,
        serviceId: hidden.serviceId,
        from: MONDAY,
        to: TUESDAY,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects malformed ids before they reach SQL", async () => {
    await expect(search({ clinicId: "not-an-id" })).rejects.toBeInstanceOf(AppError);
    await expect(search({ serviceId: "svc_nope" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});

describeDb("searchSlots tenant isolation", () => {
  let a: SchedulingFixture;
  let b: SchedulingFixture;

  beforeAll(async () => {
    a = await createSchedulingTenant(h, "rls-a");
    b = await createSchedulingTenant(h, "rls-b");
  });

  it("cannot see another clinic's service, even with a valid id", async () => {
    await expect(
      a.scheduler.searchSlots({
        clinicId: a.clinicId,
        serviceId: b.serviceId,
        from: MONDAY,
        to: TUESDAY,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("cannot see another clinic's provider", async () => {
    const { slots } = await a.scheduler.searchSlots({
      clinicId: a.clinicId,
      serviceId: a.serviceId,
      providerId: b.providerId,
      from: MONDAY,
      to: TUESDAY,
    });
    expect(slots).toEqual([]);
  });

  it("is not blocked by another clinic's bookings at the same instant", async () => {
    await h.asOwner(b.clinicId, (client) =>
      client.query(
        `insert into appointment (id, clinic_id, patient_id, provider_id, service_id, slot, status)
         values ($5, $1, $2, $3, $4,
                 tstzrange('2030-01-07T06:00:00Z','2030-01-07T14:00:00Z','[)'), 'booked')`,
        [b.clinicId, b.patientId, b.providerId, b.serviceId, newId("appointment")],
      ),
    );

    const mine = await a.scheduler.searchSlots({
      clinicId: a.clinicId,
      serviceId: a.serviceId,
      from: MONDAY,
      to: TUESDAY,
      limit: 200,
    });
    expect(mine.slots.some((s) => iso(s.start) === iso(MONDAY_0900))).toBe(true);
    expect(mine.slots.every((s) => s.providerId !== b.providerId)).toBe(true);

    // …and clinic B really did lose its whole Monday.
    const theirs = await b.scheduler.searchSlots({
      clinicId: b.clinicId,
      serviceId: b.serviceId,
      providerId: b.providerId,
      from: MONDAY,
      to: TUESDAY,
      limit: 200,
    });
    expect(theirs.slots).toEqual([]);
  });
});
