import { defineConfig } from "vitest/config";

/**
 * Worker integration tests: they need a real Postgres 16 with the migrations
 * applied.
 *
 * Kept out of `pnpm test` on purpose — the unit suite must stay runnable on a
 * laptop with no Docker. `test/support/db.ts` skips these suites with a clear
 * message when no database is reachable, and CI always provides one.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // One process, one migrated database: the harness caches it in module
    // state, which only works if the suites share a thread.
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
    isolate: false,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
  },
});
