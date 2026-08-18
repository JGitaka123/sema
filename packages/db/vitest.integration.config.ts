import { defineConfig } from "vitest/config";

/**
 * Integration tests: they need a real Postgres 16 with btree_gist and citext.
 *
 * Kept out of `pnpm test` on purpose — the unit suite must stay runnable on a
 * laptop with no Docker. `test/support/postgres.ts` skips these suites with a
 * clear message when no database is reachable.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // One process, one migrated database, shared by both suites: module state
    // in the harness is what keeps them from migrating twice.
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
    isolate: false,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
  },
});
