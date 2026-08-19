import { schema, type WithTenantDb } from "@sema/db";
import { newId } from "@sema/shared";

import { requestDepositTool } from "./deposit.js";
import { addNoteTool, escalateTool } from "./handover.js";
import { getClinicInfoTool, listServicesTool, sendLocationTool } from "./knowledge.js";
import {
  bookAppointmentTool,
  cancelAppointmentTool,
  holdSlotTool,
  lookupAppointmentsTool,
  rescheduleAppointmentTool,
  searchSlotsTool,
} from "./scheduling.js";
import type { AnyToolDefinition, AuditRecord, ToolEffects, ToolRuntime } from "./types.js";

export * from "./types.js";
export * from "./schemas.js";
export {
  noopDepositRequester,
  recordingDepositRequester,
  requestDepositFor,
} from "./deposit.js";

/**
 * The tool registry — exactly the set in CONVERSATION_ENGINE.md §3.2, in the
 * order the agent normally needs them.
 *
 * `tools.test.ts` asserts this list matches the doc's table name for name. A
 * tool the doc does not list must not be reachable from a patient conversation
 * without the doc changing first.
 */
export const AGENT_TOOLS: readonly AnyToolDefinition[] = [
  getClinicInfoTool,
  listServicesTool,
  searchSlotsTool,
  holdSlotTool,
  bookAppointmentTool,
  lookupAppointmentsTool,
  rescheduleAppointmentTool,
  cancelAppointmentTool,
  requestDepositTool,
  escalateTool,
  addNoteTool,
  sendLocationTool,
];

export const TOOLS_BY_NAME: ReadonlyMap<string, AnyToolDefinition> = new Map(
  AGENT_TOOLS.map((tool) => [tool.name, tool]),
);

/** The `tools` array the model is given (`ToolSpec[]`). */
export function toolSpecs(
  tools: readonly AnyToolDefinition[] = AGENT_TOOLS,
): readonly { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.jsonSchema,
  }));
}

/**
 * Part 6 of the system prompt: a compact index of the tools.
 *
 * Rendered from the same definitions the model is handed, so the prose in the
 * prompt cannot drift from the tool list actually in force.
 */
export function renderToolGuidance(tools: readonly AnyToolDefinition[] = AGENT_TOOLS): string {
  const lines = tools.map((tool) => `- \`${tool.name}\` — ${tool.description}`);
  return lines.join("\n");
}

/**
 * Write one tool call's audit row (hard rule 7).
 *
 * Its own transaction, not the tool's: several tools delegate to
 * `@sema/scheduling`, which runs its own transaction and writes its own domain
 * audit row. Nesting ours inside would either hold that transaction open across
 * a model round trip or lose the audit row when the domain call rolls back —
 * and "the agent tried to book and the booking failed" is precisely the row an
 * investigator wants to find.
 */
export function createAuditor(
  withTenantDb: WithTenantDb,
  clinicId: string,
  now: () => Date,
): (record: AuditRecord) => Promise<void> {
  return async (record: AuditRecord): Promise<void> => {
    const at = now();
    await withTenantDb(clinicId, async (db) => {
      await db.insert(schema.auditLog).values({
        id: newId("auditLog"),
        clinicId,
        actor: "agent",
        action: record.action,
        entity: record.entity,
        entityId: record.entityId,
        after: record.meta,
        at,
        createdAt: at,
        updatedAt: at,
      });
    });
  };
}

export interface ToolCallResult {
  readonly ok: boolean;
  /** Serialised back to the model as the `tool_result` block. */
  readonly payload: Record<string, unknown>;
  readonly tool?: AnyToolDefinition;
  /** Strings the guardrail may treat as grounded for this turn. */
  readonly facts?: readonly string[];
  readonly effects?: ToolEffects;
}

/**
 * Validate and run one tool call.
 *
 * The Zod parse is the boundary between "the model said" and "we did". A
 * rejection is reported back to the model as a normal tool result rather than
 * thrown, because the useful next step is for the model to fix its arguments —
 * and because a schema failure must not be able to kill a patient's turn.
 */
export async function executeToolCall(
  name: string,
  rawInput: unknown,
  runtime: ToolRuntime,
): Promise<ToolCallResult> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) {
    await runtime.audit({
      action: "agent.tool.unknown",
      entity: "conversation",
      entityId: runtime.conversationId,
      meta: { requested: name.slice(0, 64) },
    });
    return {
      ok: false,
      payload: {
        error: "UNKNOWN_TOOL",
        available: [...TOOLS_BY_NAME.keys()],
        guidance: "That tool does not exist. Use one of the listed tools.",
      },
    };
  }

  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) {
    // Field paths and codes only — a rejected argument may contain the
    // patient's own words (hard rule 4).
    await runtime.audit({
      action: "agent.tool.rejected",
      entity: "conversation",
      entityId: runtime.conversationId,
      meta: {
        tool: tool.name,
        fields: parsed.error.issues.map((issue) => issue.path.join(".")).join(","),
      },
    });
    return {
      ok: false,
      tool,
      payload: {
        error: "INVALID_ARGUMENTS",
        issues: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          problem: issue.message,
        })),
        guidance:
          "Your arguments were rejected before anything ran. Nothing happened. Fix them and call the tool again, or ask the patient for what you are missing.",
      },
    };
  }

  const outcome = await tool.execute(parsed.data as never, runtime);
  return {
    ok: outcome.ok,
    tool,
    payload: outcome.result,
    ...(outcome.facts === undefined ? {} : { facts: outcome.facts }),
    ...(outcome.effects === undefined ? {} : { effects: outcome.effects }),
  };
}
