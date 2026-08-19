import { defineConfig } from "vitest/config";

/**
 * Integration tests: a real Postgres 16 with btree_gist, migrated by the
 * shared harness in `packages/db/test/support/postgres.ts` (reused, not
 * duplicated — one harness, one migrated database).
 *
 * Kept out of `pnpm test` on purpose: the unit suite must stay runnable on a
 * laptop with no Docker, and the pure slot/policy maths is covered there.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // One process, one migrated database, shared by every suite in this
    // package — the harness caches itself per process.
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
    isolate: false,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
  },
});
