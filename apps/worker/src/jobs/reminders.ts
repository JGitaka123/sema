import { withTenant, type WithTenant } from "@sema/db";
import { systemClock, type Clock, type PrefixedId } from "@sema/shared";

import {
  markNoShows,
  runClinicDigests,
  sendDueReminders,
  syncAppointmentReminders,
  REMINDER_SYNC_HORIZON_HOURS,
  type DigestDelivery,
  type JobLogger,
} from "../reminders/index.js";
import { listAppointmentsToSync } from "../reminders/repository.js";
import { QUEUE_NAMES, getQueue } from "../queues.js";
import { listClinicIds } from "./hold-expiry.js";
import { publishOutbox } from "./publish.js";

/**
 * The Phase 7 scheduled jobs.
 *
 * Four sweeps, all on the shared `system` queue and all addressed by job name,
 * exactly as `hold.expiry` is — a queue per job would multiply BullMQ consumers
 * for work that is a few statements a minute.
 *
 * Every one of them is idempotent by construction rather than by job key:
 * `reminder.send` claims rows with `for update skip locked` and leaves them in
 * a terminal status, `appointment.no_show` can only claim a `booked`-ish row
 * once, `reminder.sync` recomputes a desired state, and the digests hold an
 * advisory lock and check `audit_log`. A duplicated BullMQ delivery is
 * therefore harmless, which matters because a repeatable job is delivered at
 * least once, not exactly once.
 *
 * **Cross-tenant enumeration** goes through `listClinicIds` from
 * `hold-expiry.ts` — the one place in the worker that reads across tenants
 * (ARCHITECTURE.md §3), and therefore the one place a role decision has to be
 * made. Under the `tenant_isolation` policy an `sema_app` connection with no
 * `app.current_clinic` set sees no clinics and every sweep silently becomes a
 * no-op; the deployment must grant the worker's role a read of `clinic` (or run
 * it as `sema_system`) for any of this to do anything.
 */

/** Job names. Stable strings: renaming one orphans the schedule in Redis. */
export const REMINDER_SEND_JOB = "reminder.send";
export const REMINDER_SYNC_JOB = "reminder.sync";
export const NO_SHOW_SWEEP_JOB = "appointment.no_show";
export const DIGEST_SWEEP_JOB = "digest.sweep";

/** A reminder due at 09:00 should not land at 09:05. */
export const REMINDER_SEND_EVERY_MS = 60_000;
/** Reconciliation is housekeeping; the 24h offset gives it hours of slack. */
export const REMINDER_SYNC_EVERY_MS = 5 * 60_000;
/** The grace period is 30 min, so five is well inside the resolution we owe. */
export const NO_SHOW_EVERY_MS = 5 * 60_000;
/** Each clinic checks its own local hour, so hourly is the finest useful grain. */
export const DIGEST_EVERY_MS = 60 * 60_000;

/** How many appointments one clinic's reconciler looks at per pass. */
export const SYNC_BATCH_LIMIT = 500;

export interface SweepDeps {
  readonly withTenant: WithTenant;
  readonly clock: Clock;
  readonly listClinicIds: () => Promise<string[]>;
  readonly publish?: (clinicId: PrefixedId<"clinic">, outboxId: string) => Promise<void>;
  readonly delivery?: DigestDelivery;
  readonly log?: JobLogger;
}

/** Production wiring. Lazy: importing this module must not open a socket. */
export function defaultSweepDeps(overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    withTenant,
    clock: systemClock,
    listClinicIds,
    publish: publishOutbox,
    ...overrides,
  };
}

export interface SweepReport {
  readonly clinics: number;
  readonly sent?: number;
  readonly skipped?: number;
  readonly marked?: number;
  readonly nudged?: number;
  readonly created?: number;
  readonly cancelled?: number;
  readonly digests?: number;
}

// ── reminder.send ────────────────────────────────────────────────────────────

/**
 * Send every reminder that has come due, clinic by clinic.
 *
 * `publishOutbox` is called **after** the tenant transaction commits, never
 * inside it: a delivery worker that picked the job up first would find no row,
 * or worse, find one that is then rolled back.
 */
export async function runReminderSend(deps: SweepDeps = defaultSweepDeps()): Promise<SweepReport> {
  const clinicIds = await deps.listClinicIds();
  let sent = 0;
  let skipped = 0;

  for (const clinicId of clinicIds) {
    const report = await sendDueReminders(
      {
        withTenant: deps.withTenant,
        now: () => deps.clock.now(),
        ...(deps.log ? { log: deps.log } : {}),
      },
      { clinicId: clinicId as PrefixedId<"clinic"> },
    );
    sent += report.sent;
    skipped += report.skipped;

    if (deps.publish) {
      for (const outboxId of report.outboxIds) {
        await deps.publish(clinicId as PrefixedId<"clinic">, outboxId);
      }
    }
  }

  return { clinics: clinicIds.length, sent, skipped };
}

