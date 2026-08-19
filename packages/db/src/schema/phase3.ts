import { index, pgTable, text } from "drizzle-orm/pg-core";

import { primaryId, timestamps, tz } from "./columns.js";
import { clinicRef } from "./tenancy.js";

/**
 * Phase 3 stubs — created now, unused in v1 (ADR-005, DATA_MODEL.md).
 *
 * They exist so the claims/RCM expansion is not a data migration of live
 * patient history later. **Do not build claims features against them in v1**
 * (CLAUDE.md §Out of scope).
 */

/** Who pays: SHA, a private insurer, a corporate scheme, or the patient. */
export const payer = pgTable(
  "payer",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    name: text("name").notNull(),
    /** `sha` | `private_insurer` | `corporate` | `cash` */
    kind: text("kind"),
    code: text("code"),
    ...timestamps(),
  },
  (t) => [index("payer_clinic_idx").on(t.clinicId)],
);

/** A visit that actually happened. `appointment.encounter_id` points here. */
export const encounter = pgTable(
  "encounter",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    patientId: text("patient_id"),
    appointmentId: text("appointment_id"),
    providerId: text("provider_id"),
    payerId: text("payer_id").references(() => payer.id),
    startedAt: tz("started_at"),
    endedAt: tz("ended_at"),
    externalRef: text("external_ref"),
    ...timestamps(),
  },
  (t) => [index("encounter_clinic_patient_idx").on(t.clinicId, t.patientId)],
);
