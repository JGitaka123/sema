import type { TenantDb } from "@sema/db";
import { AppError, newId } from "@sema/shared";

import { assertId, holdExpired, mapSlotConflict } from "./errors.js";
import {
  cancellationStatus,
  evaluateCancellation,
  evaluateReschedule,
  parseCancellationPolicy,
  type PolicyDecision,
} from "./policy.js";
import {
  deleteHold,
  insertAppointment,
  insertAuditLog,
  loadClinicSettings,
  loadService,
  lockAppointment,
  lockHold,
  updateAppointmentStatus,
  type AppointmentRow,
  type HoldRow,
} from "./repository.js";
import {
  actorToAudit,
  BOOKING_SOURCES,
  CHANGEABLE_STATUSES,
  type Actor,
  type BookingSource,
  type SchedulingDeps,
} from "./types.js";

/**
 * Booking, rescheduling and cancelling.
 *
 * Three invariants hold across all three:
 *
 *  1. **One transaction.** A hold becomes an appointment, or nothing happens.
 *     The hold row is taken `for update` first, so two callers cannot spend
 *     the same reservation.
 *  2. **The database decides overlaps.** Every appointment insert runs through
 *     `mapSlotConflict`, so the GiST exclusion constraint — not a prior
 *     `select` — is what makes double-booking impossible.
 *  3. **Every change is audited** (CLAUDE.md hard rule 7) with ids, statuses
 *     and instants only: never a name, a phone number or a reason a patient
 *     typed about their health.
 */

export interface BookInput {
  clinicId: string;
  holdId: string;
  patientId: string;
  intakeAnswers?: Record<string, unknown>;
  visitReason?: string | null;
  source?: BookingSource;
  actor?: Actor;
  locationId?: string | null;
}

export interface BookResult {
  readonly appointment: AppointmentRow;
  readonly depositRequiredMinor: number;
}

function assertSource(source: string): BookingSource {
  if (!(BOOKING_SOURCES as readonly string[]).includes(source)) {
    throw new AppError("VALIDATION_FAILED", "Unknown booking source.");
  }
  return source as BookingSource;
}

async function takeHold(db: TenantDb, clinicId: string, holdId: string): Promise<HoldRow> {
  const hold = await lockHold(db, clinicId, holdId);
  if (!hold) throw holdExpired(holdId);
  if (hold.expired) {
    // Clear it on the way out so the slot is immediately free again.
    await deleteHold(db, clinicId, holdId);
    throw holdExpired(holdId);
  }
  return hold;
}

/**
 * Convert a hold into an appointment.
 *
 * A service with `deposit_minor > 0` produces a `pending_deposit` appointment —
 * which still occupies the calendar, because the exclusion constraint counts
 * it — and `deposit_required_minor` is recorded. **No payment is requested and
 * no money moves here**: that is Phase 6, and Sema never custodies funds
 * (ADR-003, hard rule 5).
 */
export async function book(deps: SchedulingDeps, input: BookInput): Promise<BookResult> {
  const clinicId = assertId("clinic", input.clinicId, "clinicId");
  const holdId = assertId("slotHold", input.holdId, "holdId");
  const patientId = assertId("patient", input.patientId, "patientId");
  const source = assertSource(input.source ?? "agent");
  const actor: Actor = input.actor ?? { kind: "agent" };

  return mapSlotConflict(() =>
    deps.withTenantDb(clinicId, async (db) => {
      const hold = await takeHold(db, clinicId, holdId);
      const service = await loadService(db, clinicId, hold.serviceId);

      const status = service.depositMinor > 0 ? "pending_deposit" : "booked";
      const appointmentId = newId("appointment");

      const appointment = await insertAppointment(db, {
        id: appointmentId,
        clinicId,
        patientId,
        providerId: hold.providerId,
        serviceId: hold.serviceId,
        locationId: input.locationId ?? null,
        start: hold.start,
        end: hold.end,
        status,
        source,
        intakeAnswers: input.intakeAnswers ?? {},
        visitReason: input.visitReason ?? null,
        depositRequiredMinor: service.depositMinor,
      });

      // The hold has done its job; releasing it in the same transaction means
      // the slot is never held twice over by its own appointment.
      await deleteHold(db, clinicId, holdId);

      await insertAuditLog(db, newId("auditLog"), {
        clinicId,
        actor: actorToAudit(actor),
        action: "appointment.booked",
        entity: "appointment",
        entityId: appointmentId,
        after: auditSnapshot(appointment),
        reason: `source:${source}`,
      });

      return { appointment, depositRequiredMinor: service.depositMinor };
    }),
  );
}

export interface RescheduleInput {
  clinicId: string;
  appointmentId: string;
  newHoldId: string;
  actor: Actor;
  reason?: string | null;
}

export interface RescheduleResult {
  readonly appointment: AppointmentRow;
  readonly previousAppointmentId: string;
  readonly policy: PolicyDecision;
}

/**
 * Move an appointment to a held slot.
 *
 * The old row becomes `rescheduled` — a status the exclusion constraint does
 * not count — which frees its slot inside the same transaction that claims the
 * new one. The new row points back through `reschedule_of`, so the history is
 * a chain rather than an overwrite.
 *
 * The policy decision is *recorded*, not enforced against a wallet: a
 * forfeited deposit simply does not carry across to the new appointment, and
 * whether the clinic refunds anything is the clinic's own M-Pesa action.
 */
