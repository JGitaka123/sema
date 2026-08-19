import { describe, expect, it } from "vitest";

import { ModelCallError, type ModelClient, type StructuredRequest } from "./client.js";
import { MAX_SUMMARY_CHARS, regenerateSummary, renderTranscript, shouldSummarise } from "./summaries.js";
import type { HistoryMessage } from "./context.js";

/**
 * Summaries (CONVERSATION_ENGINE.md §8).
 *
 * The behaviour worth pinning down is what happens when the model does *not*
 * answer: the previous summary must survive. A conversation whose summary was
 * blanked by a timeout is one a staff member picks up blind.
 */

const CLINIC = "cli_00000000000000000000000001";
const CONVERSATION = "conv_00000000000000000000000001";

interface FakeDb {
  readonly withTenantDb: <T>(clinicId: string, work: (db: never) => Promise<T>) => Promise<T>;
  readonly updates: unknown[];
  readonly audits: unknown[];
}

function fakeDb(rows: readonly Record<string, unknown>[]): FakeDb {
  const updates: unknown[] = [];
  const audits: unknown[] = [];
  const db = {
    async execute() {
      return { rows: [...rows] };
    },
    update() {
      return {
        set(values: unknown) {
          updates.push(values);
          return { where: async (): Promise<void> => undefined };
        },
      };
    },
    insert() {
      return {
        async values(values: unknown) {
          audits.push(values);
        },
      };
    },
  };
  return {
    updates,
    audits,
    async withTenantDb<T>(_clinicId: string, work: (database: never) => Promise<T>): Promise<T> {
      return work(db as never);
    },
  };
}

function client(text: string): ModelClient & { calls: StructuredRequest[] } {
  const calls: StructuredRequest[] = [];
  return {
    calls,
    async structured(request) {
      calls.push(request);
      return { text, stopReason: "end_turn", inputTokens: 1, outputTokens: 1 };
    },
  };
}

/** Newest first — the order `order by at desc` actually returns. */
const MESSAGES: readonly Record<string, unknown>[] = [
  { direction: "out", body: "Booked. Deposit KES 1,500.", transcript: null, sent_by: "agent", at_ms: 4 },
  { direction: "in", body: "Yes please", transcript: null, sent_by: null, at_ms: 3 },
  { direction: "out", body: "Sure — Friday 9am?", transcript: null, sent_by: "agent", at_ms: 2 },
  { direction: "in", body: "Hi, I need a dental cleaning", transcript: null, sent_by: null, at_ms: 1 },
];

describe("shouldSummarise", () => {
  it("is true exactly when the agent has stopped seeing the whole thread", () => {
    expect(shouldSummarise({ historyTruncated: true })).toBe(true);
    expect(shouldSummarise({ historyTruncated: false })).toBe(false);
  });
});

describe("renderTranscript", () => {
  it("distinguishes the patient, the assistant and a staff member", () => {
    const history: HistoryMessage[] = [
      { role: "patient", sentBy: null, text: "hi", at: new Date() },
      { role: "clinic", sentBy: "agent", text: "hello", at: new Date() },
      { role: "clinic", sentBy: "staff:usr_1", text: "Kelvin here", at: new Date() },
    ];
    expect(renderTranscript(history)).toBe("patient: hi\nassistant: hello\nclinic staff: Kelvin here");
  });
});

describe("regenerateSummary", () => {
  it("writes the summary and audits the fact, not the text", async () => {
    const db = fakeDb(MESSAGES);
    const model = client(JSON.stringify({ summary: "Achieng booked a cleaning for Friday 9am." }));

    const outcome = await regenerateSummary(
      { clinicId: CLINIC, conversationId: CONVERSATION, trigger: "handback" },
      { withTenantDb: db.withTenantDb as never, client: model },
    );

    expect(outcome).toEqual({
      status: "written",
      summary: "Achieng booked a cleaning for Friday 9am.",
    });
    expect(db.updates[0]).toMatchObject({ agentSummary: "Achieng booked a cleaning for Friday 9am." });

    const audit = JSON.stringify(db.audits[0]);
    expect(audit).toContain("conversation.summarised");
    expect(audit).toContain("handback");
    // Hard rule 4: the summary itself is PHI and lives on the conversation row.
    expect(audit).not.toContain("Achieng");
  });

  it("sends the oldest message first, so the model reads it in order", async () => {
    const db = fakeDb(MESSAGES);
    const model = client(JSON.stringify({ summary: "x" }));
    await regenerateSummary(
      { clinicId: CLINIC, conversationId: CONVERSATION, trigger: "nightly" },
      { withTenantDb: db.withTenantDb as never, client: model },
    );
    const sent = String(model.calls[0]?.messages[0]?.content ?? "");
    expect(sent.indexOf("dental cleaning")).toBeLessThan(sent.indexOf("Booked."));
  });

  it("leaves the existing summary alone when the model times out", async () => {
    const db = fakeDb(MESSAGES);
    const failing: ModelClient = {
      async structured() {
        throw new ModelCallError("timeout", "too slow");
      },
    };

    const outcome = await regenerateSummary(
      { clinicId: CLINIC, conversationId: CONVERSATION, trigger: "nightly" },
      { withTenantDb: db.withTenantDb as never, client: failing },
    );

    expect(outcome).toEqual({ status: "failed", reason: "timeout" });
    expect(db.updates).toEqual([]);
  });

  it("leaves it alone on malformed output too", async () => {
    const db = fakeDb(MESSAGES);
    const outcome = await regenerateSummary(
      { clinicId: CLINIC, conversationId: CONVERSATION, trigger: "nightly" },
      { withTenantDb: db.withTenantDb as never, client: client("not json at all") },
    );
    expect(outcome).toEqual({ status: "failed", reason: "malformed_output" });
    expect(db.updates).toEqual([]);
  });

  it("skips an empty conversation", async () => {
    const db = fakeDb([]);
    const outcome = await regenerateSummary(
      { clinicId: CLINIC, conversationId: CONVERSATION, trigger: "nightly" },
      { withTenantDb: db.withTenantDb as never, client: client("{}") },
    );
    expect(outcome).toEqual({ status: "skipped", reason: "empty" });
  });

  it("caps a runaway summary", async () => {
    const db = fakeDb(MESSAGES);
    const model = client(JSON.stringify({ summary: "x".repeat(5_000) }));
    const outcome = await regenerateSummary(
      { clinicId: CLINIC, conversationId: CONVERSATION, trigger: "length" },
      { withTenantDb: db.withTenantDb as never, client: model },
    );
    expect(outcome.status).toBe("written");
    if (outcome.status === "written") {
      expect(outcome.summary.length).toBe(MAX_SUMMARY_CHARS);
    }
  });
});
