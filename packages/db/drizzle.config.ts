import { defineConfig } from "drizzle-kit";

/**
 * Migrations run as the migration role, not the app role: the app role must
 * never have the privileges to alter RLS policies (ARCHITECTURE.md §3).
 * Tables themselves land in Phase 1 (docs/BUILD_PLAN.md).
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env["DATABASE_MIGRATION_URL"] ?? process.env["DATABASE_URL"] ?? "",
  },
});
