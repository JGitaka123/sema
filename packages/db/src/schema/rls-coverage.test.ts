import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ALL_TABLES, TENANT_TABLES, tenantKeyColumn } from "./index.js";

/**
 * Hard rule 8, enforced without a database.
 *
 * `test/rls.test.ts` proves the policies work against real Postgres, but it
 * needs Docker. This one reads the migration SQL and fails the ordinary
 * `pnpm test` run the moment someone adds a tenant table without a policy — so
 * the mistake is caught on the machine that made it, not in CI.
 */

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

const sql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
  .join("\n");

describe("migration SQL", () => {
  it("creates every table declared in the schema", () => {
    for (const table of ALL_TABLES) {
      expect(sql, `missing CREATE TABLE for ${table.name}`).toContain(
        `CREATE TABLE "${table.name}"`,
      );
    }
  });

  it("creates the extensions the schema depends on", () => {
    for (const extension of ["btree_gist", "citext", "pgcrypto"]) {
      expect(sql).toContain(`CREATE EXTENSION IF NOT EXISTS ${extension}`);
    }
  });

  it.each(TENANT_TABLES)("enables and forces row level security on %s", (table) => {
    expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
    expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
  });

  it.each(TENANT_TABLES)("creates the tenant_isolation policy on %s", (table) => {
    const key = tenantKeyColumn(table);
    expect(sql).toContain(
      `CREATE POLICY "tenant_isolation" ON "${table}" USING ("${key}" = current_setting('app.current_clinic', true))`,
    );
  });

  it("gives every policy a WITH CHECK so a write cannot cross tenants either", () => {
    const policies = sql.match(/CREATE POLICY "tenant_isolation"[^;]+;/g) ?? [];
    expect(policies).toHaveLength(TENANT_TABLES.length);
    for (const policy of policies) expect(policy).toContain("WITH CHECK");
  });

  it("leaves webhook_dedup as the only table without a policy, on purpose", () => {
    const withoutPolicy = ALL_TABLES.filter((t) => !TENANT_TABLES.includes(t.name)).map(
      (t) => t.name,
    );
    expect(withoutPolicy).toEqual(["webhook_dedup"]);
    expect(sql).not.toContain(`CREATE POLICY "tenant_isolation" ON "webhook_dedup"`);
    expect(sql).not.toContain(`ALTER TABLE "webhook_dedup" ENABLE ROW LEVEL SECURITY`);
  });

  it("declares the exclusion constraints that stop double-booking", () => {
    expect(sql).toContain(
      'ALTER TABLE "slot_hold" ADD CONSTRAINT "slot_hold_no_overlap"\n  EXCLUDE USING gist ("provider_id" WITH =, "slot" WITH &&)',
    );
    expect(sql).toContain(
      'ALTER TABLE "appointment" ADD CONSTRAINT "appointment_no_overlap"\n  EXCLUDE USING gist ("provider_id" WITH =, "slot" WITH &&)',
    );
    expect(sql).toContain(
      "WHERE (status IN ('booked', 'confirmed', 'arrived', 'pending_deposit'))",
    );
  });

  it("dedups inbound WhatsApp ids with a partial unique index", () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "message_wa_id" ON "message" USING btree ("clinic_id","wa_message_id") WHERE wa_message_id is not null;',
    );
  });

  it("keeps the minimum indexes DATA_MODEL.md asks for", () => {
    const required = [
      'ON "conversation" USING btree ("clinic_id","status","last_message_at" DESC',
      'ON "message" USING btree ("conversation_id","at")',
      'ON "appointment" USING btree ("clinic_id","provider_id","slot")',
      'ON "patient" USING btree ("clinic_id","phone_e164")',
      'ON "reminder" USING btree ("status","due_at")',
      'ON "outbox" USING btree ("status","next_attempt_at")',
      'ON "escalation" USING btree ("clinic_id","status")',
      'ON "audit_log" USING btree ("clinic_id","at")',
    ];
    for (const index of required) expect(sql, `missing index: ${index}`).toContain(index);
  });
});

describe("schema shape", () => {
  it("gives every tenant table clinic_id, created_at and updated_at", () => {
    for (const table of ALL_TABLES) {
      if (table.name === "webhook_dedup") continue;
      if (table.name !== "clinic") expect(table.columns).toContain("clinic_id");
      expect(table.columns, `${table.name} is missing timestamps`).toEqual(
        expect.arrayContaining(["created_at", "updated_at"]),
      );
    }
  });

  it("covers every table in docs/DATA_MODEL.md", () => {
    // Kept as a literal list: if DATA_MODEL.md grows a table, this fails until
    // someone adds it here too, which is the reminder we want.
    expect(ALL_TABLES.map((t) => t.name)).toEqual(
      [
        "appointment",
        "attachment",
        "audit_log",
        "availability_rule",
        "clinic",
        // Phase 3 (INTEGRATIONS.md §1): the connected WhatsApp sender.
        "clinic_whatsapp",
        "conversation",
        "encounter",
        "escalation",
        "knowledge_item",
        "location",
        "message",
        "note",
        "outbox",
        "patient",
        "patient_consent",
        "payer",
        "payment",
        "payment_request",
        "provider",
        "provider_service",
        "reminder",
        "service",
        "service_intake_question",
        "slot_hold",
        "staff_user",
        "subscription",
        "template",
        "time_off",
        "usage_meter",
        "webhook_dedup",
      ].sort(),
    );
  });
});
