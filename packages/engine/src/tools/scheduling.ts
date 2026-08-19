import { AppError, formatInTz, formatMoney, money, type CurrencyCode } from "@sema/shared";
import type { z } from "zod";

import type { AgentContext } from "../context.js";
import {
  bookAppointmentSchema,
  cancelAppointmentSchema,
  holdSlotSchema,
  JSON_SCHEMAS,
  lookupAppointmentsSchema,
  rescheduleAppointmentSchema,
  searchSlotsSchema,
} from "./schemas.js";
import { requestDepositFor } from "./deposit.js";
import { defineTool, type AnyToolDefinition, type ToolOutcome } from "./types.js";

/**
 * The scheduling tools.
 *
 * Every one of them delegates to `@sema/scheduling`. None of them does slot
 * maths, hold expiry, overlap checking or policy evaluation of its own — those
 * live in one package with a property test and a concurrency test behind them,
 * and a second implementation here would be a second set of bugs.
 *
 * What this file *does* own is the translation between the model's vocabulary
 * (ISO strings, prefixed ids, "3 slots please") and the scheduler's, and the
 * decision about what a failure looks like to the model: a typed `AppError`
 * becomes a structured, non-fatal tool result with a code the agent can act on,
 * because "that slot just went" is a conversation, not a crash.
 */

/** CONVERSATION_ENGINE.md §3.1: "offer 2–3 slots max". */
export const DEFAULT_SLOT_LIMIT = 3;
export const MAX_SLOT_LIMIT = 3;

/** How far ahead a search may reach when the model asks for more. */
const MAX_SEARCH_SPAN_MS = 60 * 24 * 3_600_000;

function fmt(instant: Date, context: AgentContext): string {
  return formatInTz(instant, context.clinic.timezone, "EEE d MMM, h:mm a");
}

