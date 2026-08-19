import type { InboundJobData } from "@sema/channels";
import type { SqlExecutor, TenantClient, WithTenant } from "@sema/db";
import { describe, expect, it } from "vitest";

import { SESSION_WINDOW_MS, processInboundMessage } from "./inbound.js";

/**
 * The decisions `inbound.process` makes, without a database.
 *
 * The SQL itself is exercised against real Postgres in
 * `test/whatsapp-pipeline.test.ts`; what matters here is the routing, the
 * normalisation and — most importantly — that a human-controlled conversation
 * never reaches the agent seam (hard rule 3).
 */

const CLINIC = "cli_01J00000000000000000000000";

const message = (overrides: Partial<InboundJobData> = {}): InboundJobData => ({
  phoneNumberId: "100000000000002",
  waMessageId: "wamid.ABC",
  fromWaId: "254712000001",
  profileName: "Amina Njeri",
  sentAt: "2026-08-19T12:00:00.000Z",
  kind: "text",
  body: "Naomba appointment",
  rawType: "text",
  ...overrides,
});

/** Answers the statements `processInboundMessage` issues. */
class FakeTenant {
  mode = "agent";
  duplicate = false;
  statements: string[] = [];
  conversationUpdateParams: unknown[] = [];
  attachments: unknown[][] = [];

  readonly withTenant: WithTenant = async (_clinicId, work) => work(this.client());

  private client(): TenantClient {
    return {
      query: async (sql: string, params: unknown[] = []) => {
        this.statements.push(sql.trim().split(/\s+/).slice(0, 4).join(" "));

        if (/insert into patient/.test(sql)) return { rows: [{ id: "pat_01" }] };
        if (/select id, mode from conversation/.test(sql)) {
          return { rows: [{ id: "conv_01", mode: this.mode }] };
        }
        if (/insert into message/.test(sql)) {
          return { rows: this.duplicate ? [] : [{ id: "msg_01" }] };
        }
        if (/insert into attachment/.test(sql)) {
          this.attachments.push(params);
          return { rows: [] };
        }
        if (/update conversation/.test(sql)) {
          this.conversationUpdateParams = params;
          return { rows: [] };
        }
        if (/from clinic_whatsapp/.test(sql)) return { rows: [] };
        if (/insert into audit_log/.test(sql)) return { rows: [] };
        throw new Error(`unexpected sql: ${sql.slice(0, 60)}`);
      },
    };
  }
}

/** Routing: `phone_number_id` → clinic, via the SECURITY DEFINER function. */
function executorReturning(clinicId: string | null): SqlExecutor {
  return {
    query: <R>() => Promise.resolve({ rows: [{ clinic_id: clinicId } as R], rowCount: 1 }),
  };
}

const routed = executorReturning(CLINIC);

describe("routing", () => {
  it("drops a message for a phone_number_id no clinic owns", async () => {
    const tenant = new FakeTenant();
    const outcome = await processInboundMessage(message(), {
      executor: executorReturning(null),
      withTenant: tenant.withTenant,
    });

    expect(outcome).toEqual({ status: "unrouted" });
    // Nothing was written: we do not know whose data it would have been.
    expect(tenant.statements).toHaveLength(0);
  });

  it("drops a sender we cannot normalise to E.164", async () => {
    const tenant = new FakeTenant();
    const outcome = await processInboundMessage(message({ fromWaId: "not-a-number" }), {
      executor: routed,
      withTenant: tenant.withTenant,
    });

    expect(outcome).toEqual({ status: "unusable" });
    expect(tenant.statements).toHaveLength(0);
  });
});

