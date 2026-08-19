import { schema, type WithTenantDb } from "@sema/db";
import { newId } from "@sema/shared";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { ModelCallError, type ModelClient } from "./client.js";
import { HISTORY_LIMIT, type AgentContext, type HistoryMessage } from "./context.js";
import { MODELS, SUMMARY_MAX_TOKENS, SUMMARY_TIMEOUT_MS } from "./models.js";
import { SUMMARY_PROMPT_VERSION, summarySystemPrompt } from "./prompts/index.js";

/**
 * Conversation summaries (CONVERSATION_ENGINE.md §8).
 *
 * "Conversation summary regenerated after human handback and nightly for open
 * conversations; stored in `conversation.agent_summary`; included in context
 * instead of full history beyond 20 messages."
 *
 * Two things this module is careful about:
 *
 *  - **It is off the hot path.** A patient never waits for a summary. It runs
 *    on handback and on the nightly sweep, and a failure leaves the previous
 *    summary in place rather than clearing it — a stale summary is a small
 *    problem, an empty one loses the thread.
 *  - **A summary is PHI that will be read by staff and re-sent to the model on
 *    every later turn**, which is exactly why the prompt forbids surnames,
 *    numbers and any clinical wording of the model's own.
 */

/** Regenerate once a conversation is longer than the window we send in full. */
export const SUMMARY_THRESHOLD = HISTORY_LIMIT;

/** How many messages the summariser reads. More than the agent's window. */
export const SUMMARY_HISTORY_LIMIT = 100;

export const MAX_SUMMARY_CHARS = 1200;

const summaryOutputSchema = z.object({ summary: z.string().min(1) }).strict();

const SUMMARY_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};

/** True when a conversation is long enough that the summary starts being used. */
export function shouldSummarise(context: Pick<AgentContext, "historyTruncated">): boolean {
  return context.historyTruncated;
}

export interface SummaryDeps {
  readonly withTenantDb: WithTenantDb;
  readonly client: ModelClient;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export interface SummariseInput {
  readonly clinicId: string;
  readonly conversationId: string;
  /** What prompted this: audited so a nightly sweep is distinguishable. */
  readonly trigger: "handback" | "nightly" | "length";
}

export type SummariseOutcome =
  | { readonly status: "written"; readonly summary: string }
  /** Too short to be worth summarising, or nothing to summarise. */
  | { readonly status: "skipped"; readonly reason: "too_short" | "empty" }
  /** The model did not answer. The previous summary is left alone. */
  | { readonly status: "failed"; readonly reason: string };

/** Render the transcript for the summariser. First names and text only. */
export function renderTranscript(messages: readonly HistoryMessage[]): string {
  return messages
    .map((message) => {
      const who =
        message.role === "patient"
          ? "patient"
          : message.sentBy !== null && message.sentBy.startsWith("staff")
            ? "clinic staff"
            : "assistant";
      return `${who}: ${message.text}`;
    })
    .join("\n");
}

export async function regenerateSummary(
  input: SummariseInput,
  deps: SummaryDeps,
): Promise<SummariseOutcome> {
  const now = (deps.now ?? ((): Date => new Date()))();

  const messages = await deps.withTenantDb(input.clinicId, async (db) => {
    const result = (await db.execute(
      sql`select direction, body, transcript, sent_by,
                 (extract(epoch from at) * 1000)::float8 as at_ms
            from message
           where clinic_id = ${input.clinicId} and conversation_id = ${input.conversationId}
             and coalesce(body, transcript) is not null
           order by at desc, id desc
           limit ${SUMMARY_HISTORY_LIMIT}`,
    )) as unknown as {
      rows: {
        direction: string;
        body: string | null;
        transcript: string | null;
        sent_by: string | null;
        at_ms: number;
      }[];
    };
    return (result.rows ?? []).reverse().map(
      (row): HistoryMessage => ({
        role: row.direction === "in" ? "patient" : "clinic",
        sentBy: row.sent_by,
        text: (row.body ?? row.transcript ?? "").trim(),
        at: new Date(Math.round(Number(row.at_ms))),
      }),
    );
  });

  if (messages.length === 0) return { status: "skipped", reason: "empty" };
  // A conversation that still fits in the agent's own window does not need a
  // summary: the agent is already reading the whole thing.
  if (messages.length < 4 && input.trigger === "length") {
    return { status: "skipped", reason: "too_short" };
  }

  let summary: string;
  try {
    const response = await deps.client.structured({
      model: MODELS.classifier,
      system: summarySystemPrompt(),
      messages: [{ role: "user", content: renderTranscript(messages) }],
      jsonSchema: SUMMARY_JSON_SCHEMA,
      maxTokens: SUMMARY_MAX_TOKENS,
      timeoutMs: SUMMARY_TIMEOUT_MS,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
    const parsed = summaryOutputSchema.safeParse(JSON.parse(response.text) as unknown);
    if (!parsed.success) return { status: "failed", reason: "malformed_output" };
    summary = parsed.data.summary.trim().slice(0, MAX_SUMMARY_CHARS);
  } catch (error) {
    if (error instanceof ModelCallError) return { status: "failed", reason: error.reason };
    if (error instanceof SyntaxError) return { status: "failed", reason: "malformed_output" };
    throw error;
  }

  if (summary === "") return { status: "failed", reason: "empty_output" };

  await deps.withTenantDb(input.clinicId, async (db) => {
    await db
      .update(schema.conversation)
      .set({ agentSummary: summary, updatedAt: now })
      .where(
        and(
          eq(schema.conversation.clinicId, input.clinicId),
          eq(schema.conversation.id, input.conversationId),
        ),
      );

    // Hard rule 7. Length and trigger only — the summary itself is PHI and
    // lives on the conversation row, not duplicated into the audit trail.
    await db.insert(schema.auditLog).values({
      id: newId("auditLog"),
      clinicId: input.clinicId,
      actor: "agent",
      action: "conversation.summarised",
      entity: "conversation",
      entityId: input.conversationId,
      after: {
        trigger: input.trigger,
        chars: summary.length,
        messages: messages.length,
        prompt_version: SUMMARY_PROMPT_VERSION,
      },
      at: now,
      createdAt: now,
      updatedAt: now,
    });
  });

  return { status: "written", summary };
}