function isoInTz(instant: Date, context: AgentContext): string {
  return formatInTz(instant, context.clinic.timezone, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

/**
 * Turn a thrown error into a tool result.
 *
 * A tool that throws aborts the agent turn and loses the conversation; a tool
 * that returns `{ok: false, code}` lets the agent say "that time has just been
 * taken, shall I look for another?". Only genuinely unexpected errors are
 * rethrown, and `AppError.expose` is what decides which is which.
 */
function failure(error: unknown, fallbackCode: string): ToolOutcome {
  if (AppError.is(error)) {
    const typed: AppError = error;
    return {
      ok: false,
      result: {
        error: typed.code,
        // Only exposable messages: an internal error string could carry a
        // stack, a SQL fragment or an id from outside this tenant, and the
        // model would happily read it back to the patient.
        detail: typed.expose ? typed.message : null,
        guidance:
          "This did not happen. Tell the patient plainly what the result says and offer the next step. Do not claim anything was booked, moved or cancelled.",
      },
    };
  }
  // Not one of ours: a bug or an outage, not a conversation. Let it reach the
  // loop, which turns it into the safe fallback plus an escalation.
  throw error instanceof Error ? error : new Error(fallbackCode);
}

export const searchSlotsTool: AnyToolDefinition = defineTool<z.infer<typeof searchSlotsSchema>>({
  name: "search_slots",
  description:
    "Find real bookable times for a service. Returns at most 3. Every slot it returns is one you may offer; anything it does not return does not exist. Always call this before naming a time.",
  schema: searchSlotsSchema,
  jsonSchema: JSON_SCHEMAS["search_slots"] ?? {},
  mutating: false,

  async execute(input, runtime): Promise<ToolOutcome> {
    const from = new Date(input.from);
    const requestedTo = new Date(input.to);
    const to = new Date(Math.min(requestedTo.getTime(), from.getTime() + MAX_SEARCH_SPAN_MS));
    const limit = Math.min(input.limit ?? DEFAULT_SLOT_LIMIT, MAX_SLOT_LIMIT);

    let found;
    try {
      found = await runtime.deps.scheduler.searchSlots({
        clinicId: runtime.clinicId,
        serviceId: input.service_id,
        ...(input.provider_id == null ? {} : { providerId: input.provider_id }),
        from,
        to,
        limit,
      });
    } catch (error) {
      await runtime.audit({
        action: "agent.tool.search_slots",
        entity: "conversation",
        entityId: runtime.conversationId,
        meta: { service_id: input.service_id, outcome: "error" },
      });
      return failure(error, "search_slots_failed");
    }

    await runtime.audit({
      action: "agent.tool.search_slots",
      entity: "conversation",
      entityId: runtime.conversationId,
      meta: {
        service_id: input.service_id,
        provider_id: input.provider_id ?? null,
        returned: found.slots.length,
        total: found.total,
      },
    });

    const providerNames = new Map(
      runtime.context.providers.map((provider) => [provider.id, provider.displayName]),
    );

    const slots = found.slots.map((slot) => ({
      provider_id: slot.providerId,
      provider_name: providerNames.get(slot.providerId) ?? null,
      service_id: input.service_id,
      // Both forms: the human one is what the agent may quote, the machine one
      // is what `hold_slot` must be given back verbatim.
      start: isoInTz(slot.start, runtime.context),
      start_display: fmt(slot.start, runtime.context),
      end_display: fmt(slot.end, runtime.context),
    }));

    return {
      ok: true,
      result: {
        slots,
        total_available: found.total,
        ...(found.slots.length === 0
          ? {
              guidance:
                "There is nothing in that window. Say so, and offer to look at a different day. Do not invent a time.",
            }
          : {}),
      },
      facts: slots.flatMap((slot) => [
        slot.start_display,
        slot.end_display,
        ...(slot.provider_name === null ? [] : [slot.provider_name]),
      ]),
      ...(slots.length === 0
        ? {}
        : {
            effects: {
              // The buttons are built from what the scheduler returned, never
              // from what the model wrote — so a tap can only ever pick a real
              // slot. WhatsApp caps a button title at 20 characters.
              offerOptions: slots.map((slot) => ({
                id: `slot:${slot.provider_id}:${slot.start}`,
                title: slot.start_display.slice(0, 20),
              })),
            },
          }),
    };
  },
});

export const holdSlotTool: AnyToolDefinition = defineTool<z.infer<typeof holdSlotSchema>>({
  name: "hold_slot",
  description:
    "Reserve a slot for 10 minutes while you confirm details with the patient. Use the exact start value search_slots gave you. Holding is not booking — you must still call book_appointment.",
  schema: holdSlotSchema,
  jsonSchema: JSON_SCHEMAS["hold_slot"] ?? {},
  mutating: true,

  async execute(input, runtime): Promise<ToolOutcome> {
    let held;
    try {
      held = await runtime.deps.scheduler.holdSlot({
        clinicId: runtime.clinicId,
        providerId: input.provider_id,
        serviceId: input.service_id,
        start: new Date(input.start),
        patientId: runtime.patientId,
        conversationId: runtime.conversationId,
      });
    } catch (error) {
      await runtime.audit({
        action: "agent.tool.hold_slot",
        entity: "conversation",
        entityId: runtime.conversationId,
        meta: {
          provider_id: input.provider_id,
          service_id: input.service_id,
          outcome: "unavailable",
        },
      });
      return failure(error, "hold_slot_failed");
    }

    await runtime.audit({
      action: "agent.tool.hold_slot",
      entity: "slot_hold",
      entityId: held.holdId,
      meta: {
        provider_id: held.providerId,
        service_id: held.serviceId,
        starts_at: held.start.toISOString(),
        expires_at: held.expiresAt.toISOString(),
      },
    });

    return {
      ok: true,
      result: {
        hold_id: held.holdId,
        start_display: fmt(held.start, runtime.context),
        end_display: fmt(held.end, runtime.context),
        expires_at_display: formatInTz(
          held.expiresAt,
          runtime.context.clinic.timezone,
          "h:mm a",
        ),
        guidance:
          "The slot is yours for 10 minutes. Confirm the details with the patient, then call book_appointment with this hold_id.",
      },
      facts: [fmt(held.start, runtime.context), fmt(held.end, runtime.context)],
    };
  },
});

export const bookAppointmentTool: AnyToolDefinition = defineTool<
  z.infer<typeof bookAppointmentSchema>
>({
  name: "book_appointment",
  description:
    "Turn a hold into a real appointment. Ask the service's intake questions first and pass the answers. If the service needs a deposit the appointment is created as pending_deposit and the M-Pesa prompt is requested automatically — tell the patient that, and do not call it confirmed until the deposit is paid.",
  schema: bookAppointmentSchema,
  jsonSchema: JSON_SCHEMAS["book_appointment"] ?? {},
  mutating: true,

  async execute(input, runtime): Promise<ToolOutcome> {
    let booked;
    try {
      booked = await runtime.deps.scheduler.book({
        clinicId: runtime.clinicId,
        holdId: input.hold_id,
        patientId: runtime.patientId,
        ...(input.intake_answers === undefined ? {} : { intakeAnswers: input.intake_answers }),
        ...(input.visit_reason == null ? {} : { visitReason: input.visit_reason }),
        source: "agent",
        actor: { kind: "agent" },
      });
    } catch (error) {
      await runtime.audit({
        action: "agent.tool.book_appointment",
        entity: "conversation",
        entityId: runtime.conversationId,
        meta: { hold_id: input.hold_id, outcome: "failed" },
      });
      return failure(error, "book_appointment_failed");
    }

    const { appointment, depositRequiredMinor } = booked;
    const currency = runtime.context.clinic.currency as CurrencyCode;

    await runtime.audit({
      action: "agent.tool.book_appointment",
      entity: "appointment",
      entityId: appointment.id,
      meta: {
        provider_id: appointment.providerId,
        service_id: appointment.serviceId,
        status: appointment.status,
        starts_at: appointment.start.toISOString(),
        deposit_required_minor: depositRequiredMinor,
      },
    });

    // §3.2: "if deposit required → status pending_deposit and auto-calls
    // request_deposit". Doing it here rather than trusting the model to make a
    // second call means a booking can never sit in `pending_deposit` with
    // nobody ever having been asked to pay.
    const deposit =
      depositRequiredMinor > 0
        ? await requestDepositFor(runtime, appointment.id, depositRequiredMinor)
        : null;

    const service = runtime.context.services.find((s) => s.id === appointment.serviceId);
    const provider = runtime.context.providers.find((p) => p.id === appointment.providerId);
    const startDisplay = fmt(appointment.start, runtime.context);
    const depositDisplay =
      depositRequiredMinor > 0 ? formatMoney(money(depositRequiredMinor, currency)) : null;

    return {
      ok: true,
      result: {
        appointment_id: appointment.id,
        status: appointment.status,
        service_name: service?.name ?? null,
        provider_name: provider?.displayName ?? null,
        start_display: startDisplay,
        deposit_required: depositRequiredMinor > 0,
        deposit: depositDisplay,
        deposit_request: deposit,
        guidance:
          depositRequiredMinor > 0
            ? "The appointment is held as pending_deposit. Tell the patient the deposit amount and that an M-Pesa prompt is on its way to this number. Do not say the booking is confirmed yet."
            : "The appointment is booked. Confirm the day, time, provider and location back to the patient, and mention the cancellation policy once.",
      },
      facts: [
        startDisplay,
        ...(service === undefined ? [] : [service.name]),
        ...(provider === undefined ? [] : [provider.displayName]),
        ...(depositDisplay === null ? [] : [depositDisplay]),
      ],
    };
  },
});

export const lookupAppointmentsTool: AnyToolDefinition = defineTool<
  z.infer<typeof lookupAppointmentsSchema>
>({
  name: "lookup_appointments",
  description:
    "List this patient's own upcoming appointments, with their apt_ ids. Call it before rescheduling or cancelling so you are working from real ids. It only ever returns this patient's own bookings.",
  schema: lookupAppointmentsSchema,
  jsonSchema: JSON_SCHEMAS["lookup_appointments"] ?? {},
  mutating: false,

  async execute(_input, runtime): Promise<ToolOutcome> {
    // Read from the context rather than re-querying: it was loaded in the same
    // tenant transaction, already filtered to this patient, and re-reading
    // opens a window where an id from another patient could be joined in.
    const upcoming = runtime.context.patient.upcoming;

    await runtime.audit({
      action: "agent.tool.lookup_appointments",
      entity: "patient",
      entityId: runtime.patientId,
      meta: { returned: upcoming.length },
    });

    const facts: string[] = [];
    const appointments = upcoming.map((appointment) => {
      const display = fmt(appointment.start, runtime.context);
      facts.push(display, appointment.serviceName, appointment.providerName);
      return {
        appointment_id: appointment.id,
        service_id: appointment.serviceId,
        service_name: appointment.serviceName,
        provider_name: appointment.providerName,
        start_display: display,
        status: appointment.status,
        deposit_outstanding: appointment.depositPaidMinor < appointment.depositRequiredMinor,
      };
    });

    return {
      ok: true,
      result: {
        appointments,
        ...(appointments.length === 0
          ? { guidance: "This patient has nothing booked. Offer to find them a time." }
          : {}),
      },
      facts,
    };
  },
});

export const rescheduleAppointmentTool: AnyToolDefinition = defineTool<
  z.infer<typeof rescheduleAppointmentSchema>
>({
  name: "reschedule_appointment",
  description:
    "Move an existing appointment to a new time you have already held. The clinic's notice policy is applied by this tool — call it and report what it says rather than deciding yourself whether a move is allowed.",
  schema: rescheduleAppointmentSchema,
  jsonSchema: JSON_SCHEMAS["reschedule_appointment"] ?? {},
  mutating: true,

  async execute(input, runtime): Promise<ToolOutcome> {
    let moved;
    try {
      moved = await runtime.deps.scheduler.reschedule({
        clinicId: runtime.clinicId,
        appointmentId: input.appointment_id,
        newHoldId: input.new_hold_id,
        actor: { kind: "patient" },
      });
    } catch (error) {
      await runtime.audit({
        action: "agent.tool.reschedule_appointment",
        entity: "appointment",
        entityId: input.appointment_id,
        meta: { outcome: "refused" },
      });
      return failure(error, "reschedule_failed");
    }

    await runtime.audit({
      action: "agent.tool.reschedule_appointment",
      entity: "appointment",
      entityId: moved.appointment.id,
      meta: {
        previous_appointment_id: moved.previousAppointmentId,
        status: moved.appointment.status,
        starts_at: moved.appointment.start.toISOString(),
        policy_outcome: moved.policy.outcome,
        deposit_forfeited: moved.policy.depositForfeited,
      },
    });

    const startDisplay = fmt(moved.appointment.start, runtime.context);
    return {
      ok: true,
      result: {
        appointment_id: moved.appointment.id,
        status: moved.appointment.status,
        start_display: startDisplay,
        policy_outcome: moved.policy.outcome,
        deposit_forfeited: moved.policy.depositForfeited,
        guidance:
          moved.policy.depositForfeited
            ? "The move was inside the clinic's window, so the old deposit does not carry over and a new one is needed. Say that plainly and without apologising twice. Never promise a refund."
            : "The appointment has moved. Confirm the new day and time back to the patient.",
      },
      facts: [startDisplay],
    };
  },
});

export const cancelAppointmentTool: AnyToolDefinition = defineTool<
  z.infer<typeof cancelAppointmentSchema>
>({
  name: "cancel_appointment",
  description:
    "Cancel one of this patient's appointments. The clinic's cancellation policy is applied by this tool. Never promise a refund — whether money comes back is the clinic's decision, not yours.",
  schema: cancelAppointmentSchema,
  jsonSchema: JSON_SCHEMAS["cancel_appointment"] ?? {},
  mutating: true,

  async execute(input, runtime): Promise<ToolOutcome> {
    let cancelled;
    try {
      cancelled = await runtime.deps.scheduler.cancel({
        clinicId: runtime.clinicId,
        appointmentId: input.appointment_id,
        actor: { kind: "patient" },
        ...(input.reason == null ? {} : { reason: input.reason }),
      });
    } catch (error) {
      await runtime.audit({
        action: "agent.tool.cancel_appointment",
        entity: "appointment",
        entityId: input.appointment_id,
        meta: { outcome: "refused" },
      });
      return failure(error, "cancel_failed");
    }

    await runtime.audit({
      action: "agent.tool.cancel_appointment",
      entity: "appointment",
      entityId: cancelled.appointment.id,
      meta: {
        status: cancelled.appointment.status,
        policy_outcome: cancelled.policy.outcome,
        deposit_forfeited: cancelled.policy.depositForfeited,
      },
    });

    return {
      ok: true,
      result: {
        appointment_id: cancelled.appointment.id,
        status: cancelled.appointment.status,
        policy_outcome: cancelled.policy.outcome,
        deposit_forfeited: cancelled.policy.depositForfeited,
        guidance: cancelled.policy.depositForfeited
          ? "Cancelled. It was inside the clinic's window, so the deposit is not returned. State that once, do not apologise repeatedly, and do not promise a refund or offer to ask for one."
          : "Cancelled, with nothing owed. Offer to book another time when they are ready.",
      },
    };
  },
});
