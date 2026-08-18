import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { citext, primaryId, timestamps, tz } from "./columns.js";
import { staffRole } from "./enums.js";
import { clinicRef } from "./tenancy.js";

/**
 * A person who logs into the inbox. Auth itself (magic link / OTP) is Phase 8;
 * this is the identity row it will hang off.
 */
export const staffUser = pgTable(
  "staff_user",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    /** citext: staff type their email in whatever case they like. */
    email: citext("email").notNull(),
    name: text("name").notNull(),
    role: staffRole("role").notNull(),
    phone: text("phone"),
    notifyPrefs: jsonb("notify_prefs")
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastSeenAt: tz("last_seen_at"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("staff_user_clinic_email_key").on(t.clinicId, t.email)],
);

/**
 * A bookable clinician. Not every provider is a staff_user (a visiting doctor
 * may never log in), hence the nullable link.
 */
export const provider = pgTable(
  "provider",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    staffUserId: text("staff_user_id").references(() => staffUser.id),
    displayName: text("display_name").notNull(),
    title: text("title"),
    specialty: text("specialty"),
    bioPublic: text("bio_public"),
    isActive: boolean("is_active").notNull().default(true),
    sort: integer("sort").notNull().default(0),
    ...timestamps(),
  },
  (t) => [index("provider_clinic_idx").on(t.clinicId, t.isActive)],
);
