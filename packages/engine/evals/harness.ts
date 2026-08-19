import type { Scheduler } from "@sema/scheduling";
import { AppError, fixedClock, formatInTz } from "@sema/shared";

import { runAgent, type AgentRunResult } from "../src/agent.js";
import type { EngineClient } from "../src/client.js";
import { type AgentContext, type HistoryMessage } from "../src/context.js";
import { fakeTenantDb, testContext } from "../src/testing.js";
import type { DepositRequester } from "../src/tools/types.js";

/**
 * The agent eval harness.
 *
 * The agent suites drive the **real model** against a **synthetic clinic**: the
 * Afyanex-shaped `testContext()` fixture, and an in-memory scheduler that
 * generates slots from fixed rules. No Postgres, no Redis, no seed.
 *
 * That combination is deliberate. An eval has to be reproducible to be worth
 * gating a deploy on, and a database that a migration or a seed change can move
 * under it is the opposite of reproducible — a red suite would mean "someone
 * edited the fixture" as often as it meant "the agent regressed". Here the
 * clinic's facts are a constant, so the only thing that can move is the model
 * and the prompt, which is exactly what the suite is measuring.
 *
 * The scheduler's *correctness* is not what is under test — `@sema/scheduling`
 * has its own property and concurrency tests against a real Postgres. What is
 * under test is whether the agent calls it, believes it, and never invents a
 * time it did not return.
 */

/** 08:00 Nairobi on Thursday 20 August 2026. */
export const EVAL_NOW = new Date("2026-08-20T05:00:00Z");
export const EVAL_TZ = "Africa/Nairobi";

const HOUR = 3_600_000;

interface MemoryAppointment {
  id: string;
  providerId: string;
  serviceId: string;
  start: Date;
  end: Date;
  status: string;
  depositRequiredMinor: number;
  depositPaidMinor: number;
}

interface MemoryHold {
  id: string;
  providerId: string;
  serviceId: string;
  start: Date;
  end: Date;
  blockEnd: Date;
  expiresAt: Date;
}

export interface MemoryWorld {
  readonly scheduler: Scheduler;
  readonly depositRequester: DepositRequester;
  readonly appointments: Map<string, MemoryAppointment>;
  readonly holds: Map<string, MemoryHold>;
  readonly deposits: { appointmentId: string; amountMinor: number }[];
  /** Every start instant `search_slots` has ever returned. */
  readonly offered: Set<number>;
  now(): Date;
}

/**
 * Working hours for the synthetic clinic, matching `testContext()`:
 * Mon–Fri 08:00–17:00, Sat 09:00–13:00, closed Sunday. Wall clock in Nairobi,
 * which is UTC+3 all year (no DST), so the arithmetic can stay simple here in a
 * way it deliberately does not in `@sema/scheduling`.
 */
const NAIROBI_OFFSET_MS = 3 * HOUR;

function localParts(instant: Date): { weekday: number; hour: number; minute: number; dayStartUtc: Date } {
  const local = new Date(instant.getTime() + NAIROBI_OFFSET_MS);
  const dayStartUtc = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - NAIROBI_OFFSET_MS,
  );
  return {
    weekday: local.getUTCDay(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    dayStartUtc,
  };
}

function windowFor(weekday: number): { open: number; close: number } | undefined {
  if (weekday === 0) return undefined; // closed Sunday
  if (weekday === 6) return { open: 9, close: 13 };
  return { open: 8, close: 17 };
}

/** Minutes a service occupies, including its buffer. */
function serviceShape(context: AgentContext, serviceId: string): { duration: number; buffer: number } {
  const service = context.services.find((candidate) => candidate.id === serviceId);
  if (!service) throw new AppError("NOT_FOUND", "Service not found.");
  return { duration: service.durationMin, buffer: 5 };
}

