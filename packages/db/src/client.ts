import { AppError } from "@sema/shared";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema/index.js";
import { createWithTenant, type TenantPool, type WithTenant } from "./with-tenant.js";

/**
 * Lazy Postgres wiring.
 *
 * Nothing connects at import time: importing `@sema/db` must be free so unit
 * tests, `--help` paths and the inbox build never need a live database.
 * The pool is created on first use and reused afterwards.
 */

let pool: pg.Pool | undefined;
let db: NodePgDatabase<typeof schema> | undefined;
let withTenantFn: WithTenant | undefined;

function databaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new AppError("INTERNAL", "DATABASE_URL is not set.", { expose: false });
  }
  return url;
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: databaseUrl(),
      // Keep well under managed-Postgres connection caps; the API and each
      // worker process get their own pool.
      max: Number(process.env["DATABASE_POOL_MAX"] ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // A stuck statement must not hold a tenant transaction open.
      statement_timeout: 15_000,
    });
  }
  return pool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!db) {
    db = drizzle(getPool(), { schema });
  }
  return db;
}

/**
 * `withTenant(clinicId, fn)` — the only sanctioned way to touch tenant data
 * (CLAUDE.md §Conventions).
 */
export const withTenant: WithTenant = (clinicId, work) => {
  if (!withTenantFn) {
    withTenantFn = createWithTenant(getPool() as unknown as TenantPool);
  }
  return withTenantFn(clinicId, work);
};

/** Close the pool on shutdown. Safe to call when nothing ever connected. */
export async function closeDb(): Promise<void> {
  const current = pool;
  pool = undefined;
  db = undefined;
  withTenantFn = undefined;
  if (current) await current.end();
}
