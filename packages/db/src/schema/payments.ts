import { bigint, char, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";

import { primaryId, timestamps, tz } from "./columns.js";
import { paymentRequestStatus } from "./enums.js";
import { appointment } from "./scheduling.js";
import { patient } from "./patients.js";
import { clinicRef } from "./tenancy.js";

/**
 * A deposit we asked the patient for.
 *
 * ADR-003 / hard rule 5: funds settle straight into the clinic's own M-Pesa
 * shortcode. These two tables are a *record of what Daraja told us*, not a
 * ledger — there is no balance, no hold, no refund path here.
 */
export const paymentRequest = pgTable(
  "payment_request",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    appointmentId: text("appointment_id").references(() => appointment.id),
    patientId: text("patient_id").references(() => patient.id),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    provider: text("provider").notNull().default("mpesa_daraja"),
    status: paymentRequestStatus("status").notNull(),
    /** Daraja's idempotency key for the STK push callback. */
    checkoutRequestId: text("checkout_request_id").unique(),
    merchantRequestId: text("merchant_request_id"),
    phoneE164: text("phone_e164").notNull(),
    /** `agent` | `staff:<id>` | `system` */
    initiatedBy: text("initiated_by"),
    failureReason: text("failure_reason"),
    expiresAt: tz("expires_at"),
    ...timestamps(),
  },
  (t) => [
    index("payment_request_clinic_status_idx").on(t.clinicId, t.status),
    index("payment_request_appointment_idx").on(t.appointmentId),
  ],
);

/** A confirmed M-Pesa receipt. `raw` keeps the callback for reconciliation. */
export const payment = pgTable(
  "payment",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    paymentRequestId: text("payment_request_id")
      .notNull()
      .references(() => paymentRequest.id),
    /** M-Pesa receipt number. Staff-visible only (COMPLIANCE.md §4). */
    providerReceipt: text("provider_receipt").unique(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }),
    paidAt: tz("paid_at"),
    raw: jsonb("raw"),
    ...timestamps(),
  },
  (t) => [index("payment_request_idx").on(t.paymentRequestId)],
);