export function createMemoryWorld(context: AgentContext = testContext()): MemoryWorld {
  const appointments = new Map<string, MemoryAppointment>();
  const holds = new Map<string, MemoryHold>();
  const deposits: { appointmentId: string; amountMinor: number }[] = [];
  const offered = new Set<number>();
  let sequence = 0;

  const now = (): Date => EVAL_NOW;
  const id = (prefix: string): string =>
    `${prefix}_${String(sequence++).padStart(26, "0").replace(/0/g, "0")}`.slice(0, 30);

  /** Prefixed ULID-shaped ids, so the tools' own Zod checks are exercised. */
  const newId = (prefix: string): string => {
    sequence += 1;
    const body = sequence.toString(32).toUpperCase().padStart(26, "0");
    return `${prefix}_${body}`;
  };
  void id;

  const busy = (providerId: string, start: Date, end: Date): boolean => {
    for (const appointment of appointments.values()) {
      if (appointment.providerId !== providerId) continue;
      if (!["booked", "confirmed", "pending_deposit"].includes(appointment.status)) continue;
      if (appointment.start < end && start < appointment.end) return true;
    }
    for (const hold of holds.values()) {
      if (hold.providerId !== providerId) continue;
      if (hold.expiresAt <= now()) continue;
      if (hold.start < end && start < hold.blockEnd) return true;
    }
    return false;
  };

  /** Regenerate the day's grid, exactly as the real scheduler would. */
  const generate = (
    serviceId: string,
    providerId: string | undefined,
    from: Date,
    to: Date,
  ): { providerId: string; start: Date; end: Date; blockEnd: Date }[] => {
    const { duration, buffer } = serviceShape(context, serviceId);
    const providers = context.providers
      .filter((candidate) => candidate.serviceIds.includes(serviceId))
      .filter((candidate) => providerId === undefined || candidate.id === providerId)
      .map((candidate) => candidate.id);

    // Min notice, from the fixture's policy.
    const earliest = new Date(now().getTime() + context.policies.minNoticeMin * 60_000);
    const cursorFrom = new Date(Math.max(from.getTime(), earliest.getTime()));
    const slots: { providerId: string; start: Date; end: Date; blockEnd: Date }[] = [];

    for (let day = 0; day < 45; day += 1) {
      const probe = new Date(cursorFrom.getTime() + day * 24 * HOUR);
      const { weekday, dayStartUtc } = localParts(probe);
      const hours = windowFor(weekday);
      if (!hours) continue;

      for (let minute = hours.open * 60; minute + duration <= hours.close * 60; minute += 15) {
        const start = new Date(dayStartUtc.getTime() + minute * 60_000);
        if (start < cursorFrom || start >= to) continue;
        const end = new Date(start.getTime() + duration * 60_000);
        const blockEnd = new Date(end.getTime() + buffer * 60_000);
        for (const provider of providers) {
          if (busy(provider, start, blockEnd)) continue;
          slots.push({ providerId: provider, start, end, blockEnd });
        }
      }
    }

    return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
  };

  type Arg<K extends keyof Scheduler> = Parameters<Scheduler[K]>[0];

  const scheduler: Scheduler = {
    searchSlots: async (input: Arg<"searchSlots">) => {
      const found = generate(
        input.serviceId,
        input.providerId ?? undefined,
        input.from,
        input.to,
      ).slice(0, input.limit ?? 3);
      for (const slot of found) offered.add(slot.start.getTime());
      return {
        slots: found.map((slot) => ({ ...slot, locationId: "loc_1" })),
        total: found.length,
        timezone: EVAL_TZ,
      };
    },

    holdSlot: async (input: Arg<"holdSlot">) => {
      const candidates = generate(
        input.serviceId,
        input.providerId,
        new Date(input.start.getTime() - 1),
        new Date(input.start.getTime() + 1),
      );
      const slot = candidates.find((candidate) => candidate.start.getTime() === input.start.getTime());
      if (!slot) {
        // The exact failure the real scheduler produces for a time the clinic's
        // own rules do not generate — which is how an invented slot is caught.
        throw new AppError("VALIDATION_FAILED", "That time is not available for this service.");
      }
      const holdId = newId("hld");
      holds.set(holdId, {
        id: holdId,
        providerId: slot.providerId,
        serviceId: input.serviceId,
        start: slot.start,
        end: slot.end,
        blockEnd: slot.blockEnd,
        expiresAt: new Date(now().getTime() + 10 * 60_000),
      });
      return {
        holdId,
        clinicId: context.clinic.id,
        providerId: slot.providerId,
        serviceId: input.serviceId,
        patientId: input.patientId ?? null,
        conversationId: input.conversationId ?? null,
        start: slot.start,
        end: slot.end,
        blockEnd: slot.blockEnd,
        expiresAt: new Date(now().getTime() + 10 * 60_000),
      };
    },

    book: async (input: Arg<"book">) => {
      const hold = holds.get(input.holdId);
      if (!hold) throw new AppError("CONFLICT", "That reservation has expired.");
      holds.delete(input.holdId);

      const service = context.services.find((candidate) => candidate.id === hold.serviceId);
      const depositRequiredMinor = service?.depositMinor ?? 0;
      const appointmentId = newId("apt");
      const appointment: MemoryAppointment = {
        id: appointmentId,
        providerId: hold.providerId,
        serviceId: hold.serviceId,
        start: hold.start,
        end: hold.end,
        status: depositRequiredMinor > 0 ? "pending_deposit" : "booked",
        depositRequiredMinor,
        depositPaidMinor: 0,
      };
      appointments.set(appointmentId, appointment);
      return {
        appointment: {
          ...appointment,
          clinicId: context.clinic.id,
          patientId: input.patientId,
          locationId: null,
          source: "agent",
          visitReason: input.visitReason ?? null,
          depositStatus: null,
          rescheduleOf: null,
          cancelledReason: null,
        },
        depositRequiredMinor,
      };
    },

    reschedule: async (input: Arg<"reschedule">) => {
      const previous = appointments.get(input.appointmentId);
      if (!previous) throw new AppError("NOT_FOUND", "Appointment not found.");
      const hold = holds.get(input.newHoldId);
      if (!hold) throw new AppError("CONFLICT", "That reservation has expired.");

      const hoursUntil = (previous.start.getTime() - now().getTime()) / HOUR;
      if (hoursUntil < 0) {
        throw new AppError("CONFLICT", "That appointment can no longer be rescheduled.");
      }
      const outcome =
        hoursUntil >= context.policies.freeRescheduleHours
          ? "free"
          : hoursUntil >= context.policies.forfeitHours
            ? "fee"
            : "forfeit";

      holds.delete(input.newHoldId);
      previous.status = "rescheduled";
      const nextId = newId("apt");
      const next: MemoryAppointment = {
        id: nextId,
        providerId: hold.providerId,
        serviceId: previous.serviceId,
        start: hold.start,
        end: hold.end,
        status:
          previous.depositRequiredMinor > 0 && outcome === "forfeit" ? "pending_deposit" : "booked",
        depositRequiredMinor: previous.depositRequiredMinor,
        depositPaidMinor: outcome === "forfeit" ? 0 : previous.depositPaidMinor,
      };
      appointments.set(nextId, next);

      return {
        appointment: {
          ...next,
          clinicId: context.clinic.id,
          patientId: context.patient.id,
          locationId: null,
          source: "agent",
          visitReason: null,
          depositStatus: null,
          rescheduleOf: previous.id,
          cancelledReason: null,
        },
        previousAppointmentId: previous.id,
        policy: {
          outcome,
          allowed: true,
          hoursUntilStart: hoursUntil,
          depositForfeited: outcome === "forfeit",
          clinicInitiated: false,
          policy: {
            freeRescheduleHours: context.policies.freeRescheduleHours,
            forfeitHours: context.policies.forfeitHours,
          },
          reason: `reschedule.${outcome}`,
        },
      };
    },

    cancel: async (input: Arg<"cancel">) => {
      const appointment = appointments.get(input.appointmentId);
      if (!appointment) throw new AppError("NOT_FOUND", "Appointment not found.");
      const hoursUntil = (appointment.start.getTime() - now().getTime()) / HOUR;
      if (hoursUntil < 0) {
        throw new AppError("CONFLICT", "That appointment can no longer be cancelled.");
      }
      const outcome =
        hoursUntil >= context.policies.freeRescheduleHours
          ? "free"
          : hoursUntil >= context.policies.forfeitHours
            ? "fee"
            : "forfeit";
      appointment.status = "cancelled_by_patient";

      return {
        appointment: {
          ...appointment,
          clinicId: context.clinic.id,
          patientId: context.patient.id,
          locationId: null,
          source: "agent",
          visitReason: null,
          depositStatus: outcome === "forfeit" ? "forfeited" : null,
          rescheduleOf: null,
          cancelledReason: input.reason ?? null,
        },
        policy: {
          outcome,
          allowed: true,
          hoursUntilStart: hoursUntil,
          depositForfeited: outcome === "forfeit",
          clinicInitiated: false,
          policy: {
            freeRescheduleHours: context.policies.freeRescheduleHours,
            forfeitHours: context.policies.forfeitHours,
          },
          reason: `cancel.${outcome}`,
        },
      };
    },

    expireHolds: async () => ({ clinics: 0, deleted: 0 }),
  } as unknown as Scheduler;

  const depositRequester: DepositRequester = {
    async request(input) {
      deposits.push({ appointmentId: input.appointmentId, amountMinor: input.amountMinor });
      return { status: "requested", paymentRequestId: newId("pyr"), simulated: true };
    },
  };

  return { scheduler, depositRequester, appointments, holds, deposits, offered, now };
}

