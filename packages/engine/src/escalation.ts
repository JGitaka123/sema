import { schema, type TenantDb, type WithTenantDb } from "@sema/db";
import { newId } from "@sema/shared";
import { eq } from "drizzle-orm";

import { maskEmergencyContact, noopNotifier, type Notifier } from "./notifier.js";
import type { AuditEntry, EscalationRequest } from "./router.js";
import type { ClassifierResult } from "./types.js";

/**
 * Escalation persistence.
 *
 * SAFETY.md §3: "create `escalation(emergency)`, pin conversation, push +
 * WhatsApp alert … Log the whole path in `audit_log`." CLAUDE.md hard rule 7:
 * "Every AI action is audited in `audit_log`: bookings, payment requests,
 * escalations, messages."
 *
 * Two ordering decisions worth knowing:
 *
 *  1. The escalation row, the pin and the audit row are written in **one**
 *     `withTenant` transaction. A pinned conversation with no escalation row,
 *     or an escalation nobody can audit, are both worse than neither.
 *  2. Notification happens **after** the transaction commits. A push that
 *     takes 900ms must not hold a row lock, and — more importantly — a failed
 *     push must not roll back the escalation. An escalation that exists but
 *     was not announced is recoverable by the unacknowledged-escalation
 *     re-alert (SAFETY.md §3); an escalation that was rolled back is not.
 */

export interface RecordEscalationInput {
  readonly clinicId: string;
  readonly conversationId: string;
  readonly request: EscalationRequest;
  readonly classification: ClassifierResult;
  /**
   * `clinic.emergency_contact_phone`. Only its masked form is passed on to the
   * notifier; the raw number never leaves this call (hard rule 4).
   */
  readonly emergencyContactPhone?: string | null;
}

export interface EscalationDeps {
  readonly withTenantDb: WithTenantDb;
  readonly notifier?: Notifier;
  readonly now?: () => Date;
}

export interface RecordedEscalation {
  readonly escalationId: string;
  readonly auditId: string;
  readonly notified: boolean;
}

/**
 * The classifier payload stored on `escalation.classifier_output`.
 *
 * `ClassifierResult` is PHI-free by construction (see `types.ts`), so this is
 * a straight copy — but it is spelled out rather than spread so that adding a
 * field to `ClassifierResult` is a conscious decision about what a staff
 * member and a future auditor get to see.
 */
function classifierPayload(classification: ClassifierResult): Record<string, unknown> {
  return {
    category: classification.output.category,
    language: classification.output.language,
    intent: classification.output.intent,
    urgency: classification.output.urgency,
    confidence: classification.output.confidence,
    source: classification.source,
    fallback_reason: classification.fallbackReason ?? null,
    lexicon_terms: classification.lexiconTerms,
    latency_ms: classification.latencyMs,
    prompt_version: classification.promptVersion,
    model: classification.model,
  };
}

export async function recordEscalation(
  input: RecordEscalationInput,
  deps: EscalationDeps,
): Promise<RecordedEscalation> {
  const now = (deps.now ?? (() => new Date()))();
  const escalationId = newId("escalation");
  const auditId = newId("auditLog");
  const { request } = input;

  await deps.withTenantDb(input.clinicId, async (db: TenantDb) => {
    await db.insert(schema.escalation).values({
      id: escalationId,
      clinicId: input.clinicId,
      conversationId: input.conversationId,
      kind: request.kind,
      status: "open",
      reason: request.reason,
      classifierOutput: classifierPayload(input.classification),
      createdAt: now,
      updatedAt: now,
    });

    if (request.pinConversation) {
      await db
        .update(schema.conversation)
        .set({ pinned: true, updatedAt: now })
        .where(eq(schema.conversation.id, input.conversationId));
    }

    await db.insert(schema.auditLog).values({
      id: auditId,
      clinicId: input.clinicId,
      actor: "agent",
      action: "escalation.created",
      entity: "escalation",
      entityId: escalationId,
      after: {
        kind: request.kind,
        status: "open",
        pinned: request.pinConversation,
        notify: request.notify,
        classifier: classifierPayload(input.classification),
      },
      reason: request.reason,
      at: now,
      createdAt: now,
      updatedAt: now,
    });
  });

  const notifier = deps.notifier ?? noopNotifier;
  const masked = maskEmergencyContact(input.emergencyContactPhone);
  await notifier.notify({
    escalationId,
    clinicId: input.clinicId,
    conversationId: input.conversationId,
    kind: request.kind,
    channels: request.notify,
    createdAt: now,
    ...(masked === undefined ? {} : { emergencyContactMasked: masked }),
  });

  return { escalationId, auditId, notified: true };
}

export interface RouteAuditInput {
  readonly clinicId: string;
  readonly conversationId: string;
  readonly entry: AuditEntry;
}

/**
 * Write the router's own decision to `audit_log`.
 *
 * Every inbound message produces one of these, escalating or not: hard rule 7
 * is about the agent's actions, and "the classifier saw this and decided the
 * agent could handle it" is an action. It is also the only record that will
 * explain, months later, why a message did *not* escalate.
 */
export async function recordRouteAudit(
  input: RouteAuditInput,
  deps: EscalationDeps,
): Promise<string> {
  const now = (deps.now ?? (() => new Date()))();
  const auditId = newId("auditLog");

  await deps.withTenantDb(input.clinicId, async (db: TenantDb) => {
    await db.insert(schema.auditLog).values({
      id: auditId,
      clinicId: input.clinicId,
      actor: "agent",
      action: input.entry.action,
      entity: "conversation",
      entityId: input.conversationId,
      after: input.entry.meta,
      at: now,
      createdAt: now,
      updatedAt: now,
    });
  });

  return auditId;
}
