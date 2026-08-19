import { schema } from "@sema/db";
import { newId } from "@sema/shared";
import type { z } from "zod";

import { addNoteSchema, escalateSchema, JSON_SCHEMAS } from "./schemas.js";
import { defineTool, type AnyToolDefinition, type ToolOutcome } from "./types.js";

/**
 * Handing over to a human, and leaving a note behind.
 *
 * `escalate` deliberately does *not* create the escalation row itself. The loop
 * does, after the reply has passed the guardrails, in the same transaction that
 * queues the holding message — so a patient is never left with an escalation
 * that fired and a message that was suppressed, or vice versa. The tool records
 * the request and the loop honours it.
 */

export const escalateTool: AnyToolDefinition = defineTool<z.infer<typeof escalateSchema>>({
  name: "escalate",
  description:
    "Hand this conversation to a human. Use it when you do not know something, when the patient asks for a person, for complaints and payment disputes, and whenever a fact you need is not in the clinic information. Send the patient a short holding message in the same reply — never escalate silently.",
  schema: escalateSchema,
  jsonSchema: JSON_SCHEMAS["escalate"] ?? {},
  mutating: true,

  async execute(input, runtime): Promise<ToolOutcome> {
    await runtime.audit({
      action: "agent.tool.escalate",
      entity: "conversation",
      entityId: runtime.conversationId,
      meta: { kind: input.kind, reason: input.reason.slice(0, 120) },
    });

    return {
      ok: true,
      result: {
        escalated: true,
        kind: input.kind,
        guidance:
          "A team member has been alerted. Now write the patient one short holding message telling them someone will come back to them. Do not attempt to answer the question yourself.",
      },
      effects: { escalate: { kind: input.kind, reason: input.reason } },
    };
  },
});

export const addNoteTool: AnyToolDefinition = defineTool<z.infer<typeof addNoteSchema>>({
  name: "add_note",
  description:
    "Leave a short internal note on this conversation for the clinic's staff. The patient never sees it. Use it for things staff will need at the desk, like 'patient will bring their antenatal booklet' or 'asked for a Kiswahili-speaking clinician'.",
  schema: addNoteSchema,
  jsonSchema: JSON_SCHEMAS["add_note"] ?? {},
  mutating: true,

  async execute(input, runtime): Promise<ToolOutcome> {
    const noteId = newId("note");
    const at = runtime.deps.clock.now();

    await runtime.deps.withTenantDb(runtime.clinicId, async (db) => {
      await db.insert(schema.note).values({
        id: noteId,
        clinicId: runtime.clinicId,
        patientId: runtime.patientId,
        conversationId: runtime.conversationId,
        body: input.body,
        author: "agent",
        createdAt: at,
        updatedAt: at,
      });
    });

    // The note body is staff-facing PHI: the audit row records that a note was
    // written and how long it was, never what it said (hard rule 4).
    await runtime.audit({
      action: "agent.tool.add_note",
      entity: "note",
      entityId: noteId,
      meta: { length: input.body.length },
    });

    return {
      ok: true,
      result: {
        note_id: noteId,
        guidance: "Noted for staff. Do not read the note back to the patient.",
      },
    };
  },
});
