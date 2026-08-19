import { defineConfig } from "drizzle-kit";

/**
 * Migrations run as the migration role, not the app role: the app role must
 * never have the privileges to alter RLS policies (ARCHITECTURE.md §3).
 *
 * drizzle-kit is used for `generate` only. Applying migrations goes through
 * `src/migrate.ts` (the drizzle-orm migrator), so CI, the integration tests and
 * `pnpm db:migrate` all run the exact same SQL files in the exact same way.
 */
export default defineConfig({
  dialect: "postgresql",
  /**
   * The *compiled* schema, not `src`: drizzle-kit loads the schema through a
   * CommonJS require hook that does not rewrite NodeNext `./x.js` specifiers
   * back to `./x.ts`, so it cannot read our ESM TypeScript sources.
   * `pnpm --filter @sema/db generate` builds first, then points drizzle-kit at
   * the emitted JS, which carries identical table metadata.
   */
  schema: "./dist/schema/index.js",
  out: "./drizzle",
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env["DATABASE_MIGRATION_URL"] ?? process.env["DATABASE_URL"] ?? "",
  },
});
