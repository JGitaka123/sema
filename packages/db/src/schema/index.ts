/**
 * Drizzle schema — the whole of docs/DATA_MODEL.md.
 *
 * Rules for anyone adding a table here:
 *  1. Tenant tables carry `clinic_id` (use `clinicRef()`), `created_at`,
 *     `updated_at`.
 *  2. The migration that creates the table MUST enable + force row level
 *     security and create the `tenant_isolation` policy in the *same*
 *     migration (CLAUDE.md hard rule 8). `rls-coverage.test.ts` fails the
 *     build if you forget, without needing a database.
 *  3. Money is `bigint` minor units, time is `timestamptz` UTC, ids are
 *     prefixed ULIDs stored whole (`pat_01J…`).
 */

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

export * from "./columns.js";
export * from "./enums.js";
export * from "./tenancy.js";
export * from "./staff.js";
export * from "./catalog.js";
export * from "./availability.js";
export * from "./patients.js";
export * from "./conversations.js";
export * from "./scheduling.js";
export * from "./payments.js";
export * from "./knowledge.js";
export * from "./ops.js";
export * from "./phase3.js";

import * as availability from "./availability.js";
import * as catalog from "./catalog.js";
import * as conversations from "./conversations.js";
import * as knowledge from "./knowledge.js";
import * as ops from "./ops.js";
import * as patients from "./patients.js";
import * as payments from "./payments.js";
import * as phase3 from "./phase3.js";
import * as scheduling from "./scheduling.js";
import * as staff from "./staff.js";
import * as tenancy from "./tenancy.js";

const modules = [
  tenancy,
  staff,
  catalog,
  availability,
  patients,
  conversations,
  scheduling,
  payments,
  knowledge,
  ops,
  phase3,
];

function isPgTable(value: unknown): value is PgTable {
  if (typeof value !== "object" || value === null) return false;
  try {
    getTableConfig(value as PgTable);
    return true;
  } catch {
    return false;
  }
}

/** Every table declared in this schema, as `{ name, columns }`. */
export const ALL_TABLES: ReadonlyArray<{ name: string; columns: readonly string[] }> = modules
  .flatMap((mod) => Object.values(mod) as unknown[])
  .filter(isPgTable)
  .map((table) => {
    const config = getTableConfig(table);
    return { name: config.name, columns: config.columns.map((c) => c.name) };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Tables the `tenant_isolation` policy must cover.
 *
 * `clinic` is the tenant root and isolates on its own `id`; every other tenant
 * table isolates on `clinic_id`. `webhook_dedup` is intentionally global — see
 * the comment on that table.
 */
export const TENANT_TABLES: readonly string[] = ALL_TABLES.filter(
  (t) => t.name === "clinic" || t.columns.includes("clinic_id"),
).map((t) => t.name);

/** The tenant key column for a table, for building or asserting policies. */
export function tenantKeyColumn(tableName: string): "id" | "clinic_id" {
  return tableName === "clinic" ? "id" : "clinic_id";
}
