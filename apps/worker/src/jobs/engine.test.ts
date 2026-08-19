import type { SqlExecutor, TenantClient, WithTenant, WithTenantDb } from "@sema/db";
import type { EngineClient } from "@sema/engine";
import { fixedClock } from "@sema/shared";
import { describe, expect, it } from "vitest";

import { handleInbound, type EngineDeps } from "./engine.js";
import type { PersistedInbound } from "./inbound.js";

/**
 * The pipeline, end to end, without Postgres, Redis, Meta or an API key.
 *
 * What is being defended here is the wiring, not the engine's own logic (that
 * has its own tests in `packages/engine`):
 *
 *  - the classifier runs before anything else, always (hard rule 1)
 *  - an emergency gets the script and an escalation, and never reaches the
 *    agent
 *  - the agent's reply goes to `outbox`, never to the channel
 *    (CLAUDE.md §Conventions)
 *  - `message.meta.prompt_version` is stamped (CONVERSATION_ENGINE.md §10)
 *  - a human-controlled conversation gets silence (hard rule 3)
 */

const CLINIC = "cli_01J00000000000000000000000";
const NOW = new Date("2026-08-20T07:00:00Z");

const persisted: PersistedInbound = {
  clinicId: CLINIC as PersistedInbound["clinicId"],
  patientId: "pat_01J00000000000000000000000",
  conversationId: "conv_01J0000000000000000000000",
  messageId: "msg_01J00000000000000000000000",
  conversationMode: "agent",
  humanInControl: false,
  kind: "text",
};

interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Answers every statement the pipeline issues, and records what it was asked. */
class FakeTenant {
  mode = "agent";
  messageBody: string | null = "Hi, how much is a GP consultation?";
  messageCount = 5;
  /** When `route.abusive.muted` was last recorded, or null for never. */
  mutedAt: Date | null = null;
  readonly recorded: Recorded[] = [];

  readonly withTenant: WithTenant = async (_clinicId, work) => work(this.client());

  readonly withTenantDb: WithTenantDb = async (_clinicId, work) =>
    work({
      insert: () => ({ values: async (): Promise<void> => undefined }),
      update: () => ({ set: () => ({ where: async (): Promise<void> => undefined }) }),
      execute: async () => ({ rows: [] }),
    } as never);

  /** Statements whose text matches, for asserting what was written. */
  matching(pattern: RegExp): Recorded[] {
    return this.recorded.filter((entry) => pattern.test(entry.sql));
  }

  private client(): TenantClient {
    return {
      query: async (sql: string, params: unknown[] = []) => {
        this.recorded.push({ sql, params });

        if (/from clinic c where/.test(sql)) {
          return {
            rows: [
              {
                name: "Afyanex Clinic",
                default_language: "en",
                emergency_contact_phone: "+254709000100",
                emergency_script_override: null,
                timezone: "Africa/Nairobi",
                specialty: "General practice",
              },
            ],
          };
        }
        if (/select body, transcript from message/.test(sql)) {
          return { rows: [{ body: this.messageBody, transcript: null }] };
        }
        if (/from conversation c where/.test(sql)) {
          return { rows: [{ mode: this.mode, message_count: this.messageCount }] };
        }
        if (/select phone_e164, language from patient/.test(sql)) {
          return { rows: [{ phone_e164: "+254712000001", language: "en" }] };
        }
        if (/select direction, body, transcript from message/.test(sql)) return { rows: [] };
        if (/action = 'route.abusive.muted'/.test(sql)) {
          return { rows: this.mutedAt === null ? [] : [{ at_ms: this.mutedAt.getTime() }] };
        }
        if (/from audit_log/.test(sql)) return { rows: [] };
        if (/from availability_rule/.test(sql)) return { rows: [{ open: true }] };
        if (/insert into message/.test(sql)) return { rows: [] };
        if (/insert into outbox/.test(sql)) return { rows: [] };
        if (/insert into audit_log/.test(sql)) return { rows: [] };
        if (/update conversation/.test(sql)) return { rows: [] };
        throw new Error(`unexpected sql: ${sql.trim().slice(0, 80)}`);
      },
    };
  }
}

