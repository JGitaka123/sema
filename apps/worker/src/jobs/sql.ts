import type { TenantClient } from "@sema/db";

/**
 * `TenantClient.query` is typed `Promise<unknown>` on purpose — `with-tenant.ts`
 * keeps it structural so the transaction semantics can be unit tested against
 * a fake. Jobs need the rows back, so the narrowing happens once, here, rather
 * than as a cast at every call site.
 */
export async function rows<R>(
  client: TenantClient,
  sql: string,
  params: unknown[] = [],
): Promise<R[]> {
  const result = (await client.query(sql, params)) as { rows?: R[] } | undefined;
  return result?.rows ?? [];
}

/** The first row, or undefined. */
export async function row<R>(
  client: TenantClient,
  sql: string,
  params: unknown[] = [],
): Promise<R | undefined> {
  return (await rows<R>(client, sql, params))[0];
}
