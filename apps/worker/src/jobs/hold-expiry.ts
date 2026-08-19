import { getPool } from "@sema/db";
import { defaultScheduler } from "@sema/scheduling";

import { QUEUE_NAMES, getQueue } from "../queues.js";

/**
 * Hold expiry — housekeeping for `slot_hold`.
 *
 * The exclusion constraint on `slot_hold` is unconditional: Postgres will not
 * accept the `where (expires_at > now())` predicate the data model sketches,
 * because an index predicate must be IMMUTABLE (packages/db/README.md). So
 * "expired" is expressed by deleting the row.
 *
 * Nothing depends on this job for **correctness** — slot search ignores
 * expired holds, and `holdSlot()` clears a provider's expired holds inside the
 * transaction that inserts the new one. It exists so the table does not grow
 * without bound, which is why a minute of drift is fine and why a failed run
 * is not an incident.
 */

/** Job name. Stable: renaming it orphans the repeatable job already in Redis. */
export const HOLD_EXPIRY_JOB = "hold.expiry";

/** Every minute. Holds live for ten (`HOLD_TTL_MINUTES`). */
export const HOLD_EXPIRY_EVERY_MS = 60_000;

/**
 * The clinics to sweep.
 *
 * The one cross-tenant read in this path, and deliberately outside
 * `@sema/scheduling` — that package never reads across tenants
 * (ARCHITECTURE.md §3: system jobs "iterate clinics and call `withTenant` per
 * clinic"). It follows that the worker's database role must be able to read
 * `clinic`; under the `tenant_isolation` policy an ordinary `sema_app`
 * connection with no `app.current_clinic` set sees no rows, and the sweep
 * becomes a no-op rather than an error.
 */
export async function listClinicIds(): Promise<string[]> {
  const result = await getPool().query<{ id: string }>(
    "select id from clinic where deleted_at is null",
  );
  return result.rows.map((row) => row.id);
}

export interface HoldExpiryReport {
  clinics: number;
  deleted: number;
}

/** Sweep every clinic. Idempotent: a second run in the same minute deletes 0. */
export async function runHoldExpiry(): Promise<HoldExpiryReport> {
  const clinicIds = await listClinicIds();
  if (clinicIds.length === 0) return { clinics: 0, deleted: 0 };
  const scheduler = await defaultScheduler();
  return scheduler.expireHolds({ clinicIds });
}

/**
 * Schedule the repeatable job on the `system` queue.
 *
 * BullMQ keys a repeatable job by name plus repeat options, so calling this on
 * every worker boot — including several replicas — leaves exactly one
 * schedule.
 */
export async function registerHoldExpiry(): Promise<void> {
  await getQueue(QUEUE_NAMES.system).add(
    HOLD_EXPIRY_JOB,
    {},
    { repeat: { every: HOLD_EXPIRY_EVERY_MS } },
  );
}
