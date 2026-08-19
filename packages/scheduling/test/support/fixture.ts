import { createWithTenantDb, type TenantPool, type WithTenantDb } from "@sema/db";
import { fixedClock, newId, type PrefixedId } from "@sema/shared";

import {
  createTenant,
  getHarness,
  type Harness,
  type TenantFixture,
} from "../../../db/test/support/postgres.js";
import { createScheduler, type Scheduler, type SchedulingDeps } from "../../src/index.js";

/**
 * Integration fixtures for `@sema/scheduling`.
 *
 * The Postgres harness itself is `packages/db/test/support/postgres.ts`,
 * imported rather than re-implemented: one migration run, one probe role, one
 * definition of "no database → skip cleanly". Only the scheduling-shaped
 * fixture data (provider_service, availability rules, a deposit service) lives
 * here.
 */

export { getHarness, type Harness };

/**
 * Saturday 2030-01-05, midday UTC.
 *
 * 42 hours before `MONDAY_0900`, i.e. outside the fixture clinic's 24-hour
 * free-reschedule window — so a policy decision is only `fee` or `forfeit`
 * when a test deliberately travels closer with `schedulerAt`.
 */
export const CLOCK_NOW = new Date("2030-01-05T12:00:00Z");
/** Monday 2030-01-07, 09:00 Africa/Nairobi. */
export const MONDAY_0900 = new Date("2030-01-07T06:00:00Z");

const PROBE_ROLE = "sema_rls_probe";

/**
 * A `withTenantDb` that runs as an unprivileged role.
 *
 * Superusers bypass RLS, and both the CI service user and the docker-compose
 * user are superusers — so a scheduling test that ran as the owner would pass
 * against a database with no policies at all. Every statement these tests make
 * therefore runs in the same position as production's `sema_app`.
 *
 * The role switch is issued immediately after `begin`, before `withTenant`
 * sets `app.current_clinic`, and `set local` reverts it at commit so the
 * pooled connection returns to the pool as itself.
 */
export function appTenantDb(harness: Harness): WithTenantDb {
  const pool: TenantPool = {
    async connect() {
      const client = await harness.pool.connect();
      let switched = false;
      return {
        async query(text: unknown, params?: unknown[]) {
          const result = await (
            client.query as unknown as (t: unknown, p?: unknown[]) => Promise<unknown>
          )(text, params);
          if (!switched && text === "begin") {
            switched = true;
            await client.query(`set local role ${PROBE_ROLE}`);
          }
          return result;
        },
        release: (err?: boolean) => client.release(err),
      };
    },
  };
  return createWithTenantDb(pool);
}

export interface SchedulingFixture extends TenantFixture {
  /** A second provider offering the same service — the load-balance case. */
  secondProviderId: PrefixedId<"provider">;
  /** `duration 20, buffer 0, deposit 0`, from the shared tenant fixture. */
  serviceId: PrefixedId<"service">;
  /** `duration 30, buffer 15, deposit KES 1 000` — the pending_deposit path. */
  depositServiceId: PrefixedId<"service">;
  deps: SchedulingDeps;
  scheduler: Scheduler;
}

/**
 * A clinic that can actually be booked: two providers, both offering both
 * services, working Monday–Saturday 09:00–17:00 Africa/Nairobi.
 */
