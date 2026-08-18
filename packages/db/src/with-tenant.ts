import { AppError, isId, type PrefixedId } from "@sema/shared";

/**
 * Tenant-scoped database access.
 *
 * ARCHITECTURE.md §3: "App connects with role `sema_app` (no BYPASSRLS).
 * `withTenant(clinicId, fn)` runs `set_config('app.current_clinic', $1, true)`
 * inside a transaction."
 *
 * The `true` third argument makes the setting *transaction-local*, so a pooled
 * connection can never leak one clinic's tenant context into the next
 * checkout. That is the single most important line in this file.
 *
 * Everything here is defined against structural interfaces rather than `pg`
 * classes so the transaction semantics can be unit-tested with a fake client,
 * without Postgres running.
 */

export type ClinicId = PrefixedId<"clinic">;

/** The subset of `pg.ClientBase` this module needs. */
export interface TenantClient {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** A pooled client, plus the release hook. */
export interface PooledTenantClient extends TenantClient {
  release(err?: boolean): void;
}

/** The subset of `pg.Pool` this module needs. */
export interface TenantPool {
  connect(): Promise<PooledTenantClient>;
}

export type TenantWork<T> = (client: TenantClient) => Promise<T>;

export interface WithTenant {
  <T>(clinicId: string, work: TenantWork<T>): Promise<T>;
}

const SET_TENANT_SQL = "select set_config('app.current_clinic', $1, true)";

/**
 * Build a `withTenant` bound to a pool. Every statement inside `work` runs in
 * one transaction with `app.current_clinic` set, so RLS policies apply.
 *
 * Rolls back and rethrows on any error; the connection is always released.
 */
export function createWithTenant(pool: TenantPool): WithTenant {
  return async function withTenant<T>(clinicId: string, work: TenantWork<T>): Promise<T> {
    // Refuse to open a tenant transaction for anything that is not a clinic
    // id. Without this, a bug passing `undefined` would set the GUC to an
    // empty string and every policy would silently match nothing — or worse,
    // a caller could pass a crafted value.
    if (!isId("clinic", clinicId)) {
      throw new AppError("TENANT_MISSING", "A valid clinic id is required for database access.");
    }

    const client = await pool.connect();
    let released = false;

    try {
      await client.query("begin");
      await client.query(SET_TENANT_SQL, [clinicId]);
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // The connection is already broken; releasing it with an error below
        // removes it from the pool. Nothing useful to report here, and the
        // original error is the one the caller needs.
        client.release(true);
        released = true;
      }
      throw AppError.from(error);
    } finally {
      if (!released) client.release();
    }
  };
}

/**
 * Assert that a row belongs to the clinic we are acting for. RLS is the real
 * guard; this catches our own bugs in code paths that join across tenants.
 */
export function assertSameTenant(expected: ClinicId, actual: string | null | undefined): void {
  if (actual !== expected) {
    throw new AppError("TENANT_MISMATCH", "Record does not belong to this clinic.");
  }
}
