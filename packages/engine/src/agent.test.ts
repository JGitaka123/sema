import { AppError } from "@sema/shared";
import { describe, expect, it } from "vitest";

import {
  MAX_TOOL_CALLS,
  MAX_TURNS_PER_DAY,
  SAFE_FALLBACK_REPLY,
  agentLogFields,
  runAgent,
  type AgentInput,
} from "./agent.js";
import { ModelCallError } from "./client.js";
import {
  fakeModelClient,
  stubScheduler,
  testAgentDeps,
  testContext,
  type FakeModelOptions,
} from "./testing.js";

/**
 * The agent loop, against a fake model (CONVERSATION_ENGINE.md §3.3).
 *
 * No API key, no Postgres, no Redis. Everything asserted here is a rule the
 * loop enforces in code rather than asks the model to respect, which is the
 * only kind of rule worth a test — the budgets, the loop break, the retry, the
 * rewrite-then-escalate path, the Zod boundary and the audit trail.
 */

const SVC = "svc_00000000000000000000000001";
const PRV = "prv_00000000000000000000000001";
const HOLD = "hld_00000000000000000000000001";
const APT = "apt_00000000000000000000000001";

function input(overrides: Partial<AgentInput> = {}): AgentInput {
  const context = overrides.context ?? testContext();
  return {
    clinicId: context.clinic.id,
    conversationId: context.conversationId,
    patientId: context.patient.id,
    message: "Hi, can I book a GP appointment?",
    context,
    patientLanguage: "en",
    ...overrides,
  };
}

function run(options: FakeModelOptions, overrides: Partial<AgentInput> = {}, scheduler = stubScheduler()) {
  const client = fakeModelClient(options);
  const deps = testAgentDeps(client, { scheduler });
  return { client, deps, result: runAgent(input(overrides), deps) };
}

// ── The happy path ───────────────────────────────────────────────────────────

describe("runAgent — a plain reply", () => {
  it("returns the model's text, checked and stamped", async () => {
    const { result, deps } = run({
      turns: [{ text: "Sure — a GP consultation is KES 2,000. Which day suits you?" }],
    });
    const outcome = await result;

    expect(outcome.stopReason).toBe("replied");
    expect(outcome.replies).toEqual([
      { kind: "text", body: "Sure — a GP consultation is KES 2,000. Which day suits you?" },
    ]);
    expect(outcome.promptVersion).toBe("agent.v1");
    expect(outcome.escalation).toBeUndefined();
    // Hard rule 7: the reply itself is audited.
    expect(deps.db.inserts.some((row) => row.table === "audit_log")).toBe(true);
  });

  it("sends the system prompt with the clinic facts and the current time", async () => {
    const { client, result } = run({ turns: [{ text: "Sure, which day suits you?" }] });
    await result;

    const system = client.converseCalls[0]?.system ?? "";
    expect(system).toContain("front-desk assistant of Afyanex Clinic");
    expect(system).toContain("BEGIN CLINIC FACTS");
    expect(system).toContain("GP consultation");
    expect(system).toContain("Today is Thursday");
    expect(system).toContain("Africa/Nairobi");
    // COMPLIANCE.md §2: a first name, never a surname.
    expect(system).toContain("First name: Achieng");
  });

  it("adds the conservative addendum when the router asks for it", async () => {
    const { client, result } = run({ turns: [{ text: "Could you say a bit more?" }] }, {
      addendum: "conservative",
    });
    await result;
    expect(client.converseCalls[0]?.system ?? "").toContain("Extra caution for this message");
  });

  it("offers every tool from the documented set", async () => {
    const { client, result } = run({ turns: [{ text: "Which day suits you?" }] });
    await result;
    const names = (client.converseCalls[0]?.tools ?? []).map((tool) => tool.name);
    expect(names).toEqual([
      "get_clinic_info",
      "list_services",
      "search_slots",
      "hold_slot",
      "book_appointment",
      "lookup_appointments",
      "reschedule_appointment",
      "cancel_appointment",
      "request_deposit",
      "escalate",
      "add_note",
      "send_location",
    ]);
  });
});

// ── Tools ────────────────────────────────────────────────────────────────────