describe("persistence", () => {
  it("upserts patient, opens a conversation, stores the message and audits it", async () => {
    const tenant = new FakeTenant();
    const outcome = await processInboundMessage(message(), {
      executor: routed,
      withTenant: tenant.withTenant,
    });

    expect(outcome).toMatchObject({
      status: "processed",
      result: { clinicId: CLINIC, patientId: "pat_01", conversationId: "conv_01" },
    });
    expect(tenant.statements.join("|")).toContain("insert into patient");
    // Hard rule 7: every message is audited.
    expect(tenant.statements.join("|")).toContain("insert into audit_log");
  });

  it("treats a second delivery of the same wa_message_id as a duplicate", async () => {
    const tenant = new FakeTenant();
    tenant.duplicate = true;

    const outcome = await processInboundMessage(message(), {
      executor: routed,
      withTenant: tenant.withTenant,
    });

    expect(outcome).toEqual({ status: "duplicate" });
    // The unique index short-circuits before the window moves or anything is
    // audited — a replay must not bump the conversation twice.
    expect(tenant.statements.join("|")).not.toContain("update conversation");
  });

  it("moves the 24-hour window from the patient's message, not our clock", async () => {
    const tenant = new FakeTenant();
    const sentAt = "2026-08-19T12:00:00.000Z";
    await processInboundMessage(message({ sentAt }), {
      executor: routed,
      withTenant: tenant.withTenant,
    });

    const [, lastAt, expiresAt] = tenant.conversationUpdateParams as [string, Date, Date];
    expect(lastAt.toISOString()).toBe(sentAt);
    expect(expiresAt.getTime() - lastAt.getTime()).toBe(SESSION_WINDOW_MS);
  });

  it("records an attachment for media, without downloading or interpreting it", async () => {
    const tenant = new FakeTenant();
    await processInboundMessage(
      message({
        kind: "audio",
        rawType: "audio",
        body: undefined,
        media: { mediaId: "980000000000001", mime: "audio/ogg", voice: true },
      }),
      { executor: routed, withTenant: tenant.withTenant },
    );

    expect(tenant.attachments).toHaveLength(1);
    // The storage key is derived, not fetched: object storage lands later.
    expect(tenant.attachments[0]?.[3]).toBe(`clinic/${CLINIC}/media/980000000000001`);
  });

  it("stores no attachment for a plain text message", async () => {
    const tenant = new FakeTenant();
    await processInboundMessage(message(), { executor: routed, withTenant: tenant.withTenant });
    expect(tenant.attachments).toHaveLength(0);
  });
});

describe("takeover (hard rule 3)", () => {
  it("does not hand a human-controlled conversation to the agent seam", async () => {
    const tenant = new FakeTenant();
    tenant.mode = "human";
    let seamCalls = 0;

    const outcome = await processInboundMessage(message(), {
      executor: routed,
      withTenant: tenant.withTenant,
      onPersisted: async () => {
        seamCalls += 1;
      },
    });

    // The message is still stored — staff must see it — but the agent stays
    // silent until handback.
    expect(outcome).toMatchObject({ status: "processed", result: { humanInControl: true } });
    expect(seamCalls).toBe(0);
  });

  it("stays silent for a muted conversation too", async () => {
    const tenant = new FakeTenant();
    tenant.mode = "muted";
    let seamCalls = 0;

    await processInboundMessage(message(), {
      executor: routed,
      withTenant: tenant.withTenant,
      onPersisted: async () => {
        seamCalls += 1;
      },
    });
    expect(seamCalls).toBe(0);
  });

  it("hands an agent-mode conversation to the seam", async () => {
    const tenant = new FakeTenant();
    const seen: string[] = [];

    await processInboundMessage(message(), {
      executor: routed,
      withTenant: tenant.withTenant,
      onPersisted: async (result) => {
        seen.push(result.messageId);
      },
    });

    expect(seen).toEqual(["msg_01"]);
  });

  it("does nothing beyond persistence when no seam is wired — Phase 3 has no engine", async () => {
    const tenant = new FakeTenant();
    const outcome = await processInboundMessage(message(), {
      executor: routed,
      withTenant: tenant.withTenant,
    });
    expect(outcome.status).toBe("processed");
  });
});
