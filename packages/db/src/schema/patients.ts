import { sql } from "drizzle-orm";
import { boolean, date, index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { primaryId, timestamps, tz } from "./columns.js";
import { consentKind } from "./enums.js";
import { clinicRef } from "./tenancy.js";

/**
 * A patient of one clinic. Deliberately *not* global: the same phone number at
 * two clinics is two patient rows, because a patient record is health data
 * belonging to that clinic as controller (COMPLIANCE.md §1).
 *
 * `phone_e164` is PHI-adjacent identifying data: never log it raw, use
 * `maskPhone` from `@sema/shared`.
 */
export const patient = pgTable(
  "patient",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    phoneE164: text("phone_e164").notNull(),
    /** WhatsApp id — E.164 without the "+". */
    waId: text("wa_id"),
    fullName: text("full_name"),
    preferredName: text("preferred_name"),
    language: text("language"),
    dob: date("dob"),
    sex: text("sex"),
    notesInternal: text("notes_internal"),
    /** `{vip:bool, blocked:bool, no_show_count:int}` */
    flags: jsonb("flags")
      .notNull()
      .default(sql`'{}'::jsonb`),
    firstSeenAt: tz("first_seen_at"),
    lastMessageAt: tz("last_message_at"),
    ...timestamps(),
  },
  // Doubles as the DATA_MODEL "Indexes (minimum)" entry for
  // patient(clinic_id, phone_e164) — inbound WhatsApp resolves a patient by it
  // on every message.
  (t) => [uniqueIndex("patient_clinic_phone_key").on(t.clinicId, t.phoneE164)],
);

/**
 * Consent evidence. Kenya DPA 2019 requires explicit consent for health data,
 * and Meta requires stored opt-in evidence before any template send
 * (COMPLIANCE.md §1, §3).
 */
export const patientConsent = pgTable(
  "patient_consent",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    patientId: text("patient_id")
      .notNull()
      .references(() => patient.id),
    kind: consentKind("kind").notNull(),
    granted: boolean("granted").notNull(),
    /** e.g. `first_contact_notice`, `inbox`, `stop_keyword`. */
    source: text("source"),
    evidenceMessageId: text("evidence_message_id"),
    at: tz("at").notNull().defaultNow(),
    ...timestamps(),
  },
  // Consent is append-only history; "current" is the newest row per kind.
  (t) => [index("patient_consent_patient_kind_idx").on(t.patientId, t.kind, t.at)],
);
