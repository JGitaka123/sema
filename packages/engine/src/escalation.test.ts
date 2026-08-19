import { schema, type TenantDb } from "@sema/db";
import { describe, expect, it } from "vitest";

import { recordEscalation, recordRouteAudit, type EscalationDeps } from "./escalation.js";
import { createRecordingNotifier, maskEmergencyContact } from "./notifier.js";
import type { EscalationRequest } from "./router.js";
import { ESCALATION_KINDS, type ClassifierResult } from "./types.js";

const CLASSIFICATION: ClassifierResult = {
  output: {
    category: "emergency",
    language: "sw",
    intent: "other",
    urgency: "high",
    confidence: 1,
  },
  source: "lexicon",
  lexiconTerms: ["sw_cannot_breathe"],
  latencyMs: 3,
  promptVersion: "classifier.v1",
  model: null,
};

const REQUEST: EscalationRequest = {
  kind: "emergency",
  reason: "safety_emergency",
  pinConversation: true,
  notify: ["inbox", "emergency_contact"],
};

interface Recorded {
  readonly inserts: { table: unknown; values: Record<string, unknown> }[];
  readonly updates: { table: unknown; values: Record<string, unknown> }[];
  readonly tenants: string[];
}

/**
 * A fake `withTenantDb`.
 *
 * `withTenant` itself is covered by `@sema/db`'s own tests (including that it
 * sets `app.current_clinic` transaction-locally); what this file needs to
 * prove is that the engine goes *through* it with the right clinic id and
 * writes the right rows.
 */
function fakeDb(): { deps: EscalationDeps; recorded: Recorded } {
  const inserts: Recorded["inserts"] = [];
  const updates: Recorded["updates"] = [];
  const tenants: string[] = [];

  const db = {
    insert(table: unknown) {
      return {
        async values(values: Record<string, unknown>) {
          inserts.push({ table, values });
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            async where() {
              updates.push({ table, values });
            },
          };
        },
      };
    },
  } as unknown as TenantDb;

  return {
    deps: {
      async withTenantDb(clinicId, work) {
        tenants.push(clinicId);
        return work(db);
      },
      now: () => new Date("2026-03-02T09:00:00Z"),
    },
    recorded: { inserts, updates, tenants },
  };
}

describe("escalation kinds", () => {
  it("match the database enum exactly", () => {
    // The engine keeps its own copy so the router stays database-free; this is
    // the test that stops the copy from drifting.
    expect([...ESCALATION_KINDS]).toEqual([...schema.escalationKind.enumValues]);
  });
});

