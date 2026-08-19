import { describe, expect, it } from "vitest";

import { HOLD_EXPIRY_EVERY_MS, HOLD_EXPIRY_JOB, runHoldExpiry } from "./hold-expiry.js";

/**
 * Unit-level checks only: the behaviour that matters (holds actually
 * disappearing) is proven against a real Postgres in
 * `packages/scheduling/test/holds.test.ts`. What is worth pinning here is that
 * importing the job opens nothing, and that the schedule cannot silently drift
 * past the hold TTL.
 */

describe("hold expiry job", () => {
  it("has a stable name — renaming it orphans the repeatable job in Redis", () => {
    expect(HOLD_EXPIRY_JOB).toBe("hold.expiry");
  });

  it("runs more often than a hold lives, so the table cannot grow a backlog", () => {
    const holdTtlMs = 10 * 60_000;
    expect(HOLD_EXPIRY_EVERY_MS).toBeGreaterThan(0);
    expect(HOLD_EXPIRY_EVERY_MS).toBeLessThan(holdTtlMs);
  });

  it("needs a database before it does anything — nothing connects at import", async () => {
    const previous = process.env["DATABASE_URL"];
    delete process.env["DATABASE_URL"];
    try {
      await expect(runHoldExpiry()).rejects.toMatchObject({ code: "INTERNAL" });
    } finally {
      if (previous === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = previous;
    }
  });
});
