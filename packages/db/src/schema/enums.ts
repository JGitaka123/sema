import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Enums, verbatim from docs/DATA_MODEL.md §Enums.
 *
 * Adding a value is a migration (`alter type … add value`); removing one is a
 * breaking change. Keep the order the doc uses so diffs stay readable.
 */

export const staffRole = pgEnum("staff_role", ["owner", "admin", "staff", "provider"]);

export const conversationMode = pgEnum("conversation_mode", ["agent", "human", "muted"]);

export const conversationStatus = pgEnum("conversation_status", ["open", "resolved", "archived"]);

export const messageDirection = pgEnum("message_direction", ["in", "out"]);

export const messageKind = pgEnum("message_kind", [
  "text",
  "audio",
  "image",
  "document",
  "location",
  "interactive",
  "template",
  "system",
]);

export const messageStatus = pgEnum("message_status", [
  "received",
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
]);

export const appointmentStatus = pgEnum("appointment_status", [
  "held",
  "pending_deposit",
  "booked",
  "confirmed",
  "arrived",
  "completed",
  "no_show",
  "cancelled_by_patient",
  "cancelled_by_clinic",
  "rescheduled",
]);

export const paymentRequestStatus = pgEnum("payment_request_status", [
  "initiated",
  "pushed",
  "paid",
  "failed",
  "cancelled",
  "timeout",
  "waived",
]);

export const escalationKind = pgEnum("escalation_kind", [
  "emergency",
  "distress",
  "complaint",
  "payment_issue",
  "low_confidence",
  "patient_requested",
  "abusive",
  "out_of_scope",
  "agent_error",
]);

export const escalationStatus = pgEnum("escalation_status", ["open", "acknowledged", "resolved"]);

/**
 * Output of the safety classifier (SAFETY.md). No table stores it as a column
 * yet — `escalation.classifier_output` keeps the full payload as jsonb — but
 * the type exists so Phase 4 cannot drift from the documented vocabulary.
 */
export const classifierCategory = pgEnum("classifier_category", [
  "normal",
  "emergency",
  "distress",
  "out_of_scope",
  "abusive",
  "spam",
]);

export const reminderKind = pgEnum("reminder_kind", [
  "pre_24h",
  "pre_2h",
  "no_show_rebook",
  "post_visit",
  "recall",
  "custom",
]);

export const outboxStatus = pgEnum("outbox_status", [
  "pending",
  "sending",
  "sent",
  "failed",
  "dead",
]);

export const consentKind = pgEnum("consent_kind", [
  "service_messages",
  "marketing",
  "data_processing",
]);

/** The statuses in which an appointment occupies its provider's calendar. */
export const OCCUPYING_APPOINTMENT_STATUSES = [
  "booked",
  "confirmed",
  "arrived",
  "pending_deposit",
] as const;