export interface FlowTurnResult {
  readonly patient: string;
  readonly run: AgentRunResult;
}

export interface FlowResult {
  readonly turns: readonly FlowTurnResult[];
  readonly world: MemoryWorld;
  readonly toolSequence: readonly string[];
  readonly replies: readonly string[];
  readonly escalations: readonly string[];
  readonly error?: string;
}

/**
 * Run a multi-turn conversation.
 *
 * Each turn rebuilds the context from the world's current state, exactly as the
 * worker does between messages — so an appointment booked on turn 3 is visible
 * to the patient card on turn 4, and a hold taken on turn 2 is listed as open.
 */
export async function runFlow(
  client: EngineClient,
  turns: readonly string[],
  options: { patientLanguage?: "en" | "sw" | "sheng" | "mixed"; base?: AgentContext } = {},
): Promise<FlowResult> {
  const base = options.base ?? testContext({ now: EVAL_NOW });
  const world = createMemoryWorld(base);
  const db = fakeTenantDb();

  const history: HistoryMessage[] = [];
  const results: FlowTurnResult[] = [];
  const toolSequence: string[] = [];
  const replies: string[] = [];
  const escalations: string[] = [];

  for (const [index, patientText] of turns.entries()) {
    const context: AgentContext = {
      ...base,
      now: EVAL_NOW,
      history: [...history],
      agentTurnsToday: index,
      openHolds: [...world.holds.values()]
        .filter((hold) => hold.expiresAt > world.now())
        .map((hold) => ({
          id: hold.id,
          providerId: hold.providerId,
          serviceId: hold.serviceId,
          start: hold.start,
          end: hold.end,
          expiresAt: hold.expiresAt,
        })),
      patient: {
        ...base.patient,
        upcoming: [...world.appointments.values()]
          .filter((appointment) =>
            ["pending_deposit", "booked", "confirmed"].includes(appointment.status),
          )
          .map((appointment) => ({
            id: appointment.id,
            serviceId: appointment.serviceId,
            serviceName:
              base.services.find((service) => service.id === appointment.serviceId)?.name ?? "visit",
            providerId: appointment.providerId,
            providerName:
              base.providers.find((provider) => provider.id === appointment.providerId)
                ?.displayName ?? "the clinician",
            start: appointment.start,
            end: appointment.end,
            status: appointment.status,
            depositRequiredMinor: appointment.depositRequiredMinor,
            depositPaidMinor: appointment.depositPaidMinor,
          })),
      },
    };

    let run: AgentRunResult;
    try {
      run = await runAgent(
        {
          clinicId: context.clinic.id,
          conversationId: context.conversationId,
          patientId: context.patient.id,
          message: patientText,
          context,
          patientLanguage: options.patientLanguage ?? "en",
        },
        {
          client,
          withTenantDb: db.withTenantDb as never,
          scheduler: world.scheduler,
          clock: fixedClock(EVAL_NOW),
          depositRequester: world.depositRequester,
          now: () => EVAL_NOW,
        },
      );
    } catch (error) {
      return {
        turns: results,
        world,
        toolSequence,
        replies,
        escalations,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    results.push({ patient: patientText, run });
    toolSequence.push(...run.toolCalls.map((call) => call.name));
    if (run.escalation) escalations.push(run.escalation.kind);

    const text = run.replies
      .filter((reply): reply is { kind: "text"; body: string } => reply.kind === "text")
      .map((reply) => reply.body)
      .join("\n");
    replies.push(text);

    history.push({ role: "patient", sentBy: null, text: patientText, at: EVAL_NOW });
    if (text !== "") history.push({ role: "clinic", sentBy: "agent", text, at: EVAL_NOW });
  }

  return { turns: results, world, toolSequence, replies, escalations };
}

/** A single-turn run, for the grounding and language suites. */
export async function runSingle(
  client: EngineClient,
  text: string,
  options: { patientLanguage?: "en" | "sw" | "sheng" | "mixed" } = {},
): Promise<FlowResult> {
  return runFlow(client, [text], options);
}

/** Human-readable clinic time, for failure reports. */
export function atClinic(instant: Date): string {
  return formatInTz(instant, EVAL_TZ, "EEE d MMM, h:mm a");
}