/**
 * A model that classifies whatever it is told to, and answers the agent with a
 * fixed line. Deterministic: no key, no network, no flake.
 */
function fakeEngineClient(options: {
  category?: string;
  agentText?: string;
}): EngineClient & { converseCalls: number } {
  const state = { converseCalls: 0 };
  return {
    get converseCalls() {
      return state.converseCalls;
    },
    async structured() {
      return {
        text: JSON.stringify({
          category: options.category ?? "normal",
          language: "en",
          intent: "price",
          urgency: "none",
          confidence: 0.95,
        }),
        stopReason: "end_turn",
        inputTokens: 1,
        outputTokens: 1,
      };
    },
    async converse() {
      state.converseCalls += 1;
      return {
        blocks: [
          { type: "text" as const, text: options.agentText ?? "A GP consultation is KES 2,000." },
        ],
        stopReason: "end_turn",
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
}

const executor: SqlExecutor = {
  query: <R>() => Promise.resolve({ rows: [] as R[], rowCount: 0 }),
};

function deps(tenant: FakeTenant, client: EngineClient): EngineDeps {
  return {
    executor,
    withTenant: tenant.withTenant,
    withTenantDb: tenant.withTenantDb,
    client,
    scheduler: {} as EngineDeps["scheduler"],
    depositRequester: {
      request: async () => ({ status: "not_required", paymentRequestId: null, simulated: true }),
    },
    clock: fixedClock(NOW),
  };
}

/**
 * The agent needs a full context, which means a real `loadAgentContext` against
 * a real database. These tests stub `withTenantDb` to return nothing, so the
 * agent path throws "clinic not found" — which is exactly what we want to
 * assert *did not happen* on the safety routes, and is covered end to end by
 * the integration suite for the routes where it should.
 */
async function handle(tenant: FakeTenant, client: EngineClient): Promise<unknown> {
  return handleInbound(persisted, deps(tenant, client));
}

describe("handleInbound — safety routes never reach the agent", () => {
  it("sends the emergency script, escalates, and makes no agent call", async () => {
    const tenant = new FakeTenant();
    // A lexicon hit: the classifier short-circuits before the model, so the
    // category the fake would have returned is irrelevant. That is the point.
    tenant.messageBody = "I have severe chest pain and I can't breathe";
    const client = fakeEngineClient({});

    const outcome = await handle(tenant, client);

    expect(outcome).toMatchObject({ status: "handled", route: "emergency" });
    expect(client.converseCalls).toBe(0);
    // The script went to the outbox, not to the channel.
    expect(tenant.matching(/insert into outbox/)).toHaveLength(1);
    const queued = tenant.matching(/insert into message/)[0];
    expect(String(queued?.params[5])).toBe("agent");
  });

  it("stays silent when a human has taken over", async () => {
    const tenant = new FakeTenant();
    tenant.mode = "human";
    const client = fakeEngineClient({});

    const outcome = await handle(tenant, client);

    expect(outcome).toMatchObject({ status: "silent" });
    expect(client.converseCalls).toBe(0);
    expect(tenant.matching(/insert into outbox/)).toHaveLength(0);
  });

  it("refuses advice with the scripted redirect rather than an agent reply", async () => {
    const tenant = new FakeTenant();
    tenant.messageBody = "What could this rash be?";
    const client = fakeEngineClient({ category: "out_of_scope" });

    const outcome = await handle(tenant, client);

    expect(outcome).toMatchObject({ status: "handled", route: "out_of_scope" });
    expect(client.converseCalls).toBe(0);
  });

  it("says nothing at all to spam", async () => {
    const tenant = new FakeTenant();
    const client = fakeEngineClient({ category: "spam" });
    const outcome = await handle(tenant, client);
    expect(outcome).toMatchObject({ status: "handled", route: "spam" });
    expect(tenant.matching(/insert into outbox/)).toHaveLength(0);
  });
});

describe("handleInbound — the abuse mute expires (SAFETY.md §7)", () => {
  it("stays silent while the 24h mute is in force", async () => {
    const tenant = new FakeTenant();
    tenant.mode = "muted";
    tenant.mutedAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    const client = fakeEngineClient({});

    const outcome = await handle(tenant, client);

    expect(outcome).toMatchObject({ status: "silent" });
    expect(client.converseCalls).toBe(0);
    expect(tenant.matching(/insert into outbox/)).toHaveLength(0);
  });

  it("still raises the alarm for an emergency while muted", async () => {
    const tenant = new FakeTenant();
    tenant.mode = "muted";
    tenant.mutedAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    tenant.messageBody = "I have severe chest pain and I can't breathe";

    const outcome = await handle(tenant, fakeEngineClient({}));

    // The mute silences the agent, not the alarm: someone who swore at the desk
    // can still have a heart attack an hour later.
    expect(outcome).toMatchObject({ status: "handled", route: "emergency" });
    expect(tenant.matching(/insert into outbox/)).toHaveLength(1);
  });

  it("lifts the mute once 24 hours have passed", async () => {
    const tenant = new FakeTenant();
    // `conversation.mode` is still 'muted' — there is no column to clear it, so
    // the expiry has to come from the audit trail or the mute is permanent.
    tenant.mode = "muted";
    tenant.mutedAt = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    tenant.messageBody = "Sorry about before. Can I book a GP appointment?";

    // Reaching `loadAgentContext` *is* the assertion: this fake's
    // `withTenantDb` returns no rows, so the agent path — and only the agent
    // path — fails there. A still-muted conversation would have returned
    // `{status: "silent"}` without ever getting here.
    await expect(handle(tenant, fakeEngineClient({}))).rejects.toThrow("clinic not found");
  });
});

describe("handleInbound — nothing to say", () => {
  it("skips a message with no text (an image, a location)", async () => {
    const tenant = new FakeTenant();
    tenant.messageBody = null;
    const outcome = await handle(tenant, fakeEngineClient({}));
    expect(outcome).toEqual({ status: "skipped", reason: "no_text" });
  });
});

describe("handleInbound — the outbox is the only door out", () => {
  it("writes the message row, the outbox row and an audit row together", async () => {
    const tenant = new FakeTenant();
    tenant.messageBody = "you are useless, I hate this stupid clinic";
    const client = fakeEngineClient({ category: "abusive" });

    await handle(tenant, client);

    expect(tenant.matching(/insert into message/)).toHaveLength(1);
    expect(tenant.matching(/insert into outbox/)).toHaveLength(1);
    expect(tenant.matching(/insert into audit_log/).length).toBeGreaterThan(0);
  });

  it("stamps the prompt version on every queued message (§10)", async () => {
    const tenant = new FakeTenant();
    tenant.messageBody = "I have severe chest pain";
    await handle(tenant, fakeEngineClient({}));

    const queued = tenant.matching(/insert into message/)[0];
    const meta = JSON.parse(String(queued?.params[7])) as Record<string, unknown>;
    expect(meta["prompt_version"]).toBe("classifier.v1");
    expect(meta["scripted"]).toBe(true);
  });

  it("sends the AI disclosure with the first reply of a conversation", async () => {
    const tenant = new FakeTenant();
    tenant.messageCount = 1;
    tenant.messageBody = "I have severe chest pain";
    await handle(tenant, fakeEngineClient({}));

    // COMPLIANCE.md §1: the notice goes *after* the emergency script.
    const bodies = tenant.matching(/insert into message/).map((entry) => String(entry.params[4]));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatch(/emergency/i);
    expect(bodies[1]).toMatch(/AI/);
  });
});
