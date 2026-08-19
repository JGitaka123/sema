import { AppError } from "@sema/shared";
import { describe, expect, it } from "vitest";

import { auditSpy, stubScheduler, testAgentDeps, testContext, testToolRuntime, fakeModelClient } from "../testing.js";
import { AGENT_TOOLS, executeToolCall, renderToolGuidance, toolSpecs } from "./index.js";
import { matchTopic } from "./knowledge.js";
import type { ToolRuntime } from "./types.js";

/**
 * Tool-level tests.
 *
 * The four properties in `tools/types.ts` — Zod-validated, tenant-scoped,
 * audited, policy-in-code — are each asserted here, because they are the ones
 * a future change is most likely to quietly break.
 */

const SVC_GP = "svc_00000000000000000000000001";
const PRV_GP = "prv_00000000000000000000000001";
const APT = "apt_00000000000000000000000001";

function harness(scheduler = stubScheduler(), context = testContext()) {
  const deps = testAgentDeps(fakeModelClient({ turns: [] }), { scheduler });
  const audit = auditSpy();
  const runtime: ToolRuntime = testToolRuntime(deps, context, audit);
  return { deps, audit, runtime, context, scheduler };
}

// ── The set itself ───────────────────────────────────────────────────────────

describe("the tool registry", () => {
  it("is exactly the set in CONVERSATION_ENGINE.md §3.2", () => {
    expect(AGENT_TOOLS.map((tool) => tool.name).sort()).toEqual(
      [
        "add_note",
        "book_appointment",
        "cancel_appointment",
        "escalate",
        "get_clinic_info",
        "hold_slot",
        "list_services",
        "lookup_appointments",
        "request_deposit",
        "reschedule_appointment",
        "search_slots",
        "send_location",
      ].sort(),
    );
  });

  it("gives every tool a JSON Schema the model can read", () => {
    for (const spec of toolSpecs()) {
      expect(spec.description.length).toBeGreaterThan(40);
      expect(spec.inputSchema["type"]).toBe("object");
      expect(spec.inputSchema["additionalProperties"]).toBe(false);
    }
  });

  it("renders the prompt's tool section from the same definitions", () => {
    const guidance = renderToolGuidance();
    for (const tool of AGENT_TOOLS) expect(guidance).toContain(tool.name);
  });
});

// ── 1. Zod boundary ──────────────────────────────────────────────────────────

describe("the Zod boundary", () => {
  it("rejects an unknown tool without touching anything", async () => {
    const { runtime, audit } = harness();
    const outcome = await executeToolCall("prescribe_medication", {}, runtime);
    expect(outcome.ok).toBe(false);
    expect(outcome.payload["error"]).toBe("UNKNOWN_TOOL");
    expect(audit.records[0]?.action).toBe("agent.tool.unknown");
  });

  it("rejects an id that is not one of ours", async () => {
    const scheduler = stubScheduler({
      searchSlots: () => {
        throw new Error("must not run");
      },
    });
    const { runtime } = harness(scheduler);
    const outcome = await executeToolCall(
      "search_slots",
      { service_id: "1", from: "2026-08-21T08:00:00+03:00", to: "2026-08-21T17:00:00+03:00" },
      runtime,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.payload["error"]).toBe("INVALID_ARGUMENTS");
    expect(scheduler.calls).toEqual([]);
  });

  it("rejects extra fields the model invented", async () => {
    const { runtime } = harness();
    const outcome = await executeToolCall(
      "escalate",
      { kind: "emergency", reason: "x", notify_everyone: true },
      runtime,
    );
    expect(outcome.ok).toBe(false);
  });

  it("rejects an escalation kind outside the enum", async () => {
    const { runtime } = harness();
    const outcome = await executeToolCall("escalate", { kind: "urgent", reason: "x" }, runtime);
    expect(outcome.ok).toBe(false);
  });

  it("records the rejected field path, never the rejected value", async () => {
    const { runtime, audit } = harness();
    await executeToolCall("add_note", { body: "" }, runtime);
    const record = audit.records.find((r) => r.action === "agent.tool.rejected");
    expect(record?.meta["fields"]).toBe("body");
    expect(JSON.stringify(record)).not.toContain("patient");
  });
});