describe("runAgent — tool use", () => {
  it("runs a tool, feeds the result back, and grounds the reply on it", async () => {
    const scheduler = stubScheduler({
      searchSlots: () => ({
        slots: [
          {
            providerId: PRV,
            locationId: null,
            start: new Date("2026-08-21T06:00:00Z"),
            end: new Date("2026-08-21T06:20:00Z"),
            blockEnd: new Date("2026-08-21T06:25:00Z"),
          },
        ],
        total: 1,
        timezone: "Africa/Nairobi",
      }),
    });

    const { result, deps } = run(
      {
        turns: [
          {
            toolCalls: [
              {
                name: "search_slots",
                input: {
                  service_id: SVC,
                  from: "2026-08-21T08:00:00+03:00",
                  to: "2026-08-21T17:00:00+03:00",
                },
              },
            ],
          },
          { text: "I can offer Fri 21 Aug, 9:00 AM with Dr. Wanjiru Kamau. Does that work?" },
        ],
      },
      {},
      scheduler,
    );

    const outcome = await result;
    expect(outcome.stopReason).toBe("replied");
    expect(outcome.toolCalls).toEqual([{ name: "search_slots", ok: true }]);
    expect(deps.scheduler).toBe(scheduler);
    // The slot time came from the tool, not the knowledge base, and it grounds.
    expect(outcome.guardrailViolations.filter((v) => v.severity === "fail")).toEqual([]);
  });

  it("rejects invalid tool arguments before anything runs", async () => {
    const scheduler = stubScheduler({
      searchSlots: () => {
        throw new Error("the scheduler must not be reached");
      },
    });

    const { result, deps } = run(
      {
        turns: [
          {
            toolCalls: [
              // A service id from thin air: right shape, wrong prefix.
              { name: "search_slots", input: { service_id: "dental-cleaning", from: "x", to: "y" } },
            ],
          },
          { text: "Let me check that with the team." },
        ],
      },
      {},
      scheduler,
    );

    const outcome = await result;
    expect(outcome.toolCalls).toEqual([{ name: "search_slots", ok: false }]);
    expect(scheduler.calls).toEqual([]);
    expect(deps.db.inserts.some((row) => JSON.stringify(row.values).includes("agent.tool.rejected"))).toBe(
      true,
    );
  });

  it("turns a scheduling conflict into a conversation, not a crash", async () => {
    const scheduler = stubScheduler({
      holdSlot: () => {
        throw new AppError("CONFLICT", "That time has just been taken.");
      },
    });

    const { result } = run(
      {
        turns: [
          {
            toolCalls: [
              {
                name: "hold_slot",
                input: { provider_id: PRV, service_id: SVC, start: "2026-08-21T09:00:00+03:00" },
              },
            ],
          },
          { text: "Sorry, that time has just gone. Shall I look for another?" },
        ],
      },
      {},
      scheduler,
    );

    const outcome = await result;
    expect(outcome.stopReason).toBe("replied");
    expect(outcome.toolCalls).toEqual([{ name: "hold_slot", ok: false }]);
  });

  it("records an escalation the agent asked for, and still sends the holding message", async () => {
    const { result } = run({
      turns: [
        {
          toolCalls: [
            { name: "escalate", input: { kind: "low_confidence", reason: "parking_not_in_kb" } },
          ],
        },
        { text: "Let me check that with the team and come back to you." },
      ],
    });

    const outcome = await result;
    expect(outcome.escalation).toEqual({ kind: "low_confidence", reason: "parking_not_in_kb" });
    expect(outcome.replies[0]).toEqual({
      kind: "text",
      body: "Let me check that with the team and come back to you.",
    });
  });

  it("attaches tappable buttons for the slots the scheduler returned", async () => {
    const scheduler = stubScheduler({
      searchSlots: () => ({
        slots: [
          {
            providerId: PRV,
            locationId: null,
            start: new Date("2026-08-21T06:00:00Z"),
            end: new Date("2026-08-21T06:20:00Z"),
            blockEnd: new Date("2026-08-21T06:25:00Z"),
          },
          {
            providerId: PRV,
            locationId: null,
            start: new Date("2026-08-21T07:00:00Z"),
            end: new Date("2026-08-21T07:20:00Z"),
            blockEnd: new Date("2026-08-21T07:25:00Z"),
          },
        ],
        total: 2,
        timezone: "Africa/Nairobi",
      }),
    });

    const { result } = run(
      {
        turns: [
          {
            toolCalls: [
              {
                name: "search_slots",
                input: {
                  service_id: SVC,
                  from: "2026-08-21T08:00:00+03:00",
                  to: "2026-08-21T17:00:00+03:00",
                },
              },
            ],
          },
          { text: "I can do Fri 21 Aug, 9:00 AM or 10:00 AM. Which suits?" },
        ],
      },
      {},
      scheduler,
    );

    const reply = (await result).replies[0];
    expect(reply).toMatchObject({ kind: "text" });
    const options = reply?.kind === "text" ? reply.options : undefined;
    expect(options).toHaveLength(2);
    // The button carries the machine-readable start, not the model's prose.
    expect(options?.[0]?.id).toContain("2026-08-21T09:00:00+03:00");
    expect(options?.[0]?.title).toBe("Fri 21 Aug, 9:00 AM");
  });

  it("does not offer slot buttons on a confirmation", async () => {
    const scheduler = stubScheduler({
      searchSlots: () => ({
        slots: [
          {
            providerId: PRV,
            locationId: null,
            start: new Date("2026-08-21T06:00:00Z"),
            end: new Date("2026-08-21T06:20:00Z"),
            blockEnd: new Date("2026-08-21T06:25:00Z"),
          },
        ],
        total: 1,
        timezone: "Africa/Nairobi",
      }),
      holdSlot: () => ({
        holdId: HOLD,
        clinicId: "cli_00000000000000000000000001",
        providerId: PRV,
        serviceId: SVC,
        patientId: "pat_00000000000000000000000001",
        conversationId: "conv_00000000000000000000000001",
        start: new Date("2026-08-21T06:00:00Z"),
        end: new Date("2026-08-21T06:20:00Z"),
        blockEnd: new Date("2026-08-21T06:25:00Z"),
        expiresAt: new Date("2026-08-20T07:10:00Z"),
      }),
    });

    const { result } = run(
      {
        turns: [
          {
            toolCalls: [
              {
                name: "search_slots",
                input: {
                  service_id: SVC,
                  from: "2026-08-21T08:00:00+03:00",
                  to: "2026-08-21T17:00:00+03:00",
                },
              },
              {
                name: "hold_slot",
                input: { provider_id: PRV, service_id: SVC, start: "2026-08-21T09:00:00+03:00" },
              },
            ],
          },
          { text: "Holding Fri 21 Aug, 9:00 AM for you. Shall I confirm it?" },
        ],
      },
      {},
      scheduler,
    );

    const reply = (await result).replies[0];
    expect(reply?.kind === "text" ? reply.options : "missing").toBeUndefined();
  });

  it("emits a location message alongside the text", async () => {
    const { result } = run({
      turns: [
        { toolCalls: [{ name: "send_location", input: {} }] },
        { text: "We're at 2nd Floor, Wood Avenue Plaza, Kilimani. Pin below." },
      ],
    });

    const outcome = await result;
    expect(outcome.replies).toHaveLength(2);
    expect(outcome.replies[1]).toMatchObject({ kind: "location", latitude: -1.2921 });
  });
});