export async function reschedule(
  deps: SchedulingDeps,
  input: RescheduleInput,
): Promise<RescheduleResult> {
  const clinicId = assertId("clinic", input.clinicId, "clinicId");
  const appointmentId = assertId("appointment", input.appointmentId, "appointmentId");
  const holdId = assertId("slotHold", input.newHoldId, "newHoldId");

  return mapSlotConflict(() =>
    deps.withTenantDb(clinicId, async (db) => {
      const previous = await lockAppointment(db, clinicId, appointmentId);
      if (!previous) throw new AppError("NOT_FOUND", "Appointment not found.");
      assertChangeable(previous, "reschedule");

      const clinic = await loadClinicSettings(db, clinicId);
      const decision = evaluateReschedule({
        policy: parseCancellationPolicy(clinic.cancellationPolicy),
        start: previous.start,
        clock: deps.clock,
        actor: input.actor,
      });
      if (!decision.allowed) {
        throw new AppError("CONFLICT", "That appointment can no longer be rescheduled.", {
          meta: { reason: decision.reason },
        });
      }

      const hold = await takeHold(db, clinicId, holdId);
      if (hold.serviceId !== previous.serviceId) {
        throw new AppError(
          "VALIDATION_FAILED",
          "The new time is for a different service. Book it as a new appointment.",
        );
      }

      await updateAppointmentStatus(db, {
        clinicId,
        appointmentId,
        status: "rescheduled",
      });

      const carriedDeposit = decision.depositForfeited ? 0 : previous.depositPaidMinor;
      const status =
        previous.depositRequiredMinor > 0 && carriedDeposit < previous.depositRequiredMinor
          ? "pending_deposit"
          : "booked";

      const nextId = newId("appointment");
      const appointment = await insertAppointment(db, {
        id: nextId,
        clinicId,
        patientId: previous.patientId,
        providerId: hold.providerId,
        serviceId: previous.serviceId,
        locationId: previous.locationId,
        start: hold.start,
        end: hold.end,
        status,
        source: previous.source,
        intakeAnswers: {},
        visitReason: previous.visitReason,
        depositRequiredMinor: previous.depositRequiredMinor,
        depositPaidMinor: carriedDeposit,
        rescheduleOf: appointmentId,
      });

      await deleteHold(db, clinicId, holdId);

      await insertAuditLog(db, newId("auditLog"), {
        clinicId,
        actor: actorToAudit(input.actor),
        action: "appointment.rescheduled",
        entity: "appointment",
        entityId: nextId,
        before: auditSnapshot(previous),
        after: {
          ...auditSnapshot(appointment),
          policyOutcome: decision.outcome,
          depositForfeited: decision.depositForfeited,
        },
        reason: input.reason ?? decision.reason,
      });

      return { appointment, previousAppointmentId: appointmentId, policy: decision };
    }),
  );
}

export interface CancelInput {
  clinicId: string;
  appointmentId: string;
  actor: Actor;
  reason?: string | null;
}

export interface CancelResult {
  readonly appointment: AppointmentRow;
  readonly policy: PolicyDecision;
}

/**
 * Cancel an appointment.
 *
 * The status records *who* cancelled (`cancelled_by_patient` vs
 * `cancelled_by_clinic`), and the policy decision records whether the clinic
 * may keep the deposit. Nothing is refunded here — see hard rule 5.
 */
export async function cancel(deps: SchedulingDeps, input: CancelInput): Promise<CancelResult> {
  const clinicId = assertId("clinic", input.clinicId, "clinicId");
  const appointmentId = assertId("appointment", input.appointmentId, "appointmentId");

  return deps.withTenantDb(clinicId, async (db) => {
    const existing = await lockAppointment(db, clinicId, appointmentId);
    if (!existing) throw new AppError("NOT_FOUND", "Appointment not found.");
    assertChangeable(existing, "cancel");

    const clinic = await loadClinicSettings(db, clinicId);
    const decision = evaluateCancellation({
      policy: parseCancellationPolicy(clinic.cancellationPolicy),
      start: existing.start,
      clock: deps.clock,
      actor: input.actor,
    });
    if (!decision.allowed) {
      throw new AppError("CONFLICT", "That appointment can no longer be cancelled.", {
        meta: { reason: decision.reason },
      });
    }

    const appointment = await updateAppointmentStatus(db, {
      clinicId,
      appointmentId,
      status: cancellationStatus(input.actor),
      cancelledReason: input.reason ?? decision.reason,
      depositStatus: decision.depositForfeited ? "forfeited" : null,
    });

    await insertAuditLog(db, newId("auditLog"), {
      clinicId,
      actor: actorToAudit(input.actor),
      action: "appointment.cancelled",
      entity: "appointment",
      entityId: appointmentId,
      before: auditSnapshot(existing),
      after: {
        ...auditSnapshot(appointment),
        policyOutcome: decision.outcome,
        depositForfeited: decision.depositForfeited,
      },
      reason: input.reason ?? decision.reason,
    });

    return { appointment, policy: decision };
  });
}

function assertChangeable(appointment: AppointmentRow, action: string): void {
  if (!(CHANGEABLE_STATUSES as readonly string[]).includes(appointment.status)) {
    throw new AppError("CONFLICT", `This appointment can no longer be changed.`, {
      meta: { action, status: appointment.status },
    });
  }
}

/** Non-PHI snapshot for `audit_log` (hard rule 4: ids and codes only). */
function auditSnapshot(appointment: AppointmentRow): Record<string, string | number | null> {
  return {
    appointmentId: appointment.id,
    providerId: appointment.providerId,
    serviceId: appointment.serviceId,
    status: appointment.status,
    startsAt: appointment.start.toISOString(),
    endsAt: appointment.end.toISOString(),
    depositRequiredMinor: appointment.depositRequiredMinor,
    depositPaidMinor: appointment.depositPaidMinor,
  };
}