// ── 2. Tenant scope ──────────────────────────────────────────────────────────

describe("tenant scope", () => {
  it("routes a write through withTenantDb with this clinic's id", async () => {
    const { runtime, deps, context } = harness();
    await executeToolCall("add_note", { body: "Bringing antenatal booklet." }, runtime);
    expect(deps.db.clinicIds).toContain(context.clinic.id);
  });

  it("passes the clinic id to every scheduling call", async () => {
    const scheduler = stubScheduler({
      searchSlots: () => ({ slots: [], total: 0, timezone: "Africa/Nairobi" }),
    });
    const { runtime, context } = harness(scheduler);
    await executeToolCall(
      "search_slots",
      { service_id: SVC_GP, from: "2026-08-21T08:00:00+03:00", to: "2026-08-21T17:00:00+03:00" },
      runtime,
    );
    expect(scheduler.calls[0]?.input).toMatchObject({ clinicId: context.clinic.id });
  });

  it("scopes lookup_appointments to this patient's own bookings", async () => {
    const context = testContext({
      patient: {
        ...testContext().patient,
        upcoming: [
          {
            id: APT,
            serviceId: SVC_GP,
            serviceName: "GP consultation",
            providerId: PRV_GP,
            providerName: "Dr. Wanjiru Kamau",
            start: new Date("2026-08-21T06:00:00Z"),
            end: new Date("2026-08-21T06:20:00Z"),
            status: "booked",
            depositRequiredMinor: 0,
            depositPaidMinor: 0,
          },
        ],
      },
    });
    const { runtime } = harness(stubScheduler(), context);
    const outcome = await executeToolCall("lookup_appointments", {}, runtime);
    const appointments = outcome.payload["appointments"] as { appointment_id: string }[];
    expect(appointments).toHaveLength(1);
    expect(appointments[0]?.appointment_id).toBe(APT);
  });
});

// ── 3. Audit ─────────────────────────────────────────────────────────────────

describe("audit", () => {
  it("writes one row per successful call, with no patient text in it", async () => {
    const scheduler = stubScheduler({
      searchSlots: () => ({ slots: [], total: 0, timezone: "Africa/Nairobi" }),
    });
    const { runtime, audit } = harness(scheduler);
    await executeToolCall(
      "search_slots",
      { service_id: SVC_GP, from: "2026-08-21T08:00:00+03:00", to: "2026-08-21T17:00:00+03:00" },
      runtime,
    );
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.action).toBe("agent.tool.search_slots");
    expect(audit.records[0]?.meta).toMatchObject({ service_id: SVC_GP, returned: 0 });
  });

  it("audits a note's length, never its body", async () => {
    const { runtime, audit } = harness();
    await executeToolCall("add_note", { body: "Wants a Kiswahili-speaking clinician." }, runtime);
    const record = audit.records.find((r) => r.action === "agent.tool.add_note");
    expect(record?.meta["length"]).toBe(37);
    expect(JSON.stringify(record)).not.toContain("Kiswahili");
  });

  it("audits a failed call too — a refused booking is the row that matters", async () => {
    const scheduler = stubScheduler({
      book: () => {
        throw new AppError("CONFLICT", "That hold has expired.");
      },
    });
    const { runtime, audit } = harness(scheduler);
    const outcome = await executeToolCall(
      "book_appointment",
      { hold_id: "hld_00000000000000000000000001" },
      runtime,
    );
    expect(outcome.ok).toBe(false);
    expect(audit.records.some((r) => r.meta["outcome"] === "failed")).toBe(true);
  });
});

// ── 4. Policy is code ────────────────────────────────────────────────────────

