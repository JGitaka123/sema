import { AppError } from "@sema/shared";
import { beforeAll, describe, expect, it } from "vitest";

import {
  MONDAY_0900,
  appointmentStatus,
  auditRows,
  countHolds,
  createSchedulingTenant,
  getHarness,
  insertExpiredHold,
  schedulerAt,
  type Harness,
  type SchedulingFixture,
} from "./support/fixture.js";

/**
 * `book`, `reschedule` and `cancel` against a real Postgres.
 *
 * These are the state transitions the inbox and the agent will drive, so the
 * assertions are about what is *left in the database*: statuses, the
 * `reschedule_of` chain, the hold being gone, and an `audit_log` row for every
 * change (CLAUDE.md hard rule 7).
 */

const maybeHarness = await getHarness();
const describeDb = maybeHarness ? describe : describe.skip;
const h = maybeHarness as Harness;

const minutesAfter = (base: Date, m: number): Date => new Date(base.getTime() + m * 60_000);

/** Hold a slot for the base service (20 min, no buffer, no deposit). */
async function hold(t: SchedulingFixture, offsetMin: number, providerId?: string): Promise<string> {
  const held = await t.scheduler.holdSlot({
    clinicId: t.clinicId,
    providerId: providerId ?? t.providerId,
    serviceId: t.serviceId,
    start: minutesAfter(MONDAY_0900, offsetMin),
    patientId: t.patientId,
    conversationId: t.conversationId,
  });
  return held.holdId;
}

