import { newId } from "@sema/shared";
import { beforeAll, describe, expect, it } from "vitest";

import { TENANT_TABLES } from "../src/schema/index.js";
import { createTenant, getHarness, type Harness, type TenantFixture } from "./support/postgres.js";

/**
 * Row level security, against a real Postgres (DATA_MODEL.md §"RLS test").
 *
 * Two things are proven here:
 *   1. *Coverage* — every table that has a clinic_id has RLS enabled, forced,
 *      and a `tenant_isolation` policy. Read from the catalogue rather than
 *      from our own schema constants, so a table added by a stray migration is
 *      caught too.
 *   2. *Effect* — with `app.current_clinic` set to clinic A, an unprivileged
 *      role sees none of clinic B's rows and cannot write into clinic B.
 */

const maybeHarness = await getHarness();
const describeDb = maybeHarness ? describe : describe.skip;
// Only evaluated inside `describeDb`, i.e. when the harness exists.
const h = maybeHarness as Harness;

interface RelSecurity {
  relname: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
  policies: string[];
}

async function securityByTable(): Promise<Map<string, RelSecurity>> {
  const { rows } = await h.pool.query<RelSecurity>(`
    select c.relname,
           c.relrowsecurity,
           c.relforcerowsecurity,
           -- text[] on purpose: the driver parses that OID into a JS array,
           -- whereas name[] would come back as the raw "{…}" string.
           coalesce(array_agg(p.polname::text) filter (where p.polname is not null), '{}'::text[]) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_policy p on p.polrelid = c.oid
     where n.nspname = 'public' and c.relkind = 'r'
     group by c.relname, c.relrowsecurity, c.relforcerowsecurity
  `);
  return new Map(rows.map((row) => [row.relname, row]));
}

async function tablesWithClinicId(): Promise<string[]> {
  const { rows } = await h.pool.query<{ table_name: string }>(`
    select table_name
      from information_schema.columns
     where table_schema = 'public' and column_name = 'clinic_id'
     order by table_name
  `);
  return rows.map((r) => r.table_name);
}

async function rowsOf(clinicId: string, sql: string, params: unknown[] = []) {
  return h.asApp(clinicId, async (client) => {
    const result = (await client.query(sql, params)) as {
      rows: Record<string, unknown>[];
      rowCount: number;
    };
    return result;
  });
}

describeDb("RLS policy coverage", () => {
  it("enables, forces and policies every table with clinic_id", async () => {
    const security = await securityByTable();
    const tables = await tablesWithClinicId();

    expect(tables.length).toBeGreaterThan(0);

    for (const table of tables) {
      const row = security.get(table);
      expect(row, `${table} is missing from pg_class`).toBeDefined();
      expect(row?.relrowsecurity, `${table}: RLS not enabled`).toBe(true);
      expect(row?.relforcerowsecurity, `${table}: RLS not forced`).toBe(true);
      expect(row?.policies, `${table}: no tenant_isolation policy`).toContain("tenant_isolation");
    }
  });

  it("isolates the clinic table itself, on its own id", async () => {
    const clinic = (await securityByTable()).get("clinic");
    expect(clinic?.relrowsecurity).toBe(true);
    expect(clinic?.relforcerowsecurity).toBe(true);
    expect(clinic?.policies).toContain("tenant_isolation");
  });

  it("matches the schema's own list of tenant tables", async () => {
    const tables = await tablesWithClinicId();
    expect([...tables, "clinic"].sort()).toEqual([...TENANT_TABLES].sort());
  });

  it("leaves webhook_dedup global, deliberately", async () => {
    const dedup = (await securityByTable()).get("webhook_dedup");
    // Dedup happens before the clinic is known, and the table holds only
    // opaque vendor ids — see the comment on the table in schema/ops.ts.
    expect(dedup?.relrowsecurity).toBe(false);
    expect(dedup?.policies).toEqual([]);
    expect(await tablesWithClinicId()).not.toContain("webhook_dedup");
  });

  it("uses current_setting('app.current_clinic') in USING and WITH CHECK", async () => {
    const { rows } = await h.pool.query<{ tablename: string; qual: string; check: string }>(`
      select tablename, qual, with_check as check
        from pg_policies
       where schemaname = 'public' and policyname = 'tenant_isolation'
    `);
    expect(rows.length).toBe(TENANT_TABLES.length);
    for (const row of rows) {
      expect(row.qual, `${row.tablename} USING`).toContain("app.current_clinic");
      // Without WITH CHECK, a tenant could insert rows belonging to another.
      expect(row.check, `${row.tablename} WITH CHECK`).toContain("app.current_clinic");
    }
  });
});

describeDb("cross-tenant isolation", () => {
  let a: TenantFixture;
  let b: TenantFixture;

  beforeAll(async () => {
    a = await createTenant(h, "alpha");
    b = await createTenant(h, "beta");

    // A message and a knowledge item each, so the reads below span several
    // tables rather than proving one policy.
    for (const tenant of [a, b]) {
      await h.pool.query(
        `insert into message (id, clinic_id, conversation_id, direction, kind, body)
         values ($1, $2, $3, 'in', 'text', 'hello')`,
        [newId("message"), tenant.clinicId, tenant.conversationId],
      );
      await h.pool.query(
        `insert into knowledge_item (id, clinic_id, category, body) values ($1, $2, 'hours', '8-5')`,
        [newId("knowledge"), tenant.clinicId],
      );
    }
  });

  it("returns only the current clinic's rows", async () => {
    for (const table of ["patient", "conversation", "message", "knowledge_item"]) {
      const { rows } = await rowsOf(a.clinicId, `select clinic_id from ${table}`);
      expect(rows.length, `${table}: expected clinic A rows`).toBeGreaterThan(0);
      expect(
        rows.filter((r) => r["clinic_id"] !== a.clinicId),
        `${table}: leaked rows from another clinic`,
      ).toEqual([]);
    }
  });

  it("returns zero rows when asked for another clinic's data by id", async () => {
    const { rows } = await rowsOf(
      a.clinicId,
      "select count(*)::int as n from patient where clinic_id = $1",
      [b.clinicId],
    );
    expect(rows[0]?.["n"]).toBe(0);
  });

  it("hides other clinics from the clinic table", async () => {
    const { rows } = await rowsOf(a.clinicId, "select id from clinic");
    expect(rows.map((r) => r["id"])).toEqual([a.clinicId]);
  });

  it("fails closed when app.current_clinic was never set", async () => {
    const client = await h.pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role sema_rls_probe");
      const result = await client.query<{ n: number }>("select count(*)::int as n from patient");
      expect(result.rows[0]?.n).toBe(0);
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  it("refuses to write a row into another clinic", async () => {
    const attempt = h.asApp(a.clinicId, (client) =>
      client.query(
        `insert into knowledge_item (id, clinic_id, category, body) values ($1, $2, 'faq', 'nope')`,
        [newId("knowledge"), b.clinicId],
      ),
    );
    await expect(attempt).rejects.toThrow(/row-level security|policy|insufficient/i);
  });

  it("cannot update rows across the boundary — they are not even visible", async () => {
    const { rowCount } = await rowsOf(
      a.clinicId,
      `update knowledge_item set body = 'changed' where clinic_id = $1`,
      [b.clinicId],
    );
    expect(rowCount).toBe(0);
  });
});