// ── Budgets and loops ────────────────────────────────────────────────────────

describe("runAgent — limits", () => {
  it("escalates before calling the model once the day's turn budget is spent", async () => {
    const { client, result } = run({ turns: [{ text: "should never be sent" }] }, {
      context: testContext({ agentTurnsToday: MAX_TURNS_PER_DAY }),
    });

    const outcome = await result;
    expect(outcome.stopReason).toBe("turn_budget_exhausted");
    expect(outcome.escalation?.kind).toBe("low_confidence");
    expect(outcome.replies).toHaveLength(1);
    expect(client.converseCalls).toHaveLength(0);
  });

  it("still runs on the last turn of the budget", async () => {
    const { result } = run({ turns: [{ text: "Which day suits you?" }] }, {
      context: testContext({ agentTurnsToday: MAX_TURNS_PER_DAY - 1 }),
    });
    expect((await result).stopReason).toBe("replied");
  });

  it("breaks and escalates when the same tool is called with the same arguments twice", async () => {
    const scheduler = stubScheduler({
      searchSlots: () => ({ slots: [], total: 0, timezone: "Africa/Nairobi" }),
    });
    const call = {
      name: "search_slots",
      input: { service_id: SVC, from: "2026-08-21T08:00:00+03:00", to: "2026-08-21T17:00:00+03:00" },
    };

    const { result, deps } = run(
      { turns: [{ toolCalls: [call] }, { toolCalls: [call] }, { text: "unreachable" }] },
      {},
      scheduler,
    );

    const outcome = await result;
    expect(outcome.stopReason).toBe("loop_detected");
    expect(outcome.escalation).toEqual({
      kind: "agent_error",
      reason: "repeated_tool_call:search_slots",
    });
    expect(outcome.replies).toEqual([{ kind: "text", body: SAFE_FALLBACK_REPLY }]);
    expect(scheduler.calls).toHaveLength(1);
    expect(deps.db.inserts.some((r) => JSON.stringify(r.values).includes("agent.loop_detected"))).toBe(
      true,
    );
  });

  it("stops at the tool-call budget", async () => {
    const scheduler = stubScheduler({
      searchSlots: () => ({ slots: [], total: 0, timezone: "Africa/Nairobi" }),
    });
    // Seven distinct calls: one over the budget of six.
    const turns = Array.from({ length: MAX_TOOL_CALLS + 1 }, (_, n) => ({
      toolCalls: [
        {
          name: "search_slots",
          input: {
            service_id: SVC,
            from: `2026-08-2${n % 8}T08:00:00+03:00`,
            to: `2026-08-2${n % 8}T17:00:00+03:00`,
            limit: (n % 3) + 1,
          },
        },
      ],
    }));

    const { result } = run({ turns: [...turns, { text: "unreachable" }] }, {}, scheduler);
    const outcome = await result;

    expect(outcome.stopReason).toBe("tool_budget_exhausted");
    expect(outcome.toolCalls.length).toBeLessThanOrEqual(MAX_TOOL_CALLS);
    expect(outcome.escalation?.kind).toBe("agent_error");
  });

  it("refuses a batch that would overshoot rather than half-running it", async () => {
    const scheduler = stubScheduler({
      searchSlots: () => ({ slots: [], total: 0, timezone: "Africa/Nairobi" }),
    });
    const batch = Array.from({ length: MAX_TOOL_CALLS + 1 }, (_, n) => ({
      name: "search_slots",
      input: { service_id: SVC, from: `2026-08-2${n}T08:00:00+03:00`, to: `2026-08-2${n}T17:00:00+03:00` },
    }));

    const { result } = run({ turns: [{ toolCalls: batch }, { text: "unreachable" }] }, {}, scheduler);
    const outcome = await result;

    expect(outcome.stopReason).toBe("tool_budget_exhausted");
    expect(scheduler.calls).toEqual([]);
  });
});

