import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { maskPhone } from "@sema/shared";
import { getTableColumns, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import { closeDb, withTenantDb } from "../client.js";
import {
  availabilityRule,
  clinic,
  knowledgeItem,
  location,
  patient,
  patientConsent,
  provider,
  providerService,
  service,
  serviceIntakeQuestion,
  staffUser,
} from "../schema/index.js";
import type { TenantDb } from "../tenant-db.js";
import {
  AFYANEX_CLINIC_ID,
  availabilityRows,
  clinicRow,
  consentRows,
  intakeQuestionRows,
  knowledgeRows,
  locationRows,
  patientRows,
  providerRows,
  providerServiceRows,
  serviceRows,
  staffRows,
} from "./fixtures.js";

/**
 * `pnpm db:seed` — the Afyanex development fixture.
 *
 * Safe to re-run: every row has a deterministic id (see ids.ts) and is written
 * with an upsert, so a second run updates in place instead of creating a second
 * clinic. Nothing is deleted, so hand-made local data survives.
 *
 * Everything happens inside `withTenantDb`, in one transaction, with
 * `app.current_clinic` set — the seed goes through the same RLS door as the
 * application. If a policy is wrong, the seed fails, which is the point.
 */

type Row = Record<string, unknown>;

/**
 * Upsert on `conflict`, updating every column any row supplies.
 *
 * `excluded.<col>` is the row Postgres was about to insert, so the update
 * mirrors the fixture exactly. `created_at` is deliberately left alone;
 * `updated_at` is refreshed.
 */
async function upsert(
  db: TenantDb,
  table: PgTable,
  rows: readonly Row[],
  conflict: readonly PgColumn[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const columns = getTableColumns(table) as Record<string, PgColumn>;
  const conflictNames = new Set(conflict.map((c) => c.name));
  const touched = new Set(rows.flatMap((row) => Object.keys(row)));

  const set: Row = {};
  for (const key of touched) {
    const column = columns[key];
    if (!column || conflictNames.has(column.name) || column.name === "created_at") continue;
    set[key] = sql.raw(`excluded."${column.name}"`);
  }
  if (columns["updatedAt"]) set["updatedAt"] = sql`now()`;

  await db
    // The helper is deliberately generic over tables; Drizzle's insert types
    // are per-table, so the row type is asserted once, here.
    .insert(table)
    .values(rows as never)
    .onConflictDoUpdate({ target: conflict as PgColumn[], set });

  return rows.length;
}

export interface SeedResult {
  clinicId: string;
  counts: Record<string, number>;
}

export async function seed(): Promise<SeedResult> {
  const counts: Record<string, number> = {};

  await withTenantDb(AFYANEX_CLINIC_ID, async (db) => {
    // Order matters: parents before the rows that reference them.
    counts["clinic"] = await upsert(db, clinic, [clinicRow as Row], [clinic.id]);
    counts["location"] = await upsert(db, location, locationRows as Row[], [location.id]);
    counts["staff_user"] = await upsert(db, staffUser, staffRows as Row[], [staffUser.id]);
    counts["provider"] = await upsert(db, provider, providerRows as Row[], [provider.id]);
    counts["service"] = await upsert(db, service, serviceRows as Row[], [service.id]);
    counts["provider_service"] = await upsert(db, providerService, providerServiceRows as Row[], [
      providerService.providerId,
      providerService.serviceId,
    ]);
    counts["service_intake_question"] = await upsert(
      db,
      serviceIntakeQuestion,
      intakeQuestionRows as Row[],
      [serviceIntakeQuestion.id],
    );
    counts["availability_rule"] = await upsert(db, availabilityRule, availabilityRows as Row[], [
      availabilityRule.id,
    ]);
    counts["knowledge_item"] = await upsert(db, knowledgeItem, knowledgeRows as Row[], [
      knowledgeItem.id,
    ]);
    counts["patient"] = await upsert(db, patient, patientRows as Row[], [patient.id]);
    counts["patient_consent"] = await upsert(db, patientConsent, consentRows as Row[], [
      patientConsent.id,
    ]);
  });

  return { clinicId: AFYANEX_CLINIC_ID, counts };
}

async function main(): Promise<void> {
  const { clinicId, counts } = await seed();
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  console.log(`[sema] seeded ${clinicId} (Afyanex) — ${total} rows`);
  for (const [table, count] of Object.entries(counts)) {
    console.log(`         ${String(count).padStart(3, " ")}  ${table}`);
  }
  // Masked: a demo number is still a phone number, and hard rule 4 has no
  // "but it's fake" exception.
  console.log(`[sema] demo patients use numbers like ${maskPhone(patientRows[0]?.phoneE164)}`);

  await closeDb();
}

// Only run when executed directly (`pnpm db:seed`), so tests can import
// `seed()` and call it twice to prove it is idempotent.
const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && resolve(fileURLToPath(import.meta.url)) === entry) {
  main().catch(async (error: unknown) => {
    console.error("[sema] seed failed:", error);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
}
