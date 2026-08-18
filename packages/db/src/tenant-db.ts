import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type pg from "pg";

import * as schema from "./schema/index.js";
import { createWithTenant, type TenantClient, type TenantPool } from "./with-tenant.js";

/**
 * `withTenant`, but the callback gets a Drizzle instance instead of a raw
 * client.
 *
 * Same transaction, same `set_config('app.current_clinic', …, true)`, so RLS
 * applies exactly as it does for raw SQL — this is sugar, not a second door.
 * Everything that touches tenant data should go through one of the two.
 */

export type TenantDb = NodePgDatabase<typeof schema>;

export type TenantDbWork<T> = (db: TenantDb) => Promise<T>;

export interface WithTenantDb {
  <T>(clinicId: string, work: TenantDbWork<T>): Promise<T>;
}

/** Bind a `withTenantDb` to a pool (or anything shaped like one). */
export function createWithTenantDb(pool: TenantPool): WithTenantDb {
  const withTenant = createWithTenant(pool);
  return function withTenantDb<T>(clinicId: string, work: TenantDbWork<T>): Promise<T> {
    return withTenant(clinicId, (client: TenantClient) =>
      // The client is a real pg PoolClient; `TenantClient` is the narrow
      // structural interface with-tenant.ts uses so it can be unit-tested
      // without Postgres.
      work(drizzle(client as unknown as pg.Client, { schema })),
    );
  };
}