export async function createSchedulingTenant(
  harness: Harness,
  label: string,
): Promise<SchedulingFixture> {
  const base = await createTenant(harness, label);
  const secondProviderId = newId("provider");
  const depositServiceId = newId("service");

  await harness.asOwner(base.clinicId, async (client) => {
    await client.query(
      `insert into provider (id, clinic_id, display_name, sort) values ($1, $2, $3, 2)`,
      [secondProviderId, base.clinicId, `Dr. ${label} II`],
    );
    await client.query(
      `insert into service (id, clinic_id, name, duration_min, buffer_min, price_minor, deposit_minor)
       values ($1, $2, 'Scan', 30, 15, 500000, 100000)`,
      [depositServiceId, base.clinicId],
    );

    for (const providerId of [base.providerId, secondProviderId]) {
      for (const serviceId of [base.serviceId, depositServiceId]) {
        await client.query(
          `insert into provider_service (clinic_id, provider_id, service_id) values ($1, $2, $3)`,
          [base.clinicId, providerId, serviceId],
        );
      }
      // Monday–Saturday, 09:00–17:00 clinic-local.
      for (let weekday = 1; weekday <= 6; weekday += 1) {
        await client.query(
          `insert into availability_rule
             (id, clinic_id, provider_id, location_id, weekday, start_local, end_local)
           values ($1, $2, $3, $4, $5, '09:00', '17:00')`,
          [newId("availabilityRule"), base.clinicId, providerId, base.locationId, weekday],
        );
      }
    }

    await client.query(
      `update clinic
          set cancellation_policy = '{"free_reschedule_hours":24,"forfeit_hours":2}'::jsonb
        where id = $1`,
      [base.clinicId],
    );
  });

  const deps: SchedulingDeps = {
    withTenantDb: appTenantDb(harness),
    clock: fixedClock(CLOCK_NOW),
  };

  return {
    ...base,
    secondProviderId,
    depositServiceId,
    deps,
    scheduler: createScheduler(deps),
  };
}

/**
 * The same tenant, seen from a different moment. Policy windows are the only
 * thing in this package that depends on the wall clock, so time travel is how
 * "one hour before the appointment" is tested without waiting.
 */
export function schedulerAt(fixture: SchedulingFixture, now: Date): Scheduler {
  return createScheduler({ withTenantDb: fixture.deps.withTenantDb, clock: fixedClock(now) });
}

/** Read helper: the current status of an appointment, as the owner. */
export async function appointmentStatus(
  harness: Harness,
  clinicId: string,
  appointmentId: string,
): Promise<string | undefined> {
  const result = (await harness.asOwner(clinicId, (client) =>
    client.query(`select status from appointment where id = $1`, [appointmentId]),
  )) as { rows: Array<{ status: string }> };
  return result.rows[0]?.status;
}

/** Read helper: how many holds exist for a clinic right now. */
export async function countHolds(harness: Harness, clinicId: string): Promise<number> {
  const result = (await harness.asOwner(clinicId, (client) =>
    client.query(`select count(*)::int as total from slot_hold where clinic_id = $1`, [clinicId]),
  )) as { rows: Array<{ total: number }> };
  return result.rows[0]?.total ?? 0;
}

/** Read helper: audit rows for one entity, newest first. */
export async function auditRows(
  harness: Harness,
  clinicId: string,
  entityId: string,
): Promise<Array<{ action: string; actor: string; reason: string | null }>> {
  const result = (await harness.asOwner(clinicId, (client) =>
    client.query(
      `select action, actor, reason from audit_log
        where clinic_id = $1 and entity_id = $2 order by at desc`,
      [clinicId, entityId],
    ),
  )) as { rows: Array<{ action: string; actor: string; reason: string | null }> };
  return result.rows;
}

/** Insert a hold that is already expired, to exercise the expiry paths. */
export async function insertExpiredHold(
  harness: Harness,
  fixture: SchedulingFixture,
  start: Date,
  durationMin: number,
): Promise<string> {
  const holdId = newId("slotHold");
  const end = new Date(start.getTime() + durationMin * 60_000);
  await harness.asOwner(fixture.clinicId, (client) =>
    client.query(
      `insert into slot_hold (id, clinic_id, provider_id, service_id, patient_id, slot, expires_at)
       values ($1, $2, $3, $4, $5, $6::tstzrange, now() - interval '1 minute')`,
      [
        holdId,
        fixture.clinicId,
        fixture.providerId,
        fixture.serviceId,
        fixture.patientId,
        `[${start.toISOString()},${end.toISOString()})`,
      ],
    ),
  );
  return holdId;
}