// ── Model failure ────────────────────────────────────────────────────────────

describe("runAgent — model failure", () => {
  it("retries once, then falls back to the reviewed line and escalates", async () => {
    const { client, result } = run({
      turns: [{ text: "unreachable" }],
      failAt: new Map([
        [0, new ModelCallError("timeout", "too slow")],
        [1, new ModelCallError("transport_error", "still down")],
      ]),
    });

    const outcome = await result;
    expect(client.converseCalls).toHaveLength(2);
    expect(outcome.stopReason).toBe("model_error");
    expect(outcome.replies).toEqual([{ kind: "text", body: SAFE_FALLBACK_REPLY }]);
    expect(outcome.escalation).toEqual({
      kind: "agent_error",
      reason: "model_unavailable_after_retry",
    });
  });

  it("succeeds on the retry", async () => {
    const { result } = run({
      turns: [{ text: "Which day suits you?" }],
      failAt: new Map([[0, new ModelCallError("timeout", "too slow")]]),
    });
    expect((await result).stopReason).toBe("replied");
  });

  it("escalates when the model says nothing at all", async () => {
    const { result } = run({ turns: [{ text: "" }] });
    const outcome = await result;
    expect(outcome.stopReason).toBe("empty_reply");
    expect(outcome.escalation?.kind).toBe("agent_error");
  });
});

// ── Guardrails in the loop ───────────────────────────────────────────────────

describe("runAgent — guardrails", () => {
  it("rewrites once when a reply is blocked, and sends the fixed one", async () => {
    const { client, result } = run({
      turns: [
        { text: "A GP consultation is KES 7,500." },
        { text: "A GP consultation is KES 2,000." },
      ],
    });

    const outcome = await result;
    expect(outcome.stopReason).toBe("replied");
    expect(outcome.rewritten).toBe(true);
    expect(outcome.replies).toEqual([{ kind: "text", body: "A GP consultation is KES 2,000." }]);

    // The rewrite names the violation and says the first reply never landed.
    const retryTurn = client.converseCalls[1]?.messages.at(-1);
    const instruction = typeof retryTurn?.content === "string" ? retryTurn.content : "";
    expect(instruction).toContain("grounding");
    expect(instruction).toContain("has not reached the patient");
  });

  it("falls back and escalates when the rewrite fails too", async () => {
    const { result } = run({
      turns: [
        { text: "You probably have an infection." },
        { text: "It sounds like an infection to me." },
      ],
    });

    const outcome = await result;
    expect(outcome.stopReason).toBe("guardrail_failed");
    expect(outcome.rewritten).toBe(true);
    expect(outcome.replies).toEqual([{ kind: "text", body: SAFE_FALLBACK_REPLY }]);
    expect(outcome.escalation).toEqual({
      kind: "agent_error",
      reason: "guardrail_failed_twice",
    });
  });

  it("never lets an ungrounded price reach the patient", async () => {
    const { result } = run({
      turns: [
        { text: "Dental scaling is KES 9,900." },
        { text: "Dental scaling is KES 8,800." },
      ],
    });
    const outcome = await result;
    expect(outcome.replies[0]).toEqual({ kind: "text", body: SAFE_FALLBACK_REPLY });
  });

  it("strips markdown on the way out", async () => {
    const { result } = run({ turns: [{ text: "**Thursday** works — shall I book it?" }] });
    const outcome = await result;
    expect(outcome.replies[0]).toEqual({
      kind: "text",
      body: "Thursday works — shall I book it?",
    });
  });
});

