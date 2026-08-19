import type { TenantDb } from "@sema/db";
import { newId } from "@sema/shared";

import { dateKeyInTz, endOfKey, startOfKey } from "./calendar.js";
import { loadSchedulingContext, slotsFrom } from "./context.js";
import { assertId, mapSlotConflict, notBookable, slotUnavailable } from "./errors.js";
import {
  deleteExpiredHolds,
  deleteExpiredHoldsForProvider,
  hasConflictingAppointment,
  insertHold,
  loadClinicSettings,
} from "./repository.js";
import type { SchedulingDeps, Slot } from "./types.js";

/**
 * Slot holds — the 10-minute reservation the agent takes while it confirms
 * details with the patient (ARCHITECTURE.md §4).
 */

export const HOLD_TTL_MINUTES = 10;

export interface HoldSlotInput {
  clinicId: string;
  providerId: string;
  serviceId: string;
  /** The patient-visible start. The stored range adds the service buffer. */
  start: Date;
  patientId?: string | null;
  conversationId?: string | null;
  allowNonPatientBookable?: boolean;
}

export interface HeldSlot {
  readonly holdId: string;
  readonly clinicId: string;
  readonly providerId: string;
  readonly serviceId: string;
  readonly patientId: string | null;
  readonly conversationId: string | null;
  readonly start: Date;
  readonly end: Date;
  readonly blockEnd: Date;
  readonly expiresAt: Date;
}

/**
 * Reserve a slot.
 *
 * Correctness is the database's, not this function's: the GiST exclusion
 * constraint `exclude using gist (provider_id with =, slot with &&)` rejects
 * the second of two concurrent inserts, and `mapSlotConflict` turns that
 * rejection into `SLOT_UNAVAILABLE`. There is deliberately no "check then
 * insert" — that loses the race.
 *
 * The constraint is unconditional (packages/db/README.md: an index predicate
 * must be IMMUTABLE and `now()` is not), so an expired hold would keep
 * blocking its slot forever. Deleting this provider's expired holds happens in
 * the *same transaction* as the insert, which is what makes expiry invisible
 * to the caller.
 */
export async function holdSlot(deps: SchedulingDeps, input: HoldSlotInput): Promise<HeldSlot> {
  const clinicId = assertId("clinic", input.clinicId, "clinicId");
  const providerId = assertId("provider", input.providerId, "providerId");
  const serviceId = assertId("service", input.serviceId, "serviceId");
  if (input.patientId) assertId("patient", input.patientId, "patientId");
  if (input.conversationId) assertId("conversation", input.conversationId, "conversationId");

  const now = deps.clock.now();
  const holdId = newId("slotHold");

  return mapSlotConflict(
    () =>
      deps.withTenantDb(clinicId, async (db) => {
        const slot = await resolveOfferedSlot(db, {
          clinicId,
          providerId,
          serviceId,
          start: input.start,
          now,
          allowNonPatientBookable: input.allowNonPatientBookable ?? false,
        });

        // Holds and appointments live in different tables, so no single
        // constraint covers both. The appointment exclusion constraint is
        // still the final word at `book()`; this check keeps the agent from
        // promising a slot that is already taken.
        if (await hasConflictingAppointment(db, clinicId, providerId, slot.start, slot.blockEnd)) {
          throw slotUnavailable({ providerId });
        }

        await deleteExpiredHoldsForProvider(db, clinicId, providerId);

        const expiresAt = await insertHold(db, {
          id: holdId,
          clinicId,
          providerId,
          serviceId,
          patientId: input.patientId ?? null,
          conversationId: input.conversationId ?? null,
          start: slot.start,
          end: slot.blockEnd,
          ttlMinutes: HOLD_TTL_MINUTES,
        });

        return {
          holdId,
          clinicId,
          providerId,
          serviceId,
          patientId: input.patientId ?? null,
          conversationId: input.conversationId ?? null,
          start: slot.start,
          end: slot.end,
          blockEnd: slot.blockEnd,
          expiresAt,
        } satisfies HeldSlot;
      }),
    { providerId },
  );
}

/**
 * Re-derive the requested slot from the clinic's own rules.
 *
 * Regenerating the clinic-local day and requiring an exact start match is what
 * enforces granularity, min notice, the booking window, working hours and time
 * off on the write path — not just on the search path.
 */
async function resolveOfferedSlot(
  db: TenantDb,
  input: {
    clinicId: string;
    providerId: string;
    serviceId: string;
    start: Date;
    now: Date;
    allowNonPatientBookable: boolean;
  },
): Promise<Slot> {
  // The clinic-local day is needed before the search window can be framed, so
  // the timezone is read on its own first.
  const { timezone } = await loadClinicSettings(db, input.clinicId);
  const dayKey = dateKeyInTz(input.start, timezone);

  const context = await loadSchedulingContext(db, {
    clinicId: input.clinicId,
    serviceId: input.serviceId,
    providerId: input.providerId,
    from: startOfKey(dayKey, timezone),
    to: endOfKey(dayKey, timezone),
    now: input.now,
    allowNonPatientBookable: input.allowNonPatientBookable,
  });

  const wanted = input.start.getTime();
  const slot = slotsFrom(context).find(
    (candidate) =>
      candidate.providerId === input.providerId && candidate.start.getTime() === wanted,
  );
  if (!slot) {
    throw notBookable("That time is not available for this service.", {
      providerId: input.providerId,
    });
  }
  return slot;
}

export interface ExpireHoldsInput {
  /**
   * The clinics to sweep. Passed in rather than discovered: this package never
   * reads across tenants — a cross-tenant enumeration is the caller's job
   * (ARCHITECTURE.md §3: system jobs "iterate clinics and call `withTenant`
   * per clinic").
   */
  clinicIds: readonly string[];
}

export interface ExpireHoldsResult {
  readonly clinics: number;
  readonly deleted: number;
}

/**
 * Housekeeping: delete holds whose TTL has passed.
 *
 * Purely hygienic. Nothing depends on it for correctness — slot search ignores
 * expired holds (`expires_at > now()`) and `holdSlot` clears a provider's
 * expired holds before inserting — but without it the table grows forever.
 */
export async function expireHolds(
  deps: SchedulingDeps,
  input: ExpireHoldsInput,
): Promise<ExpireHoldsResult> {
  let deleted = 0;
  let clinics = 0;
  for (const raw of input.clinicIds) {
    const clinicId = assertId("clinic", raw, "clinicId");
    deleted += await deps.withTenantDb(clinicId, (db) => deleteExpiredHolds(db, clinicId));
    clinics += 1;
  }
  return { clinics, deleted };
}
