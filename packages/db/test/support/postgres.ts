import { newId, type PrefixedId } from "@sema/shared";
import pg from "pg";

import { runMigrations } from "../../src/migrate.js";
import { createWithTenant, type TenantClient } from "../../src/with-tenant.js";

/**
 * Integration-test harness: a real Postgres 16, migrated, with a way to run
 * statements as an unprivileged role.
 *
 * Why the role matters: **superusers bypass RLS**, force or no force. The
 * docker-compose user and the CI service user are both superusers, so a naive
 * cross-tenant test would pass against a database with no policies at all.
 * Every isolation assertion here runs through `asApp()`, which does
 * `set local role` to a role with no special attributes — the same position the
 * production `sema_app` role is in (ARCHITECTURE.md §3).
 *
 * Where the database comes from:
 *   1. `DATABASE_URL` / `TEST_DATABASE_URL` when set (CI service container),
 *   2. otherwise the local `docker compose up -d postgres` default,
 *   3. otherwise the suites skip with a message. `pnpm test` (unit) never
 *      needs any of this.
 */

const LOCAL_COMPOSE_URL = "postgres://sema:sema@localhost:5432/sema";
const PROBE_ROLE = "sema_rls_probe";

export interface Harness {
  url: string;
  pool: pg.Pool;
  /** Run `work` in a tenant transaction, as the unprivileged probe role. */
  asApp<T>(clinicId: string, work: (client: TenantClient) => Promise<T>): Promise<T>;
  /** Run `work` in a tenant transaction as the connecting (owner) role. */
  asOwner<T>(clinicId: string, work: (client: TenantClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

async function resolveUrl(): Promise<string | undefined> {
  const explicit = process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  if (explicit) {
    if (await canConnect(explicit)) return explicit;
    throw new Error(
      "DATABASE_URL is set but no Postgres answered on it. Integration tests will not silently skip a configured database.",
    );
  }
  return (await canConnect(LOCAL_COMPOSE_URL)) ? LOCAL_COMPOSE_URL : undefined;
}

let cached: Promise<Harness | undefined> | undefined;

/**
 * One harness per test *process*. The integration vitest project runs single
 * threaded with isolation off, so both suites share this module and one
 * migrated database.
 */
export function getHarness(): Promise<Harness | undefined> {
  cached ??= build();
  return cached;
}

async function build(): Promise<Harness | undefined> {
  const url = await resolveUrl();
  if (!url) {
    console.warn(
      [
        "",
        "[sema] Skipping integration tests: no Postgres available.",
        "       Start one with `docker compose up -d postgres`, or set DATABASE_URL.",
        "       Unit tests (`pnpm test`) cover everything that does not need a database.",
        "",
      ].join("\n"),
    );
    return undefined;
  }

  await runMigrations(url);

  // So `@sema/db`'s own lazy pool (and therefore the seed) points at the same
  // database the harness resolved, even when only the compose default existed.
  process.env["DATABASE_URL"] = url;

  const pool = new pg.Pool({ connectionString: url, max: 5 });

  // An ordinary role with no attributes: not a superuser, no BYPASSRLS, not
  // the table owner. Created here rather than in a migration because roles are
  // cluster-level environment setup (see packages/db/README.md).
  await pool.query(`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = '${PROBE_ROLE}') then
        create role ${PROBE_ROLE} nologin;
      end if;
    end
    $$;
  `);
  await pool.query(`grant usage on schema public to ${PROBE_ROLE}`);
  await pool.query(
    `grant select, insert, update, delete on all tables in schema public to ${PROBE_ROLE}`,
  );
  // `set role` requires membership unless we are a superuser; granting is
  // harmless when we already are.
  await pool.query(`grant ${PROBE_ROLE} to current_user`).catch(() => undefined);

  const withTenant = createWithTenant(pool as unknown as Parameters<typeof createWithTenant>[0]);

  return {
    url,
    pool,
    asOwner: (clinicId, work) => withTenant(clinicId, work),
    asApp: (clinicId, work) =>
      withTenant(clinicId, async (client) => {
        // LOCAL: reverts at commit/rollback, so the pooled connection goes
        // back to the pool as itself.
        await client.query(`set local role ${PROBE_ROLE}`);
        return work(client);
      }),
    close: async () => {
      await pool.end();
    },
  };
}

export interface TenantFixture {
  clinicId: PrefixedId<"clinic">;
  locationId: PrefixedId<"location">;
  providerId: PrefixedId<"provider">;
  serviceId: PrefixedId<"service">;
  patientId: PrefixedId<"patient">;
  conversationId: PrefixedId<"conversation">;
}

/**
 * A minimal, throwaway tenant: clinic → location → provider → service →
 * patient → conversation. Written as the owner (superuser in CI), because the
 * point of these tests is what the *app* role can read afterwards.
 */
export async function createTenant(harness: Harness, label: string): Promise<TenantFixture> {
  const fixture: TenantFixture = {
    clinicId: newId("clinic"),
    locationId: newId("location"),
    providerId: newId("provider"),
    serviceId: newId("service"),
    patientId: newId("patient"),
    conversationId: newId("conversation"),
  };

  const client = await harness.pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into clinic (id, name, slug, timezone, currency) values ($1, $2, $3, 'Africa/Nairobi', 'KES')`,
      [fixture.clinicId, `Test ${label}`, `test-${label}-${fixture.clinicId.slice(-8)}`],
    );
    await client.query(`insert into location (id, clinic_id, name) values ($1, $2, $3)`, [
      fixture.locationId,
      fixture.clinicId,
      `${label} clinic`,
    ]);
    await client.query(`insert into provider (id, clinic_id, display_name) values ($1, $2, $3)`, [
      fixture.providerId,
      fixture.clinicId,
      `Dr. ${label}`,
    ]);
    await client.query(
      `insert into service (id, clinic_id, name, duration_min, price_minor, deposit_minor)
       values ($1, $2, 'Consultation', 20, 200000, 0)`,
      [fixture.serviceId, fixture.clinicId],
    );
    await client.query(
      `insert into patient (id, clinic_id, phone_e164, full_name) values ($1, $2, $3, $4)`,
      [
        fixture.patientId,
        fixture.clinicId,
        // Fake, valid-format Kenyan number, unique per fixture.
        `+2547${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
        `${label} patient`,
      ],
    );
    await client.query(`insert into conversation (id, clinic_id, patient_id) values ($1, $2, $3)`, [
      fixture.conversationId,
      fixture.clinicId,
      fixture.patientId,
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return fixture;
}

/** `[start, end)` tstzrange literal, minutes from a fixed future instant. */
export function slot(startMinutes: number, endMinutes: number): string {
  const base = Date.UTC(2030, 0, 7, 6, 0, 0); // Monday 09:00 Africa/Nairobi
  const at = (m: number) => new Date(base + m * 60_000).toISOString();
  return `[${at(startMinutes)},${at(endMinutes)})`;
}
