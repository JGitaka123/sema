import { sql } from "drizzle-orm";
import { bigint, index, jsonb, pgTable, text, type AnyPgColumn } from "drizzle-orm/pg-core";

import { primaryId, timestamps, tstzrange, tz } from "./columns.js";
import { appointmentStatus, reminderKind } from "./enums.js";
import { conversation } from "./conversations.js";
import { patient } from "./patients.js";
import { provider } from "./staff.js";
import { service } from "./catalog.js";
import { clinicRef, location } from "./tenancy.js";

/**
 * A short-lived reservation taken while the agent confirms details with the
 * patient (10 min TTL, ARCHITECTURE.md §4).
 *
 * The overlap guarantee is a Postgres EXCLUDE constraint, not application
 * logic — two concurrent agent turns must not both win the same slot. Drizzle
 * cannot express EXCLUDE, so it is raw SQL in the migration:
 *
 *   exclude using gist (provider_id with =, slot with &&)
 *     where (expires_at > now())
 */
export const slotHold = pgTable(
  "slot_hold",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id),
    patientId: text("patient_id").references(() => patient.id),
    conversationId: text("conversation_id").references(() => conversation.id),
    slot: tstzrange("slot").notNull(),
    expiresAt: tz("expires_at").notNull(),
    ...timestamps(),
  },
  (t) => [index("slot_hold_expires_at_idx").on(t.expiresAt)],
);

/**
 * The booking itself.
 *
 * The second EXCLUDE constraint (raw SQL in the migration) keeps one provider
 * from being double-booked across the statuses that actually occupy the
 * calendar:
 *
 *   exclude using gist (provider_id with =, slot with &&)
 *     where (status in ('booked','confirmed','arrived','pending_deposit'))
 */
export const appointment = pgTable(
  "appointment",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    patientId: text("patient_id")
      .notNull()
      .references(() => patient.id),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id),
    locationId: text("location_id").references(() => location.id),
    slot: tstzrange("slot").notNull(),
    status: appointmentStatus("status").notNull(),
    /** `agent` | `staff` | `walk_in` */
    source: text("source").notNull().default("agent"),
    intakeAnswers: jsonb("intake_answers")
      .notNull()
      .default(sql`'{}'::jsonb`),
    visitReason: text("visit_reason"),
    notes: text("notes"),
    depositRequiredMinor: bigint("deposit_required_minor", { mode: "number" }).notNull().default(0),
    depositPaidMinor: bigint("deposit_paid_minor", { mode: "number" }).notNull().default(0),
    depositStatus: text("deposit_status"),
    rescheduleOf: text("reschedule_of").references((): AnyPgColumn => appointment.id),
    cancelledReason: text("cancelled_reason"),
    arrivedAt: tz("arrived_at"),
    completedAt: tz("completed_at"),
    /** Phase 3 (claims): links to `encounter`. Unused in v1 (ADR-005). */
    encounterId: text("encounter_id"),
    ...timestamps(),
  },
  (t) => [
    index("appointment_clinic_provider_slot_idx").on(t.clinicId, t.providerId, t.slot),
    index("appointment_clinic_status_idx").on(t.clinicId, t.status),
    index("appointment_patient_idx").on(t.clinicId, t.patientId),
  ],
);

/** Scheduled outbound nudges. The worker claims rows by `(status, due_at)`. */
export const reminder = pgTable(
  "reminder",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    appointmentId: text("appointment_id")
      .notNull()
      .references(() => appointment.id),
    kind: reminderKind("kind").notNull(),
    dueAt: tz("due_at").notNull(),
    /** `scheduled` | `sent` | `skipped` | `failed` */
    status: text("status").notNull().default("scheduled"),
    jobId: text("job_id"),
    sentMessageId: text("sent_message_id"),
    ...timestamps(),
  },
  (t) => [index("reminder_status_due_at_idx").on(t.status, t.dueAt)],
);
