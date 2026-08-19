import { createWithTenant, runMigrations, type TenantClient, type WithTenant } from "@sema/db";
import { newId, type PrefixedId } from "@sema/shared";
import pg from "pg";

/**
 * Integration-test harness: a real, migrated Postgres 16.
 *
 * Deliberately built on `@sema/db`'s *public* exports (`runMigrations`,
 * `createWithTenant`) rather than reaching into `packages/db/test/support`.
 * A worker test that needed a relative path into another package's test
 * directory would be a sign the seam is in the wrong place.
 *
 * Where the database comes from, in order:
 *   1. `TEST_DATABASE_URL` / `DATABASE_URL` (CI service container),
 *   2. the local `docker compose up -d postgres` default,
 *   3. otherwise the suite skips with a message. `pnpm test` never needs any
 *      of this — it is unit tests only.
 */

const LOCAL_COMPOSE_URL = "postgres://sema:sema@localhost:5432/sema";

export interface Harness {
  url: string;
  pool: pg.Pool;
  withTenant: WithTenant;
  /** Run something as the connecting role, outside any tenant context. */
  raw<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T>;
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
        "[sema] Skipping worker integration tests: no Postgres available.",
        "       Start one with `docker compose up -d postgres`, or set DATABASE_URL.",
        "       Unit tests (`pnpm test`) cover everything that does not need a database.",
        "",
      ].join("\n"),
    );
    return undefined;
  }

  await runMigrations(url);
  process.env["DATABASE_URL"] = url;

  const pool = new pg.Pool({ connectionString: url, max: 5 });

  return {
    url,
    pool,
    withTenant: createWithTenant(pool as unknown as Parameters<typeof createWithTenant>[0]),
    raw: async (work) => {
      const client = await pool.connect();
      try {
        return await work(client);
      } finally {
        client.release();
      }
    },
    close: async () => {
      await pool.end();
    },
  };
}

export interface TenantFixture {
  clinicId: PrefixedId<"clinic">;
  phoneNumberId: string;
  patientPhone: string;
}

/**
 * A throwaway clinic with a connected WhatsApp sender.
 *
 * The `phone_number_id` is unique per fixture so tests cannot route into each
 * other's data, and the token is a placeholder — no test here talks to Meta.
 */
export async function createTenant(harness: Harness, label: string): Promise<TenantFixture> {
  const clinicId = newId("clinic");
  const suffix = String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  const fixture: TenantFixture = {
    clinicId,
    phoneNumberId: `pnid-${label}-${suffix}`,
    patientPhone: `+2547${suffix}`,
  };

  await harness.raw(async (client) => {
    await client.query("begin");
    try {
      await client.query(
        `insert into clinic (id, name, slug, timezone, currency)
         values ($1, $2, $3, 'Africa/Nairobi', 'KES')`,
        [clinicId, `Test ${label}`, `test-${label}-${clinicId.slice(-8)}`],
      );
      await client.query(
        `insert into clinic_whatsapp
           (id, clinic_id, waba_id, phone_number_id, display_phone_number, access_token_encrypted)
         values ($1, $2, $3, $4, '+254700000000', 'placeholder-token')`,
        [newId("clinicWhatsapp"), clinicId, `waba-${suffix}`, fixture.phoneNumberId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });

  return fixture;
}

/** Read rows inside the tenant transaction, for assertions. */
export async function tenantRows<R>(
  harness: Harness,
  clinicId: string,
  sql: string,
  params: unknown[] = [],
): Promise<R[]> {
  return harness.withTenant(clinicId, async (client: TenantClient) => {
    const result = (await client.query(sql, params)) as { rows: R[] };
    return result.rows;
  });
}
