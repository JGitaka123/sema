import type { TenantClient } from "@sema/db";
import { newId } from "@sema/shared";

import { writeAudit } from "./audit.js";
import { parseReminderConfig, PRE_VISIT_KINDS, type PreVisitKind } from "./config.js";
import { planPreVisitReminders } from "./plan.js";
import {
  insertReminder,
  loadAppointment,
  loadClinic,
  loadRemindersFor,
  skipScheduledReminders,
  updateReminderDueAt,
} from "./repository.js";
import { REMINDABLE_STATUSES } from "./decide.js";

/**
 * Keeping an appointment's reminders in step with the appointment.
 *
 * This is one **reconciler**, not three lifecycle hooks. Given an appointment
 * id it derives the reminders that appointment *should* have and makes the
 * database say so — which covers booking, rescheduling and cancelling with the
 * same code path, and means running it twice changes nothing the second time.
 *
 * Why a reconciler rather than a callback inside `@sema/scheduling`:
 *
 *  - `reschedule()` does not mutate an appointment, it creates a new row and
 *    marks the old one `rescheduled`. A hook would have to fire for both. The
 *    reconciler simply sees two appointments and gives each the reminders its
 *    status deserves.
 *  - Staff will change appointments from the inbox (Phase 8) and payments will
 *    move `pending_deposit → confirmed` (Phase 6). Neither of those goes
 *    through `book()`. A hook there would quietly miss them; the sweep does not.
 *  - `packages/scheduling` is another phase's code. Reacting to its outcomes
 *    from the worker keeps that package unchanged.
 *
 * Callers that want reminders to exist *immediately* (the agent, after
 * `book()`) call `syncAppointmentReminders` inside their own tenant
 * transaction. Everyone else is covered by `reminder.sync`, the periodic sweep
 * in `jobs/reminders.ts`, within its interval. **That is the seam Phase 5 uses:
 * one exported function, one argument, safe to call as often as you like.**
 */

export interface SyncInput {
  readonly clinicId: string;
  readonly appointmentId: string;
  readonly now: Date;
}

export interface SyncResult {
  readonly appointmentId: string;
  readonly created: number;
  readonly rescheduled: number;
  readonly cancelled: number;
  readonly reason?: "not_found" | "inactive" | "disabled";
}

const NO_CHANGE = { created: 0, rescheduled: 0, cancelled: 0 } as const;

/**
 * Reconcile one appointment's pre-visit reminders.
 *
 * Runs inside a caller-supplied tenant transaction so that "book the
 * appointment and schedule its reminders" can be one atomic act.
 *
 * Never touches `no_show_rebook` rows: those belong to the no-show job, which
 * creates them precisely when the appointment leaves the remindable statuses
 * this function cares about.
 */
export async function syncAppointmentReminders(
  client: TenantClient,
  input: SyncInput,
): Promise<SyncResult> {
  const appointment = await loadAppointment(client, input.clinicId, input.appointmentId);
  if (!appointment) {
    return { appointmentId: input.appointmentId, ...NO_CHANGE, reason: "not_found" };
  }

  const existing = await loadRemindersFor(client, input.clinicId, input.appointmentId);
  const scheduled = new Map<string, (typeof existing)[number]>();
  const settled = new Set<string>();
  for (const reminder of existing) {
    if (reminder.status === "scheduled") scheduled.set(reminder.kind, reminder);
    // `sent`, `skipped` and `failed` are all history. Re-creating a reminder
    // that already went out is how a patient gets told twice.
    else settled.add(reminder.kind);
  }

  const active = (REMINDABLE_STATUSES as readonly string[]).includes(appointment.status);
  if (!active) {
    const cancelled = await skipScheduledReminders(
      client,
      input.clinicId,
      input.appointmentId,
      PRE_VISIT_KINDS,
    );
    if (cancelled > 0) {
      await writeAudit(client, {
        clinicId: input.clinicId,
        actor: "system",
        action: "reminder.cancelled",
        entity: "appointment",
        entityId: input.appointmentId,
        after: { cancelled, appointmentStatus: appointment.status },
        reason: "appointment_inactive",
      });
    }
    return {
      appointmentId: input.appointmentId,
      created: 0,
      rescheduled: 0,
      cancelled,
      reason: "inactive",
    };
  }

  const clinic = await loadClinic(client, input.clinicId);
  if (!clinic) {
    return { appointmentId: input.appointmentId, ...NO_CHANGE, reason: "not_found" };
  }

  const config = parseReminderConfig(clinic.flags, appointment.serviceId);
  const planned = planPreVisitReminders({
    start: appointment.start,
    timezone: clinic.timezone,
    config,
    now: input.now,
  });
  const plannedByKind = new Map<PreVisitKind, Date>(planned.map((p) => [p.kind, p.dueAt]));

  let created = 0;
  let rescheduledCount = 0;
  let cancelled = 0;

  for (const kind of PRE_VISIT_KINDS) {
    const want = plannedByKind.get(kind);
    const have = scheduled.get(kind);

    if (want === undefined) {
      // No longer wanted: the offset was turned off, reminders were disabled,
      // or the appointment moved so close that the moment has already passed.
      if (have) {
        cancelled += await skipScheduledReminders(client, input.clinicId, input.appointmentId, [
          kind,
        ]);
      }
      continue;
    }

    if (settled.has(kind)) continue;

    if (!have) {
      await insertReminder(client, {
        id: newId("reminder"),
        clinicId: input.clinicId,
        appointmentId: input.appointmentId,
        kind,
        dueAt: want,
      });
      created += 1;
      continue;
    }

    if (have.dueAt.getTime() !== want.getTime()) {
      await updateReminderDueAt(client, input.clinicId, have.id, want);
      rescheduledCount += 1;
    }
  }

  if (created > 0 || rescheduledCount > 0 || cancelled > 0) {
    await writeAudit(client, {
      clinicId: input.clinicId,
      actor: "system",
      action: "reminder.scheduled",
      entity: "appointment",
      entityId: input.appointmentId,
      after: {
        created,
        rescheduled: rescheduledCount,
        cancelled,
        appointmentStatus: appointment.status,
      },
    });
  }

  return {
    appointmentId: input.appointmentId,
    created,
    rescheduled: rescheduledCount,
    cancelled,
    ...(config.enabled ? {} : { reason: "disabled" as const }),
  };
}
