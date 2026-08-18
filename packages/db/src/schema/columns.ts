import { customType, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Column primitives shared by every table.
 *
 * DATA_MODEL.md: "All IDs `text` ULIDs. All timestamps `timestamptz` UTC.
 * Money `bigint amount_minor` + `char(3) currency`. Every tenant table has
 * `clinic_id`, `created_at`, `updated_at`."
 */

/**
 * `citext` — case-insensitive text. Used for `staff_user.email` so login is not
 * case sensitive. The extension is created by the first migration (and by
 * infra/postgres/init for local docker volumes).
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => "citext",
});

/**
 * `tstzrange` — a half-open UTC instant range, the storage type for an
 * appointment or hold slot. Kept as the raw Postgres literal (`["…","…")`) so
 * the exclusion constraints and `&&` overlap operator work unchanged; the
 * scheduling package (Phase 2) owns the ergonomic wrapper.
 */
export const tstzrange = customType<{ data: string; driverData: string }>({
  dataType: () => "tstzrange",
});

/** Build a `[start, end)` tstzrange literal from two instants. */
export function tstzRangeLiteral(start: Date, end: Date): string {
  return `[${start.toISOString()},${end.toISOString()})`;
}

/** Prefixed-ULID primary key, e.g. `pat_01J…` (CLAUDE.md §Conventions). */
export const primaryId = (name = "id") => text(name).primaryKey();

/** A UTC `timestamptz` column. Never store local time. */
export const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * `created_at` / `updated_at` on every tenant table.
 *
 * `updated_at` is maintained by the writing code, not a trigger: writes go
 * through a small number of repositories and an implicit trigger would hide
 * that from readers of the query.
 */
export const createdAt = () => tz("created_at").notNull().defaultNow();
export const updatedAt = () => tz("updated_at").notNull().defaultNow();

export const timestamps = () => ({
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
