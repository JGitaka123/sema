import { boolean, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { primaryId, timestamps } from "./columns.js";
import { clinicRef } from "./tenancy.js";

/**
 * The clinic's connected WhatsApp sender (INTEGRATIONS.md §1).
 *
 * ADR-001: one number per clinic, connected through Meta Embedded Signup with
 * Sema as Tech Provider. Phase 9 writes these rows from the onboarding wizard;
 * Phase 3 only reads them, to answer two questions:
 *
 *   1. inbound  — which clinic does `value.metadata.phone_number_id` belong to?
 *   2. outbound — which `phone_number_id` and token do we send this with?
 *
 * The inbound direction is the awkward one: the webhook has to resolve a
 * clinic *before* it has a tenant context, and RLS is forced on this table
 * like every other. That lookup therefore goes through the
 * `sema_resolve_clinic_by_phone_number_id()` SECURITY DEFINER function created
 * in the same migration, which returns a clinic id and nothing else. See
 * `src/routing.ts`.
 *
 * `access_token_encrypted` holds the ciphertext of the system-user token
 * (ARCHITECTURE.md §9: envelope encryption). Phase 3 reads it through
 * `packages/db`'s accessor only; it is never logged, never returned by an API
 * route, and never put in a job payload.
 */
export const clinicWhatsapp = pgTable(
  "clinic_whatsapp",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    /** Meta WhatsApp Business Account id. */
    wabaId: text("waba_id").notNull(),
    /** The Graph API sender: `POST /{phone_number_id}/messages`. */
    phoneNumberId: text("phone_number_id").notNull(),
    /** The number as patients see it, E.164. Not PHI — it is the clinic's. */
    displayPhoneNumber: text("display_phone_number"),
    displayName: text("display_name"),
    /** Meta quality rating: `GREEN` | `YELLOW` | `RED` (COMPLIANCE.md §3). */
    qualityRating: text("quality_rating"),
    /** Ciphertext only. Never a plaintext token in a column. */
    accessTokenEncrypted: text("access_token_encrypted"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    // Global, not per-clinic: a phone_number_id maps to exactly one clinic, and
    // routing depends on that being true. Two clinics claiming one sender would
    // deliver one clinic's patients into another's inbox.
    uniqueIndex("clinic_whatsapp_phone_number_id_key").on(t.phoneNumberId),
    index("clinic_whatsapp_clinic_idx").on(t.clinicId),
  ],
);
