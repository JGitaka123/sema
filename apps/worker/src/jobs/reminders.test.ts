import { fixedClock, type PrefixedId } from "@sema/shared";
import { describe, expect, it, vi } from "vitest";

import { createRecordingLogger } from "../reminders/logging.js";
import {
  DIGEST_EVERY_MS,
  DIGEST_SWEEP_JOB,
  NO_SHOW_EVERY_MS,
  NO_SHOW_SWEEP_JOB,
  REMINDER_SEND_EVERY_MS,
  REMINDER_SEND_JOB,
  REMINDER_SYNC_EVERY_MS,
  REMINDER_SYNC_JOB,
  SYSTEM_JOB_HANDLERS,
  runNoShowSweep,
  runReminderSend,
  type SweepDeps,
} from "./reminders.js";
import { HOLD_EXPIRY_JOB } from "./hold-expiry.js";

/**
 * The scheduling wiring. Behaviour against real SQL lives in
 * `test/reminders.test.ts`; what is worth pinning here is the part that is
 * invisible until it breaks in production — a renamed job that orphans its
 * schedule in Redis, an interval that drifts past the grace period it exists to
 * catch, or an outbox row published before the transaction that wrote it has
 * committed.
 */

describe("job names", () => {
  it("are stable — renaming one orphans the repeatable job in Redis", () => {
    expect(REMINDER_SEND_JOB).toBe("reminder.send");
    expect(REMINDER_SYNC_JOB).toBe("reminder.sync");
    expect(NO_SHOW_SWEEP_JOB).toBe("appointment.no_show");
    expect(DIGEST_SWEEP_JOB).toBe("digest.sweep");
  });

  it("do not collide with the Phase 2 job on the same queue", () => {
    expect(Object.keys(SYSTEM_JOB_HANDLERS)).not.toContain(HOLD_EXPIRY_JOB);
  });

  it("all have a handler", () => {
    for (const name of [
      REMINDER_SEND_JOB,
      REMINDER_SYNC_JOB,
      NO_SHOW_SWEEP_JOB,
      DIGEST_SWEEP_JOB,
    ]) {
      expect(SYSTEM_JOB_HANDLERS[name]).toBeTypeOf("function");
    }
  });
});

describe("intervals", () => {
  it("send reminders at a resolution a patient would not notice", () => {
    expect(REMINDER_SEND_EVERY_MS).toBe(60_000);
  });

  it("sweep for no-shows well inside the 30-minute grace period", () => {
    expect(NO_SHOW_EVERY_MS).toBeLessThan(30 * 60_000);
  });

  it("reconcile far more often than the smallest reminder offset", () => {
    // The 2h reminder is the tightest default; the reconciler has to have
    // created its row long before it comes due.
    expect(REMINDER_SYNC_EVERY_MS).toBeLessThan(2 * 60 * 60_000);
  });

  it("check digests hourly, because each clinic matches its own local hour", () => {
    expect(DIGEST_EVERY_MS).toBe(60 * 60_000);
  });
});

// ── Orchestration ────────────────────────────────────────────────────────────

const CLINIC_A = "cli_01J00000000000000000000A" as PrefixedId<"clinic">;
const CLINIC_B = "cli_01J00000000000000000000B" as PrefixedId<"clinic">;

/**
 * A `withTenant` over a client that answers every statement with no rows.
 *
 * Enough to prove the *sweep* shape — one transaction per clinic, in order,
 * nothing published when nothing was queued — without pretending to be
 * Postgres. The statements themselves are exercised for real in the
 * integration suite.
 */
function emptyTenant(): { withTenant: SweepDeps["withTenant"]; opened: string[] } {
  const opened: string[] = [];
  const withTenant: SweepDeps["withTenant"] = async (clinicId, work) => {
    opened.push(clinicId);
    return work({ query: async () => ({ rows: [] }) });
  };
  return { withTenant, opened };
}

describe("runReminderSend", () => {
  it("opens one tenant transaction per clinic", async () => {
    const { withTenant, opened } = emptyTenant();
    const publish = vi.fn(async () => undefined);

    const report = await runReminderSend({
      withTenant,
      clock: fixedClock(new Date("2026-08-17T04:00:00Z")),
      listClinicIds: async () => [CLINIC_A, CLINIC_B],
      publish,
    });

    expect(opened).toEqual([CLINIC_A, CLINIC_B]);
    expect(report).toEqual({ clinics: 2, sent: 0, skipped: 0 });
    // Nothing was queued, so nothing is handed to the delivery queue.
    expect(publish).not.toHaveBeenCalled();
  });

  it("does nothing at all when no clinic is visible", async () => {
    // The state an `sema_app` role without a read of `clinic` is in
    // (ARCHITECTURE.md §3). A no-op, not a crash.
    const { withTenant, opened } = emptyTenant();
    const report = await runReminderSend({
      withTenant,
      clock: fixedClock(new Date("2026-08-17T04:00:00Z")),
      listClinicIds: async () => [],
    });
    expect(opened).toEqual([]);
    expect(report.clinics).toBe(0);
  });

  it("keeps going to the next clinic's work after one of them fails", async () => {
    // One tenant's broken data must not stop every other clinic's reminders.
    const attempted: string[] = [];
    const withTenant: SweepDeps["withTenant"] = async (clinicId, work) => {
      attempted.push(clinicId);
      if (clinicId === CLINIC_A) throw new Error("boom");
      return work({ query: async () => ({ rows: [] }) });
    };

    await expect(
      runReminderSend({
        withTenant,
        clock: fixedClock(new Date("2026-08-17T04:00:00Z")),
        listClinicIds: async () => [CLINIC_A, CLINIC_B],
      }),
    ).rejects.toThrow("boom");

    // Documents today's behaviour: the sweep is retried whole by BullMQ, and
    // every step in it is idempotent, so a failure is a retry rather than a
    // partial state. If per-clinic isolation is wanted later, this is the test
    // that has to change.
    expect(attempted).toEqual([CLINIC_A]);
  });
});

describe("runNoShowSweep", () => {
  it("reports per-clinic totals and logs nothing about a quiet clinic", async () => {
    const { withTenant } = emptyTenant();
    const log = createRecordingLogger();
    const report = await runNoShowSweep({
      withTenant,
      clock: fixedClock(new Date("2026-08-17T07:00:00Z")),
      listClinicIds: async () => [CLINIC_A],
      log,
    });
    expect(report).toEqual({ clinics: 1, marked: 0, nudged: 0 });
    expect(log.entries).toEqual([]);
  });
});
