import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb } from "../src/client.js";
import { seed } from "../src/seed/index.js";
import { AFYANEX_CLINIC_ID } from "../src/seed/fixtures.js";
import { getHarness, type Harness } from "./support/postgres.js";

/**
 * The Afyanex seed, against a real database.
 *
 * The property that matters is idempotency: `pnpm db:seed` is run by hand, by
 * CI and by anyone resetting their laptop, and a second run must update rows
 * rather than create a second clinic. Running it twice here and comparing row
 * counts is the whole test.
 *
 * It also exercises `withTenant` end to end — the seed writes through the same
 * tenant transaction the application uses, so a broken policy fails here.
 */

const maybeHarness = await getHarness();
const describeDb = maybeHarness ? describe : describe.skip;
const h = maybeHarness as Harness;

const SEEDED_TABLES = [
  "clinic",
  "location",
  "staff_user",
  "provider",
  "service",
  "provider_service",
  "service_intake_question",
  "availability_rule",
  "knowledge_item",
  "patient",
  "patient_consent",
] as const;

async function countsForAfyanex(): Promise<Record<string, number>> {
  const entries = await Promise.all(
    SEEDED_TABLES.map(async (table) => {
      const column = table === "clinic" ? "id" : "clinic_id";
      const { rows } = await h.pool.query<{ n: string }>(
        `select count(*) as n from ${table} where ${column} = $1`,
        [AFYANEX_CLINIC_ID],
      );
      return [table, Number(rows[0]?.n ?? 0)] as const;
    }),
  );
  return Object.fromEntries(entries);
}

describeDb("db:seed", () => {
  let afterFirst: Record<string, number>;
  let afterSecond: Record<string, number>;

  beforeAll(async () => {
    await seed();
    afterFirst = await countsForAfyanex();
    await seed();
    afterSecond = await countsForAfyanex();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("creates the Afyanex fixture", () => {
    expect(afterFirst["clinic"]).toBe(1);
    expect(afterFirst["staff_user"]).toBe(3);
    expect(afterFirst["provider"]).toBeGreaterThanOrEqual(3);
    expect(afterFirst["patient"]).toBe(20);
    expect(afterFirst["knowledge_item"]).toBeGreaterThanOrEqual(10);
    expect(afterFirst["availability_rule"]).toBeGreaterThan(0);
  });

  it("adds nothing on a second run", () => {
    expect(afterSecond).toEqual(afterFirst);
  });

  it("puts a deposit and intake questions on at least one service", async () => {
    const { rows } = await h.pool.query<{ name: string; requires_deposit: boolean; q: string }>(
      `select s.name, s.requires_deposit, count(q.id) as q
         from service s
         left join service_intake_question q on q.service_id = s.id
        where s.clinic_id = $1 and s.deposit_minor > 0
        group by s.name, s.requires_deposit`,
      [AFYANEX_CLINIC_ID],
    );
    expect(rows.length).toBeGreaterThan(0);
    // The generated column must agree with the amount it is generated from.
    for (const row of rows) expect(row.requires_deposit).toBe(true);
    expect(rows.some((row) => Number(row.q) > 0)).toBe(true);
  });

  it("is readable through the tenant policy as an unprivileged role", async () => {
    const patients = await h.asApp(AFYANEX_CLINIC_ID, async (client) => {
      const result = (await client.query("select id from patient")) as { rows: unknown[] };
      return result.rows;
    });
    expect(patients).toHaveLength(20);
  });
});
