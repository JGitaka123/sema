import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";

import { primaryId, timestamps, tz } from "./columns.js";
import { outboxStatus } from "./enums.js";
import { message } from "./conversations.js";
import { clinicRef } from "./tenancy.js";

/**
 * Every effectful action, especially the agent's (hard rule 7).
 *
 * `before`/`after` hold the changed fields only — an audit row must never
 * become a second copy of a message body or a phone number.
 * Retention: 7 years (DATA_MODEL.md §Retention).
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    /** `agent` | `staff:<id>` | `system` | `patient` */
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    at: tz("at").notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index("audit_log_clinic_at_idx").on(t.clinicId, t.at),
    index("audit_log_entity_idx").on(t.clinicId, t.entity, t.entityId),
  ],
);

/**
 * Outbound delivery queue. Request handlers never call WhatsApp directly
 * (CLAUDE.md §Conventions): they write here and the worker delivers, retries
 * with backoff and dead-letters.
 */
export const outbox = pgTable(
  "outbox",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    messageId: text("message_id").references(() => message.id),
    channel: text("channel").notNull().default("whatsapp"),
    payload: jsonb("payload").notNull(),
    status: outboxStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: tz("next_attempt_at"),
    lastError: text("last_error"),
    ...timestamps(),
  },
  (t) => [
    index("outbox_status_next_attempt_idx").on(t.status, t.nextAttemptAt),
    index("outbox_clinic_status_idx").on(t.clinicId, t.status),
  ],
);

/**
 * Inbound webhook dedup (CLAUDE.md §Idempotency).
 *
 * The only table with no `clinic_id`, and therefore the only one without RLS:
 * the webhook handler must dedup *before* it has resolved which clinic the
 * payload belongs to, and Meta/Daraja ids are opaque vendor strings, not
 * patient data. The migration repeats this reasoning next to the policies.
 */
export const webhookDedup = pgTable(
  "webhook_dedup",
  {
    /** `whatsapp` | `daraja` */
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    receivedAt: tz("received_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.externalId] }),
    index("webhook_dedup_received_at_idx").on(t.receivedAt),
  ],
);

/** Sema's own billing relationship with the clinic. Never patient money. */
export const subscription = pgTable("subscription", {
  id: primaryId(),
  clinicId: clinicRef().unique(),
  plan: text("plan").notNull(),
  status: text("status").notNull(),
  seats: integer("seats"),
  conversationQuota: integer("conversation_quota"),
  periodStart: date("period_start"),
  periodEnd: date("period_end"),
  provider: text("provider"),
  providerRef: text("provider_ref"),
  ...timestamps(),
});

/** Per-clinic usage counters, keyed by the first day of the billing period. */
export const usageMeter = pgTable(
  "usage_meter",
  {
    clinicId: clinicRef(),
    period: date("period").notNull(),
    conversations: integer("conversations").notNull().default(0),
    messagesOut: integer("messages_out").notNull().default(0),
    templatesSent: integer("templates_sent").notNull().default(0),
    modelTokens: bigint("model_tokens", { mode: "number" }).notNull().default(0),
    ...timestamps(),
  },
  (t) => [primaryKey({ columns: [t.clinicId, t.period] })],
);
