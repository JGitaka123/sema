import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";

import { primaryId, timestamps } from "./columns.js";
import { provider } from "./staff.js";
import { clinicRef } from "./tenancy.js";

/**
 * What the clinic sells. `price_minor` / `deposit_minor` are integer minor
 * units of the clinic currency (CLAUDE.md §Conventions — no floats).
 */
export const service = pgTable(
  "service",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    name: text("name").notNull(),
    category: text("category"),
    durationMin: integer("duration_min").notNull(),
    bufferMin: integer("buffer_min").notNull().default(0),
    priceMinor: bigint("price_minor", { mode: "number" }),
    priceNote: text("price_note"),
    depositMinor: bigint("deposit_minor", { mode: "number" }).notNull().default(0),
    /**
     * Generated, not stored by the app: "requires a deposit" must never drift
     * from "has a deposit amount".
     */
    requiresDeposit: boolean("requires_deposit").generatedAlwaysAs(sql`deposit_minor > 0`),
    patientBookable: boolean("patient_bookable").notNull().default(true),
    descriptionPublic: text("description_public"),
    prepInstructions: text("prep_instructions"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [index("service_clinic_idx").on(t.clinicId, t.isActive)],
);

/** Which providers offer which service — drives slot search (ARCHITECTURE.md §4). */
export const providerService = pgTable(
  "provider_service",
  {
    clinicId: clinicRef(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.providerId, t.serviceId] }),
    index("provider_service_clinic_idx").on(t.clinicId),
  ],
);

/** Questions the agent must ask before booking a given service. */
export const serviceIntakeQuestion = pgTable(
  "service_intake_question",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id),
    question: text("question").notNull(),
    /** `text` | `yes_no` | `choice` */
    kind: text("kind").notNull().default("text"),
    choices: jsonb("choices"),
    required: boolean("required").notNull().default(true),
    sort: integer("sort").notNull().default(0),
    ...timestamps(),
  },
  (t) => [index("service_intake_question_service_idx").on(t.serviceId, t.sort)],
);
