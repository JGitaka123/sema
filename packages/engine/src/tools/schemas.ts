import { z } from "zod";

import { ESCALATION_KINDS } from "../types.js";

/**
 * Tool input schemas and their JSON Schema twins.
 *
 * Two representations of the same shape, on purpose: the model is *described*
 * by the JSON Schema and *checked* by the Zod one. If the model invents a
 * field, sends a string where a number belongs, or passes an id from another
 * clinic's format, the Zod parse rejects it before the handler runs (CLAUDE.md
 * §AI: "Every tool call is validated with Zod before execution and audited").
 *
 * The two are kept in step by `schemas.test.ts`, which round-trips a valid
 * example of each through both.
 */

/** An id must at least *look* like one of ours before it touches a query. */
const idLike = (prefix: string): z.ZodString =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`), `expected a ${prefix}_ id`);

/**
 * An instant, as ISO-8601. The model is told to work in clinic time and to
 * include the offset; a bare local time would be ambiguous exactly when it
 * matters most (a booking near midnight).
 */
const isoInstant = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "expected an ISO-8601 datetime");

export const getClinicInfoSchema = z
  .object({
    topic: z.string().min(1).max(64),
  })
  .strict();

export const listServicesSchema = z
  .object({
    query: z.string().min(1).max(120).optional(),
  })
  .strict();

export const searchSlotsSchema = z
  .object({
    service_id: idLike("svc"),
    provider_id: idLike("prv").nullish(),
    from: isoInstant,
    to: isoInstant,
    limit: z.number().int().min(1).max(5).optional(),
  })
  .strict();

export const holdSlotSchema = z
  .object({
    provider_id: idLike("prv"),
    service_id: idLike("svc"),
    start: isoInstant,
  })
  .strict();

export const bookAppointmentSchema = z
  .object({
    hold_id: idLike("hld"),
    /** Answers to the service's configured intake questions, question → answer. */
    intake_answers: z.record(z.string(), z.string().max(500)).optional(),
    visit_reason: z.string().max(300).nullish(),
  })
  .strict();

export const lookupAppointmentsSchema = z.object({}).strict();

export const rescheduleAppointmentSchema = z
  .object({
    appointment_id: idLike("apt"),
    new_hold_id: idLike("hld"),
  })
  .strict();

export const cancelAppointmentSchema = z
  .object({
    appointment_id: idLike("apt"),
    reason: z.string().max(300).nullish(),
  })
  .strict();

export const requestDepositSchema = z
  .object({
    appointment_id: idLike("apt"),
  })
  .strict();

export const escalateSchema = z
  .object({
    kind: z.enum(ESCALATION_KINDS),
    /**
     * Goes into `escalation.reason` and an audit row, both of which staff and
     * auditors read — so it is a short PHI-free explanation, not a retelling of
     * what the patient said.
     */
    reason: z.string().min(1).max(200),
  })
  .strict();

export const addNoteSchema = z
  .object({
    body: z.string().min(1).max(1000),
  })
  .strict();

export const sendLocationSchema = z.object({}).strict();

// ── JSON Schema twins ────────────────────────────────────────────────────────

const str = (description: string): Record<string, unknown> => ({ type: "string", description });

export const JSON_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = {
  get_clinic_info: {
    type: "object",
    properties: {
      topic: str(
        "What the patient asked about: hours, location, pricing, insurance, policies, prep, faq, staff, services — or a free-text phrase to match against the clinic's own notes.",
      ),
    },
    required: ["topic"],
    additionalProperties: false,
  },
  list_services: {
    type: "object",
    properties: {
      query: str("Optional words to filter by, e.g. 'dental' or 'antenatal'. Omit to list everything."),
    },
    required: [],
    additionalProperties: false,
  },
  search_slots: {
    type: "object",
    properties: {
      service_id: str("The svc_ id from the clinic facts. Never guess one."),
      provider_id: str("Optional prv_ id when the patient asked for a specific clinician."),
      from: str("Earliest acceptable start, ISO-8601 with offset, e.g. 2026-08-20T09:00:00+03:00."),
      to: str("Latest acceptable start, ISO-8601 with offset."),
      limit: {
        type: "integer",
        description: "How many slots to return. Default 3, and never offer more than 3 at once.",
      },
    },
    required: ["service_id", "from", "to"],
    additionalProperties: false,
  },
  hold_slot: {
    type: "object",
    properties: {
      provider_id: str("The prv_ id of the clinician whose slot this is."),
      service_id: str("The svc_ id being booked."),
      start: str("The exact start returned by search_slots, ISO-8601 with offset."),
    },
    required: ["provider_id", "service_id", "start"],
    additionalProperties: false,
  },
  book_appointment: {
    type: "object",
    properties: {
      hold_id: str("The hld_ id returned by hold_slot."),
      intake_answers: {
        type: "object",
        description:
          "The service's intake questions and the patient's answers, as question text to answer text. Ask them first; do not invent answers.",
        additionalProperties: { type: "string" },
      },
      visit_reason: str("The patient's own short words for why they are coming. Optional."),
    },
    required: ["hold_id"],
    additionalProperties: false,
  },
  lookup_appointments: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  reschedule_appointment: {
    type: "object",
    properties: {
      appointment_id: str("The apt_ id being moved."),
      new_hold_id: str("A hld_ id you have already taken for the new time."),
    },
    required: ["appointment_id", "new_hold_id"],
    additionalProperties: false,
  },
  cancel_appointment: {
    type: "object",
    properties: {
      appointment_id: str("The apt_ id being cancelled."),
      reason: str("The patient's short reason, if they gave one. Optional."),
    },
    required: ["appointment_id"],
    additionalProperties: false,
  },
  request_deposit: {
    type: "object",
    properties: {
      appointment_id: str("The apt_ id whose deposit is outstanding."),
    },
    required: ["appointment_id"],
    additionalProperties: false,
  },
  escalate: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: [...ESCALATION_KINDS],
        description: "Why a human is needed.",
      },
      reason: str(
        "One short line for the staff member picking this up. No symptoms, no quotes from the patient.",
      ),
    },
    required: ["kind", "reason"],
    additionalProperties: false,
  },
  add_note: {
    type: "object",
    properties: {
      body: str("A short internal note for staff. The patient never sees it."),
    },
    required: ["body"],
    additionalProperties: false,
  },
  send_location: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
};
