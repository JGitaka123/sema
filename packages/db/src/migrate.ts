import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/**
 * Apply every migration in `packages/db/drizzle`.
 *
 * This — not `drizzle-kit migrate` — is the single way migrations are applied,
 * so `pnpm db:migrate`, the integration test harness and CI all execute the
 * same SQL files through the same code path. drizzle-kit is used only to
 * *generate* them.
 *
 * Runs as the migration role (`DATABASE_MIGRATION_URL`), which owns the schema.
 * The app role must never be able to alter RLS policies (ARCHITECTURE.md §3).
 */

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_MIGRATION_URL"] ?? process.env["DATABASE_URL"];
  if (!url) {
    console.error("[sema] db:migrate needs DATABASE_MIGRATION_URL or DATABASE_URL.");
    process.exitCode = 1;
    return;
  }
  await runMigrations(url);
  // Never log the connection string: it carries credentials.
  console.log("[sema] migrations applied.");
}

// Only run when executed directly, so tests can import `runMigrations`.
// (path.resolve on both sides keeps this working on Windows.)
const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && resolve(fileURLToPath(import.meta.url)) === entry) {
  main().catch((error: unknown) => {
    console.error("[sema] migration failed:", error);
    process.exit(1);
  });
}
