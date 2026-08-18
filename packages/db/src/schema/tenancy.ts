import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, numeric, pgTable, text, char, index } from "drizzle-orm/pg-core";

import { primaryId, timestamps, tz } from "./columns.js";

/**
 * The tenant root.
 *
 * Every other tenant table carries `clinic_id` and is isolated by the
 * `tenant_isolation` RLS policy (ARCHITECTURE.md §3). `clinic` itself is
 * isolated on its own `id`.
 */
export const clinic = pgTable(
  "clinic",
  {
    id: primaryId(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    country: char("country", { length: 2 }).notNull().default("KE"),
    timezone: text("timezone").notNull().default("Africa/Nairobi"),
    currency: char("currency", { length: 3 }).notNull().default("KES"),
    defaultLanguage: text("default_language").notNull().default("en"),
    emergencyContactPhone: text("emergency_contact_phone"),
    emergencyScriptOverride: text("emergency_script_override"),
    bookingWindowDays: integer("booking_window_days").notNull().default(30),
    minNoticeMin: integer("min_notice_min").notNull().default(60),
    slotGranularityMin: integer("slot_granularity_min").notNull().default(15),
    /** `{free_reschedule_hours:24, forfeit_hours:2}` */
    cancellationPolicy: jsonb("cancellation_policy")
      .notNull()
      .default(sql`'{}'::jsonb`),
    flags: jsonb("flags")
      .notNull()
      .default(sql`'{}'::jsonb`),
    plan: text("plan").notNull().default("trial"),
    onboardingState: jsonb("onboarding_state")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * KMPDC facility licence number, captured at onboarding and verified
     * before go-live (COMPLIANCE.md §5: "KMPDC-registered clinics only as
     * customers … stored on `clinic`").
     */
    kmpdcLicenceNo: text("kmpdc_licence_no"),
    ...timestamps(),
    deletedAt: tz("deleted_at"),
  },
  (t) => [index("clinic_deleted_at_idx").on(t.deletedAt)],
);

/**
 * `clinic_id` foreign key, present on every tenant table. Defined here so the
 * reference and the RLS story stay in one place.
 */
export const clinicRef = () =>
  text("clinic_id")
    .notNull()
    .references(() => clinic.id);

export const location = pgTable(
  "location",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    name: text("name").notNull(),
    address: text("address"),
    lat: numeric("lat"),
    lng: numeric("lng"),
    mapsUrl: text("maps_url"),
    phone: text("phone"),
    isPrimary: boolean("is_primary").notNull().default(false),
    ...timestamps(),
  },
  (t) => [index("location_clinic_idx").on(t.clinicId)],
);
