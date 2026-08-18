import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { primaryId, timestamps, tz } from "./columns.js";
import {
  conversationMode,
  conversationStatus,
  escalationKind,
  escalationStatus,
  messageDirection,
  messageKind,
  messageStatus,
} from "./enums.js";
import { patient } from "./patients.js";
import { staffUser } from "./staff.js";
import { clinicRef } from "./tenancy.js";

/**
 * One open thread per patient per clinic.
 *
 * `mode` is the takeover switch of hard rule 3: while `human`, the agent must
 * stay silent. `session_expires_at` tracks the Meta 24-hour customer service
 * window (COMPLIANCE.md §3) — `last_patient_message_at + 24h`.
 */
export const conversation = pgTable(
  "conversation",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    patientId: text("patient_id")
      .notNull()
      .references(() => patient.id),
    mode: conversationMode("mode").notNull().default("agent"),
    status: conversationStatus("status").notNull().default("open"),
    assignedStaffId: text("assigned_staff_id").references(() => staffUser.id),
    lastMessageAt: tz("last_message_at"),
    lastPatientMessageAt: tz("last_patient_message_at"),
    sessionExpiresAt: tz("session_expires_at"),
    agentSummary: text("agent_summary"),
    unreadForStaff: integer("unread_for_staff").notNull().default(0),
    pinned: boolean("pinned").notNull().default(false),
    ...timestamps(),
  },
  // The inbox list query (DATA_MODEL.md "Indexes (minimum)").
  (t) => [index("conversation_clinic_status_idx").on(t.clinicId, t.status, t.lastMessageAt.desc())],
);

/**
 * Every inbound and outbound message. Bodies are PHI: never log them, never
 * ship them to analytics or error tracking (hard rule 4).
 */
export const message = pgTable(
  "message",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id),
    direction: messageDirection("direction").notNull(),
    kind: messageKind("kind").notNull(),
    body: text("body"),
    /** Voice-note transcription (retention 12 months, DATA_MODEL.md). */
    transcript: text("transcript"),
    waMessageId: text("wa_message_id"),
    status: messageStatus("status"),
    /** `agent` | `<staff_user id>` | `system` */
    sentBy: text("sent_by"),
    templateName: text("template_name"),
    meta: jsonb("meta")
      .notNull()
      .default(sql`'{}'::jsonb`),
    at: tz("at").notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index("message_conversation_at_idx").on(t.conversationId, t.at),
    // Inbound dedup (CLAUDE.md §Idempotency). Partial: outbound messages have
    // no wa_message_id until Meta acks them, and NULLs must not collide.
    uniqueIndex("message_wa_id")
      .on(t.clinicId, t.waMessageId)
      .where(sql`wa_message_id is not null`),
  ],
);

/** Media the patient sent. Storage is object storage; this is the pointer. */
export const attachment = pgTable(
  "attachment",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    messageId: text("message_id")
      .notNull()
      .references(() => message.id),
    storageKey: text("storage_key").notNull(),
    mime: text("mime"),
    bytes: integer("bytes"),
    sha256: text("sha256"),
    /** Media retention default 90 days (ARCHITECTURE.md §9). */
    expiresAt: tz("expires_at"),
    ...timestamps(),
  },
  (t) => [
    index("attachment_message_idx").on(t.messageId),
    index("attachment_expires_at_idx").on(t.expiresAt),
  ],
);

/** A conversation that needs a human. Emergencies land here first (SAFETY.md). */
export const escalation = pgTable(
  "escalation",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id),
    kind: escalationKind("kind").notNull(),
    status: escalationStatus("status").notNull().default("open"),
    reason: text("reason"),
    classifierOutput: jsonb("classifier_output"),
    acknowledgedBy: text("acknowledged_by"),
    acknowledgedAt: tz("acknowledged_at"),
    resolvedAt: tz("resolved_at"),
    ...timestamps(),
  },
  (t) => [index("escalation_clinic_status_idx").on(t.clinicId, t.status)],
);

/** Free-text staff note against a patient, conversation or appointment. */
export const note = pgTable(
  "note",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    patientId: text("patient_id").references(() => patient.id),
    conversationId: text("conversation_id").references(() => conversation.id),
    /** FK added in scheduling.ts is impossible without a cycle; kept as a plain id. */
    appointmentId: text("appointment_id"),
    body: text("body").notNull(),
    /** `staff:<id>` | `agent` | `system` */
    author: text("author").notNull(),
    ...timestamps(),
  },
  (t) => [
    index("note_patient_idx").on(t.clinicId, t.patientId),
    index("note_appointment_idx").on(t.clinicId, t.appointmentId),
  ],
);