// ── reminder.sync ────────────────────────────────────────────────────────────

/**
 * Re-derive reminders for every appointment in the near window.
 *
 * The safety net under the direct call in `syncAppointmentReminders`: whoever
 * books, moves or cancels an appointment *should* reconcile it in their own
 * transaction, but a staff edit from the inbox, a payment confirmation or a
 * missed call site would otherwise leave a patient un-reminded. Recomputing a
 * desired state is cheap and cannot go wrong twice.
 */
export async function runReminderSync(deps: SweepDeps = defaultSweepDeps()): Promise<SweepReport> {
  const clinicIds = await deps.listClinicIds();
  const now = deps.clock.now();
  // One hour back, so an appointment that has only just started still has its
  // stale reminders retired.
  const from = new Date(now.getTime() - 60 * 60_000);
  const to = new Date(now.getTime() + REMINDER_SYNC_HORIZON_HOURS * 60 * 60_000);

  let created = 0;
  let cancelled = 0;

  for (const clinicId of clinicIds) {
    await deps.withTenant(clinicId, async (client) => {
      const appointmentIds = await listAppointmentsToSync(
        client,
        clinicId,
        from,
        to,
        SYNC_BATCH_LIMIT,
      );
      for (const appointmentId of appointmentIds) {
        const result = await syncAppointmentReminders(client, { clinicId, appointmentId, now });
        created += result.created;
        cancelled += result.cancelled;
      }
    });
  }

  return { clinics: clinicIds.length, created, cancelled };
}

// ── appointment.no_show ──────────────────────────────────────────────────────

export async function runNoShowSweep(deps: SweepDeps = defaultSweepDeps()): Promise<SweepReport> {
  const clinicIds = await deps.listClinicIds();
  let marked = 0;
  let nudged = 0;

  for (const clinicId of clinicIds) {
    const report = await markNoShows(
      {
        withTenant: deps.withTenant,
        now: () => deps.clock.now(),
        ...(deps.log ? { log: deps.log } : {}),
      },
      { clinicId: clinicId as PrefixedId<"clinic"> },
    );
    marked += report.marked;
    nudged += report.nudged;
  }

  return { clinics: clinicIds.length, marked, nudged };
}

// ── digest.sweep ─────────────────────────────────────────────────────────────

export async function runDigestSweep(deps: SweepDeps = defaultSweepDeps()): Promise<SweepReport> {
  const clinicIds = await deps.listClinicIds();
  let digests = 0;

  for (const clinicId of clinicIds) {
    const report = await runClinicDigests(
      {
        withTenant: deps.withTenant,
        now: () => deps.clock.now(),
        ...(deps.delivery ? { delivery: deps.delivery } : {}),
        ...(deps.log ? { log: deps.log } : {}),
      },
      { clinicId: clinicId as PrefixedId<"clinic"> },
    );
    digests += report.sent.length;
  }

  return { clinics: clinicIds.length, digests };
}

// ── Registration ─────────────────────────────────────────────────────────────

/** The job name → handler map the worker dispatches on. */
export const SYSTEM_JOB_HANDLERS: Readonly<Record<string, () => Promise<SweepReport>>> = {
  [REMINDER_SEND_JOB]: () => runReminderSend(),
  [REMINDER_SYNC_JOB]: () => runReminderSync(),
  [NO_SHOW_SWEEP_JOB]: () => runNoShowSweep(),
  [DIGEST_SWEEP_JOB]: () => runDigestSweep(),
};

const SCHEDULE: ReadonlyArray<readonly [string, number]> = [
  [REMINDER_SEND_JOB, REMINDER_SEND_EVERY_MS],
  [REMINDER_SYNC_JOB, REMINDER_SYNC_EVERY_MS],
  [NO_SHOW_SWEEP_JOB, NO_SHOW_EVERY_MS],
  [DIGEST_SWEEP_JOB, DIGEST_EVERY_MS],
];

/**
 * Register the repeatable jobs.
 *
 * BullMQ keys a repeatable job by name plus repeat options, so calling this on
 * every boot — including from several replicas — leaves exactly one schedule
 * per job, the same property `registerHoldExpiry` relies on.
 */
export async function registerReminderJobs(): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.system);
  for (const [name, every] of SCHEDULE) {
    await queue.add(name, {}, { repeat: { every } });
  }
}
