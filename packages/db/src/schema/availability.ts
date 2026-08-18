import { sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, text, time } from "drizzle-orm/pg-core";

import { primaryId, timestamps, tz } from "./columns.js";
import { provider } from "./staff.js";
import { clinicRef, location } from "./tenancy.js";

/**
 * Weekly recurring working hours per provider. `start_local` / `end_local` are
 * wall-clock times in the clinic timezone — the only place local time is
 * stored, because "Tuesdays 09:00" survives a DST-style rule change and a UTC
 * instant would not.
 */
export const availabilityRule = pgTable(
  "availability_rule",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    locationId: text("location_id").references(() => location.id),
    /** 0 = Sunday … 6 = Saturday (JS `Date#getDay`). */
    weekday: integer("weekday").notNull(),
    startLocal: time("start_local").notNull(),
    endLocal: time("end_local").notNull(),
    validFrom: date("valid_from"),
    validTo: date("valid_to"),
    ...timestamps(),
  },
  (t) => [
    check("availability_rule_weekday_check", sql`${t.weekday} between 0 and 6`),
    index("availability_rule_provider_idx").on(t.clinicId, t.providerId, t.weekday),
  ],
);

/** Leave, public holidays, clinic closures. `provider_id` null = whole clinic. */
export const timeOff = pgTable(
  "time_off",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    providerId: text("provider_id").references(() => provider.id),
    startsAt: tz("starts_at").notNull(),
    endsAt: tz("ends_at").notNull(),
    reason: text("reason"),
    ...timestamps(),
  },
  (t) => [index("time_off_clinic_window_idx").on(t.clinicId, t.startsAt, t.endsAt)],
);