describe("policy lives in the tools", () => {
  it("reports the scheduler's forfeit decision rather than deciding itself", async () => {
    const scheduler = stubScheduler({
      cancel: () => ({
        appointment: { id: APT, status: "cancelled_by_patient" },
        policy: { outcome: "forfeit", depositForfeited: true, allowed: true },
      }),
    });
    const { runtime } = harness(scheduler);
    const outcome = await executeToolCall(
      "cancel_appointment",
      { appointment_id: APT, reason: "unwell" },
      runtime,
    );
    expect(outcome.payload["deposit_forfeited"]).toBe(true);
    expect(String(outcome.payload["guidance"])).toContain("not returned");
    expect(String(outcome.payload["guidance"])).toContain("do not promise a refund");
  });

  it("passes the refusal back as a result the agent can talk about", async () => {
    const scheduler = stubScheduler({
      cancel: () => {
        throw new AppError("CONFLICT", "That appointment can no longer be cancelled.");
      },
    });
    const { runtime } = harness(scheduler);
    const outcome = await executeToolCall("cancel_appointment", { appointment_id: APT }, runtime);
    expect(outcome.ok).toBe(false);
    expect(outcome.payload["error"]).toBe("CONFLICT");
    expect(String(outcome.payload["guidance"])).toContain("Do not claim anything was");
  });

  it("caps search_slots at three, whatever the model asks for", async () => {
    const scheduler = stubScheduler({
      searchSlots: () => ({ slots: [], total: 0, timezone: "Africa/Nairobi" }),
    });
    const { runtime } = harness(scheduler);
    await executeToolCall(
      "search_slots",
      {
        service_id: SVC_GP,
        from: "2026-08-21T08:00:00+03:00",
        to: "2026-08-21T17:00:00+03:00",
        limit: 5,
      },
      runtime,
    );
    expect(scheduler.calls[0]?.input).toMatchObject({ limit: 3 });
  });
});

// ── Knowledge ────────────────────────────────────────────────────────────────

describe("get_clinic_info", () => {
  it("finds the clinic's own words for a topic", async () => {
    const { runtime } = harness();
    const outcome = await executeToolCall("get_clinic_info", { topic: "opening hours" }, runtime);
    expect(outcome.payload["found"]).toBe(true);
    expect(JSON.stringify(outcome.payload)).toContain("8:00am–5:00pm");
  });

  it("says it does not know, rather than guessing", async () => {
    const { runtime } = harness();
    const outcome = await executeToolCall(
      "get_clinic_info",
      { topic: "do you have an MRI scanner" },
      runtime,
    );
    expect(outcome.payload["found"]).toBe(false);
    expect(String(outcome.payload["guidance"])).toContain("low_confidence");
    expect(outcome.facts).toBeUndefined();
  });

  it("maps Swahili topic words onto the clinic's categories", () => {
    expect(matchTopic("bei ni ngapi")).toContain("pricing");
    expect(matchTopic("mko wapi")).toContain("location");
  });
});

describe("list_services", () => {
  it("grounds the prices it returns", async () => {
    const { runtime } = harness();
    const outcome = await executeToolCall("list_services", { query: "dental" }, runtime);
    expect(outcome.facts).toContain("KES 4,500");
    expect(outcome.facts).toContain("KES 1,500");
  });

  it("falls back to the whole catalogue when nothing matches", async () => {
    const { runtime } = harness();
    const outcome = await executeToolCall("list_services", { query: "physiotherapy" }, runtime);
    expect(outcome.payload["exact_match"]).toBe(false);
    expect((outcome.payload["services"] as unknown[]).length).toBe(2);
  });
});

describe("send_location", () => {
  it("returns the pin as an effect for the loop to send", async () => {
    const { runtime } = harness();
    const outcome = await executeToolCall("send_location", {}, runtime);
    expect(outcome.effects?.sendLocation).toMatchObject({ latitude: -1.2921, longitude: 36.7833 });
  });

  it("does not invent directions when the clinic has no pin", async () => {
    const context = testContext({ locations: [] });
    const { runtime } = harness(stubScheduler(), context);
    const outcome = await executeToolCall("send_location", {}, runtime);
    expect(outcome.ok).toBe(false);
    expect(String(outcome.payload["guidance"])).toContain("low_confidence");
  });
});

// ── Deposits ─────────────────────────────────────────────────────────────────

describe("request_deposit", () => {
  it("refuses an appointment id that is not this patient's", async () => {
    const { runtime } = harness();
    const outcome = await executeToolCall("request_deposit", { appointment_id: APT }, runtime);
    expect(outcome.ok).toBe(false);
    expect(outcome.payload["error"]).toBe("NOT_FOUND");
  });
});