describeDb("book", () => {
  let t: SchedulingFixture;

  beforeAll(async () => {
    t = await createSchedulingTenant(h, "book");
  });

  it("turns a hold into a booked appointment and consumes the hold", async () => {
    const holdId = await hold(t, 0);
    const { appointment, depositRequiredMinor } = await t.scheduler.book({
      clinicId: t.clinicId,
      holdId,
      patientId: t.patientId,
      visitReason: "follow-up",
      intakeAnswers: { first_visit: "no" },
    });

    expect(appointment.status).toBe("booked");
    expect(appointment.providerId).toBe(t.providerId);
    expect(appointment.start.toISOString()).toBe(MONDAY_0900.toISOString());
    expect(appointment.end.toISOString()).toBe(minutesAfter(MONDAY_0900, 20).toISOString());
    expect(depositRequiredMinor).toBe(0);
    expect(appointment.source).toBe("agent");

    expect(await countHolds(h, t.clinicId)).toBe(0);

    const audit = await auditRows(h, t.clinicId, appointment.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "appointment.booked", actor: "agent" });
  });

  it("creates a pending_deposit appointment when the service takes a deposit", async () => {
    const deposit = await createSchedulingTenant(h, "deposit");
    const held = await deposit.scheduler.holdSlot({
      clinicId: deposit.clinicId,
      providerId: deposit.providerId,
      serviceId: deposit.depositServiceId,
      start: MONDAY_0900,
      patientId: deposit.patientId,
    });
    const { appointment, depositRequiredMinor } = await deposit.scheduler.book({
      clinicId: deposit.clinicId,
      holdId: held.holdId,
      patientId: deposit.patientId,
      source: "staff",
      actor: { kind: "staff", staffUserId: "usr_desk" },
    });

    expect(appointment.status).toBe("pending_deposit");
    expect(depositRequiredMinor).toBe(100_000);
    expect(appointment.depositRequiredMinor).toBe(100_000);
    // No money has moved and no payment row exists — that is Phase 6.
    expect(appointment.depositPaidMinor).toBe(0);
    // The 15-minute buffer is inside the stored range.
    expect(appointment.end.toISOString()).toBe(minutesAfter(MONDAY_0900, 45).toISOString());

    const audit = await auditRows(h, deposit.clinicId, appointment.id);
    expect(audit[0]?.actor).toBe("staff:usr_desk");
  });

  /**
   * The cleanup has to survive the failure. `book` deletes the expired hold
   * and then reports `HOLD_EXPIRED`; raising that error from *inside* the
   * transaction would roll the delete back with it, leaving a dead row to go
   * on blocking its slot through the unconditional exclusion constraint until
   * the next sweep. Re-holding the same slot afterwards is what proves the
   * delete committed.
   */
  it("refuses an expired hold, clears it, and frees the slot immediately", async () => {
    const stale = await createSchedulingTenant(h, "book-stale");
    const holdId = await insertExpiredHold(h, stale, MONDAY_0900, 20);

    await expect(
      stale.scheduler.book({ clinicId: stale.clinicId, holdId, patientId: stale.patientId }),
    ).rejects.toMatchObject({ code: "HOLD_EXPIRED" });
    expect(await countHolds(h, stale.clinicId)).toBe(0);

    const fresh = await stale.scheduler.holdSlot({
      clinicId: stale.clinicId,
      providerId: stale.providerId,
      serviceId: stale.serviceId,
      start: MONDAY_0900,
      patientId: stale.patientId,
    });
    expect(fresh.start.toISOString()).toBe(MONDAY_0900.toISOString());
  });

  it("refuses a hold that never existed", async () => {
    await expect(
      t.scheduler.book({
        clinicId: t.clinicId,
        holdId: "hld_00000000000000000000000000",
        patientId: t.patientId,
      }),
    ).rejects.toMatchObject({ code: "HOLD_EXPIRED" });
  });

  /**
   * Atomicity: one hold can only ever produce one appointment, even if two
   * callers spend it at the same moment. The loser blocks on `for update` and
   * then finds the row gone.
   */
  it("spends a hold exactly once under concurrency", async () => {
    const once = await createSchedulingTenant(h, "book-once");
    const holdId = await hold(once, 60);

    const results = await Promise.allSettled([
      once.scheduler.book({ clinicId: once.clinicId, holdId, patientId: once.patientId }),
      once.scheduler.book({ clinicId: once.clinicId, holdId, patientId: once.patientId }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failure = (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
      .reason as AppError;
    expect(failure).toBeInstanceOf(AppError);
    expect(["HOLD_EXPIRED", "SLOT_UNAVAILABLE"]).toContain(failure.code);

    const count = (await h.asOwner(once.clinicId, (client) =>
      client.query(`select count(*)::int as total from appointment where clinic_id = $1`, [
        once.clinicId,
      ]),
    )) as { rows: Array<{ total: number }> };
    expect(count.rows[0]?.total).toBe(1);
    expect(await countHolds(h, once.clinicId)).toBe(0);
  });

  it("rejects an unknown source", async () => {
    const holdId = await hold(t, 120);
    await expect(
      t.scheduler.book({
        clinicId: t.clinicId,
        holdId,
        patientId: t.patientId,
        source: "sms" as never,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describeDb("reschedule", () => {
  it("moves the appointment, frees the old slot and links the chain", async () => {
    const t = await createSchedulingTenant(h, "resched");
    const original = await t.scheduler.book({
      clinicId: t.clinicId,
      holdId: await hold(t, 0),
      patientId: t.patientId,
    });

    const newHoldId = await hold(t, 120);
    const result = await t.scheduler.reschedule({
      clinicId: t.clinicId,
      appointmentId: original.appointment.id,
      newHoldId,
      actor: { kind: "patient" },
    });

    expect(result.appointment.status).toBe("booked");
    expect(result.appointment.rescheduleOf).toBe(original.appointment.id);
    expect(result.appointment.start.toISOString()).toBe(
      minutesAfter(MONDAY_0900, 120).toISOString(),
    );
    expect(result.previousAppointmentId).toBe(original.appointment.id);
    expect(await appointmentStatus(h, t.clinicId, original.appointment.id)).toBe("rescheduled");
    expect(await countHolds(h, t.clinicId)).toBe(0);

    // Free window: the clock is 42 hours before the appointment.
    expect(result.policy).toMatchObject({ outcome: "free", depositForfeited: false });

    const audit = await auditRows(h, t.clinicId, result.appointment.id);
    expect(audit[0]).toMatchObject({ action: "appointment.rescheduled", actor: "patient" });

    // The freed slot is offerable again.
    const { slots } = await t.scheduler.searchSlots({
      clinicId: t.clinicId,
      serviceId: t.serviceId,
      providerId: t.providerId,
      from: new Date("2030-01-07T00:00:00Z"),
      to: new Date("2030-01-08T00:00:00Z"),
      limit: 200,
    });
    expect(slots.some((s) => s.start.getTime() === MONDAY_0900.getTime())).toBe(true);
  });

  it("carries a paid deposit across, and forfeits it inside the forfeit window", async () => {
    const t = await createSchedulingTenant(h, "resched-deposit");
    const held = await t.scheduler.holdSlot({
      clinicId: t.clinicId,
      providerId: t.providerId,
      serviceId: t.depositServiceId,
      start: MONDAY_0900,
      patientId: t.patientId,
    });
    const original = await t.scheduler.book({
      clinicId: t.clinicId,
      holdId: held.holdId,
      patientId: t.patientId,
    });
    // Pretend Phase 6 has confirmed the deposit.
    await h.asOwner(t.clinicId, (client) =>
      client.query(
        `update appointment set status = 'confirmed', deposit_paid_minor = deposit_required_minor
          where id = $1`,
        [original.appointment.id],
      ),
    );

    const nextHold = await t.scheduler.holdSlot({
      clinicId: t.clinicId,
      providerId: t.providerId,
      serviceId: t.depositServiceId,
      start: minutesAfter(MONDAY_0900, 120),
      patientId: t.patientId,
    });
    const moved = await t.scheduler.reschedule({
      clinicId: t.clinicId,
      appointmentId: original.appointment.id,
      newHoldId: nextHold.holdId,
      actor: { kind: "agent" },
    });

    expect(moved.policy.outcome).toBe("free");
    expect(moved.appointment.depositPaidMinor).toBe(100_000);
    // Deposit satisfied, so the new appointment does not go back to
    // pending_deposit.
    expect(moved.appointment.status).toBe("booked");
  });

  /** The same cleanup-must-commit rule as `book`, on the reschedule path. */
  it("refuses an expired new hold, clears it, and leaves the appointment alone", async () => {
    const t = await createSchedulingTenant(h, "resched-stale");
    const original = await t.scheduler.book({
      clinicId: t.clinicId,
      holdId: await hold(t, 0),
      patientId: t.patientId,
    });
    const staleHoldId = await insertExpiredHold(h, t, minutesAfter(MONDAY_0900, 120), 20);

    await expect(
      t.scheduler.reschedule({
        clinicId: t.clinicId,
        appointmentId: original.appointment.id,
        newHoldId: staleHoldId,
        actor: { kind: "patient" },
      }),
    ).rejects.toMatchObject({ code: "HOLD_EXPIRED" });

    expect(await appointmentStatus(h, t.clinicId, original.appointment.id)).toBe("booked");
    expect(await countHolds(h, t.clinicId)).toBe(0);
  });

  it("refuses to move a hold for a different service", async () => {
    const t = await createSchedulingTenant(h, "resched-service");
    const original = await t.scheduler.book({
      clinicId: t.clinicId,
      holdId: await hold(t, 0),
      patientId: t.patientId,
    });
    const other = await t.scheduler.holdSlot({
      clinicId: t.clinicId,
      providerId: t.secondProviderId,
      serviceId: t.depositServiceId,
      start: minutesAfter(MONDAY_0900, 120),
      patientId: t.patientId,
    });

    await expect(
      t.scheduler.reschedule({
        clinicId: t.clinicId,
        appointmentId: original.appointment.id,
        newHoldId: other.holdId,
        actor: { kind: "patient" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // The original is untouched — the whole thing rolled back.
    expect(await appointmentStatus(h, t.clinicId, original.appointment.id)).toBe("booked");
  });

  it("refuses to move an appointment that is already cancelled", async () => {
    const t = await createSchedulingTenant(h, "resched-cancelled");
    const original = await t.scheduler.book({
      clinicId: t.clinicId,
      holdId: await hold(t, 0),
      patientId: t.patientId,
    });
    await t.scheduler.cancel({
      clinicId: t.clinicId,
      appointmentId: original.appointment.id,
      actor: { kind: "patient" },
    });

    await expect(
      t.scheduler.reschedule({
        clinicId: t.clinicId,
        appointmentId: original.appointment.id,
        newHoldId: await hold(t, 120),
        actor: { kind: "patient" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describeDb("cancel", () => {
  it("records who cancelled and frees the slot", async () => {
    const t = await createSchedulingTenant(h, "cancel");
    const original = await t.scheduler.book({
      clinicId: t.clinicId,
      holdId: await hold(t, 0),
      patientId: t.patientId,
    });

    const result = await t.scheduler.cancel({
      clinicId: t.clinicId,
      appointmentId: original.appointment.id,
      actor: { kind: "patient" },
      reason: "no longer needed",
    });

    expect(result.appointment.status).toBe("cancelled_by_patient");
    expect(result.appointment.cancelledReason).toBe("no longer needed");
    expect(result.policy).toMatchObject({ outcome: "free", depositForfeited: false });

    const audit = await auditRows(h, t.clinicId, original.appointment.id);
    expect(audit[0]).toMatchObject({ action: "appointment.cancelled", actor: "patient" });

    const { slots } = await t.scheduler.searchSlots({
      clinicId: t.clinicId,
      serviceId: t.serviceId,
      providerId: t.providerId,
      from: new Date("2030-01-07T00:00:00Z"),
      to: new Date("2030-01-08T00:00:00Z"),
      limit: 200,
    });
    expect(slots.some((s) => s.start.getTime() === MONDAY_0900.getTime())).toBe(true);
  });

  it("labels a staff cancellation as the clinic's, and never forfeits", async () => {
    const t = await createSchedulingTenant(h, "cancel-clinic");
    const original = await t.scheduler.book({
      clinicId: t.clinicId,
      holdId: await hold(t, 0),
      patientId: t.patientId,
    });

    const result = await t.scheduler.cancel({
      clinicId: t.clinicId,
      appointmentId: original.appointment.id,
      actor: { kind: "staff", staffUserId: "usr_desk" },
    });

    expect(result.appointment.status).toBe("cancelled_by_clinic");
    expect(result.policy).toMatchObject({ clinicInitiated: true, depositForfeited: false });
    expect((await auditRows(h, t.clinicId, original.appointment.id))[0]?.actor).toBe(
      "staff:usr_desk",
    );
  });

  /**
   * Inside `forfeit_hours` the clinic may keep the deposit. We record the
   * decision and nothing else: Sema never moves money (hard rule 5).
   */
  it("records a forfeited deposit for a last-minute patient cancellation", async () => {
    const t = await createSchedulingTenant(h, "cancel-late");
    const held = await t.scheduler.holdSlot({
      clinicId: t.clinicId,
      providerId: t.providerId,
      serviceId: t.depositServiceId,
      start: MONDAY_0900,
      patientId: t.patientId,
    });
    const original = await t.scheduler.book({
      clinicId: t.clinicId,
      holdId: held.holdId,
      patientId: t.patientId,
    });

    // Move the clock to one hour before the appointment: inside the two-hour
    // forfeit window of the clinic's policy.
    const late = schedulerAt(t, minutesAfter(MONDAY_0900, -60));
    const result = await late.cancel({
      clinicId: t.clinicId,
      appointmentId: original.appointment.id,
      actor: { kind: "patient" },
    });

    expect(result.policy).toMatchObject({ outcome: "forfeit", depositForfeited: true });
    expect(result.appointment.status).toBe("cancelled_by_patient");
    expect(result.appointment.depositStatus).toBe("forfeited");
    // The forfeit is a recorded decision, not a transfer.
    expect(result.appointment.depositPaidMinor).toBe(0);
  });

  it("refuses to cancel twice", async () => {
    const t = await createSchedulingTenant(h, "cancel-twice");
    const original = await t.scheduler.book({
      clinicId: t.clinicId,
      holdId: await hold(t, 0),
      patientId: t.patientId,
    });
    const args = {
      clinicId: t.clinicId,
      appointmentId: original.appointment.id,
      actor: { kind: "patient" } as const,
    };
    await t.scheduler.cancel(args);
    await expect(t.scheduler.cancel(args)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("cannot touch another clinic's appointment", async () => {
    const a = await createSchedulingTenant(h, "cancel-a");
    const b = await createSchedulingTenant(h, "cancel-b");
    const theirs = await b.scheduler.book({
      clinicId: b.clinicId,
      holdId: await hold(b, 0),
      patientId: b.patientId,
    });

    await expect(
      a.scheduler.cancel({
        clinicId: a.clinicId,
        appointmentId: theirs.appointment.id,
        actor: { kind: "staff", staffUserId: "usr_x" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await appointmentStatus(h, b.clinicId, theirs.appointment.id)).toBe("booked");
  });
});
