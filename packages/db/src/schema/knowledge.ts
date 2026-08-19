import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { primaryId, timestamps } from "./columns.js";
import { clinicRef } from "./tenancy.js";

/**
 * The clinic's own words. This is the *only* factual ground the agent may
 * answer from (CONVERSATION_ENGINE.md grounding rules) — if it is not here or
 * in the schedule, the agent says it does not know and offers a human.
 */
export const knowledgeItem = pgTable(
  "knowledge_item",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    /** hours|location|services|pricing|insurance|policies|faq|prep|staff */
    category: text("category").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    isPublic: boolean("is_public").notNull().default(true),
    sort: integer("sort").notNull().default(0),
    updatedBy: text("updated_by"),
    ...timestamps(),
  },
  (t) => [index("knowledge_item_clinic_category_idx").on(t.clinicId, t.category, t.sort)],
);

/** Registered WhatsApp message templates per clinic and language. */
export const template = pgTable(
  "template",
  {
    id: primaryId(),
    clinicId: clinicRef(),
    name: text("name").notNull(),
    language: text("language").notNull(),
    metaTemplateId: text("meta_template_id"),
    /** Meta category: `utility` | `marketing` | `authentication`. */
    category: text("category"),
    /** Meta approval status: `pending` | `approved` | `rejected` | `paused`. */
    status: text("status"),
    body: text("body"),
    variables: jsonb("variables"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("template_clinic_name_language_key").on(t.clinicId, t.name, t.language)],
);