describe("recordEscalation", () => {
  it("writes the escalation, the pin and the audit row through withTenant", async () => {
    const { deps, recorded } = fakeDb();
    const notifier = createRecordingNotifier();

    const result = await recordEscalation(
      {
        clinicId: "cli_01ABC",
        conversationId: "conv_01ABC",
        request: REQUEST,
        classification: CLASSIFICATION,
        emergencyContactPhone: "+254712345678",
      },
      { ...deps, notifier },
    );

    expect(recorded.tenants).toEqual(["cli_01ABC"]);
    expect(result.escalationId).toMatch(/^esc_/);
    expect(result.auditId).toMatch(/^aud_/);

    const escalationRow = recorded.inserts.find((i) => i.table === schema.escalation);
    expect(escalationRow?.values).toMatchObject({
      id: result.escalationId,
      clinicId: "cli_01ABC",
      conversationId: "conv_01ABC",
      kind: "emergency",
      status: "open",
      reason: "safety_emergency",
    });

    // SAFETY.md §3: pin the conversation.
    expect(recorded.updates).toHaveLength(1);
    expect(recorded.updates[0]?.table).toBe(schema.conversation);
    expect(recorded.updates[0]?.values).toMatchObject({ pinned: true });

    // Hard rule 7: every AI action is audited.
    const auditRow = recorded.inserts.find((i) => i.table === schema.auditLog);
    expect(auditRow?.values).toMatchObject({
      actor: "agent",
      action: "escalation.created",
      entity: "escalation",
      entityId: result.escalationId,
    });
  });

  it("stores a PHI-free classifier payload", async () => {
    const { deps, recorded } = fakeDb();
    await recordEscalation(
      {
        clinicId: "cli_01ABC",
        conversationId: "conv_01ABC",
        request: REQUEST,
        classification: CLASSIFICATION,
      },
      deps,
    );

    const escalationRow = recorded.inserts.find((i) => i.table === schema.escalation);
    const payload = escalationRow?.values["classifierOutput"] as Record<string, unknown>;
    expect(payload["category"]).toBe("emergency");
    expect(payload["lexicon_terms"]).toEqual(["sw_cannot_breathe"]);
    expect(JSON.stringify(payload)).not.toMatch(/\+?254\d/);
  });

  it("does not pin the conversation when the route does not ask for it", async () => {
    const { deps, recorded } = fakeDb();
    await recordEscalation(
      {
        clinicId: "cli_01ABC",
        conversationId: "conv_01ABC",
        request: { ...REQUEST, kind: "abusive", pinConversation: false, notify: ["inbox"] },
        classification: CLASSIFICATION,
      },
      deps,
    );
    expect(recorded.updates).toHaveLength(0);
  });

  it("notifies with a masked phone number, never the raw one", async () => {
    const { deps } = fakeDb();
    const notifier = createRecordingNotifier();

    await recordEscalation(
      {
        clinicId: "cli_01ABC",
        conversationId: "conv_01ABC",
        request: REQUEST,
        classification: CLASSIFICATION,
        emergencyContactPhone: "+254712345678",
      },
      { ...deps, notifier },
    );

    expect(notifier.sent).toHaveLength(1);
    const sent = notifier.sent[0];
    expect(sent?.kind).toBe("emergency");
    expect(sent?.channels).toEqual(["inbox", "emergency_contact"]);
    expect(sent?.emergencyContactMasked).toBe("+254••••••678");
    expect(JSON.stringify(sent)).not.toContain("712345678");
  });

  it("omits the masked field entirely when the clinic has no alerting number", async () => {
    const { deps } = fakeDb();
    const notifier = createRecordingNotifier();
    await recordEscalation(
      {
        clinicId: "cli_01ABC",
        conversationId: "conv_01ABC",
        request: REQUEST,
        classification: CLASSIFICATION,
        emergencyContactPhone: null,
      },
      { ...deps, notifier },
    );
    expect(notifier.sent[0]?.emergencyContactMasked).toBeUndefined();
  });

  it("notifies only after the transaction has committed", async () => {
    // A push that fails must not roll back the escalation, and a push that is
    // slow must not hold a row lock.
    const order: string[] = [];
    const db = {
      insert() {
        return {
          async values() {
            order.push("insert");
          },
        };
      },
      update() {
        return { set: () => ({ async where() {} }) };
      },
    } as unknown as TenantDb;

    const notifier = {
      async notify() {
        order.push("notify");
      },
    };

    await recordEscalation(
      {
        clinicId: "cli_01ABC",
        conversationId: "conv_01ABC",
        request: { ...REQUEST, pinConversation: false },
        classification: CLASSIFICATION,
      },
      {
        async withTenantDb(_clinicId, work) {
          const value = await work(db);
          order.push("commit");
          return value;
        },
        notifier,
      },
    );

    expect(order).toEqual(["insert", "insert", "commit", "notify"]);
  });
});

describe("recordRouteAudit", () => {
  it("audits a non-escalating decision too", async () => {
    const { deps, recorded } = fakeDb();
    const auditId = await recordRouteAudit(
      {
        clinicId: "cli_01ABC",
        conversationId: "conv_01ABC",
        entry: { action: "route.agent", meta: { category: "normal", confidence: 0.9 } },
      },
      deps,
    );

    expect(auditId).toMatch(/^aud_/);
    expect(recorded.inserts).toHaveLength(1);
    expect(recorded.inserts[0]?.values).toMatchObject({
      action: "route.agent",
      entity: "conversation",
      entityId: "conv_01ABC",
    });
  });
});

describe("maskEmergencyContact", () => {
  it("masks a number and passes through nothing when unset", () => {
    expect(maskEmergencyContact("+254712345678")).toBe("+254••••••678");
    expect(maskEmergencyContact(null)).toBeUndefined();
    expect(maskEmergencyContact("")).toBeUndefined();
  });
});