// ── Deposits ─────────────────────────────────────────────────────────────────

describe("runAgent — the deposit path", () => {
  it("auto-requests the deposit when the booked service needs one", async () => {
    const scheduler = stubScheduler({
      book: () => ({
        appointment: {
          id: APT,
          clinicId: "cli_00000000000000000000000001",
          patientId: "pat_00000000000000000000000001",
          providerId: "prv_00000000000000000000000002",
          serviceId: "svc_00000000000000000000000002",
          locationId: null,
          start: new Date("2026-08-21T06:00:00Z"),
          end: new Date("2026-08-21T06:45:00Z"),
          status: "pending_deposit",
          source: "agent",
          visitReason: null,
          depositRequiredMinor: 150_000,
          depositPaidMinor: 0,
          depositStatus: null,
          rescheduleOf: null,
          cancelledReason: null,
        },
        depositRequiredMinor: 150_000,
      }),
    });

    const { result, deps } = run(
      {
        turns: [
          { toolCalls: [{ name: "book_appointment", input: { hold_id: HOLD } }] },
          {
            text: "Held for you. We'll send an M-Pesa prompt for KES 1,500 to confirm.",
          },
        ],
      },
      {},
      scheduler,
    );

    const outcome = await result;
    expect(outcome.stopReason).toBe("replied");
    // Phase 6 seam: intent recorded, no Daraja call.
    expect(deps.deposits.requests).toHaveLength(1);
    expect(deps.deposits.requests[0]).toMatchObject({
      appointmentId: APT,
      amountMinor: 150_000,
      currency: "KES",
    });
  });

  it("does not ask for money when the service has no deposit", async () => {
    const scheduler = stubScheduler({
      book: () => ({
        appointment: {
          id: APT,
          clinicId: "cli_00000000000000000000000001",
          patientId: "pat_00000000000000000000000001",
          providerId: PRV,
          serviceId: SVC,
          locationId: null,
          start: new Date("2026-08-21T06:00:00Z"),
          end: new Date("2026-08-21T06:20:00Z"),
          status: "booked",
          source: "agent",
          visitReason: null,
          depositRequiredMinor: 0,
          depositPaidMinor: 0,
          depositStatus: null,
          rescheduleOf: null,
          cancelledReason: null,
        },
        depositRequiredMinor: 0,
      }),
    });

    const { result, deps } = run(
      {
        turns: [
          { toolCalls: [{ name: "book_appointment", input: { hold_id: HOLD } }] },
          { text: "You're booked for Fri 21 Aug, 9:00 AM with Dr. Wanjiru Kamau." },
        ],
      },
      {},
      scheduler,
    );

    await result;
    expect(deps.deposits.requests).toEqual([]);
  });
});

// ── Logging ──────────────────────────────────────────────────────────────────

describe("agentLogFields", () => {
  it("carries no reply text, no patient message and no tool arguments", async () => {
    const scheduler = stubScheduler({
      searchSlots: () => ({ slots: [], total: 0, timezone: "Africa/Nairobi" }),
    });
    const { result } = run(
      {
        turns: [
          {
            toolCalls: [
              {
                name: "search_slots",
                input: { service_id: SVC, from: "2026-08-21T08:00:00+03:00", to: "2026-08-21T17:00:00+03:00" },
              },
            ],
          },
          { text: "Nothing free that day, sorry — shall I try Monday?" },
        ],
      },
      { message: "my name is Achieng Odhiambo, 0712000001, I have a toothache" },
      scheduler,
    );

    const fields = agentLogFields(await result);
    const serialised = JSON.stringify(fields);

    expect(serialised).not.toContain("Achieng");
    expect(serialised).not.toContain("0712000001");
    expect(serialised).not.toContain("toothache");
    expect(serialised).not.toContain("Monday");
    expect(serialised).not.toContain(SVC);
    expect(fields["tool_calls"]).toBe("search_slots");
    expect(fields["stop_reason"]).toBe("replied");
  });
});
