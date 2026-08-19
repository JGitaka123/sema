import { sql, type SQL } from "drizzle-orm";
import type { TenantDb } from "@sema/db";
import { AppError } from "@sema/shared";

import type { AvailabilityRule } from "./availability.js";
import type {
  BusyInterval,
  ClinicSchedulingSettings,
  ProviderId,
  ServiceSchedulingSettings,
} from "./types.js";

/**
 * Every read and write this package performs, in one place.
 *
 * Two rules hold throughout:
 *
 *  - **RLS is the guarantee, `clinic_id = …` is the belt.** Each statement is
 *    already inside `withTenantDb`, so the `tenant_isolation` policy applies;
 *    the explicit predicate is defence in depth and keeps the composite
 *    indexes usable.
 *  - **Ranges are computed by Postgres.** `lower(slot)`/`upper(slot)` do the
 *    unpacking, so no `tstzrange` literal is ever parsed in JavaScript — and
 *    they are read as epoch milliseconds, for the reason `epochMs` explains.
 */

/** `[start, end)` — the literal form the exclusion constraints operate on. */
export function rangeLiteral(start: Date, end: Date): string {
  if (end <= start) {
    throw new AppError("VALIDATION_FAILED", "A slot must end after it starts.");
  }
  return `[${start.toISOString()},${end.toISOString()})`;
}

async function rows<T>(db: TenantDb, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows: T[] };
  return result.rows ?? [];
}

async function affected(db: TenantDb, query: SQL): Promise<number> {
  const result = (await db.execute(query)) as unknown as { rowCount: number | null };
  return result.rowCount ?? 0;
}

const num = (value: unknown, fallback = 0): number => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
};

/**
 * Epoch **milliseconds** for a `timestamptz` expression.
 *
 * Drizzle's node-postgres driver installs a type parser that hands
 * `timestamptz` back as the raw Postgres string — `2030-01-07 06:00:00+00` —
 * which is not ISO-8601 and which `new Date()` parses by engine-specific
 * fallback rules (some readings land an hour or a timezone out). Asking
 * Postgres for a number instead removes the ambiguity, and it is why no query
 * in this file selects a bare instant.
 *
 * `sql.raw` is safe here: every caller passes a literal written in this file.
 */
function epochMs(expression: string): SQL {
  return sql.raw(`(extract(epoch from ${expression}) * 1000)::float8`);
}

/** Read a value produced by `epochMs`. `float8` arrives as a JS number. */
function instant(value: unknown): Date {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new AppError("INTERNAL", "Expected an epoch-millisecond timestamp.", { expose: false });
  }
  return new Date(Math.round(n));
}

export async function loadClinicSettings(
  db: TenantDb,
  clinicId: string,
): Promise<ClinicSchedulingSettings> {
  const found = await rows<{
    timezone: string;
    booking_window_days: number;
    min_notice_min: number;
    slot_granularity_min: number;
    currency: string;
    cancellation_policy: unknown;
  }>(
    db,
    sql`select timezone, booking_window_days, min_notice_min, slot_granularity_min,
               currency, cancellation_policy
          from clinic
         where id = ${clinicId} and deleted_at is null`,
  );
  const row = found[0];
  if (!row) throw new AppError("NOT_FOUND", "Clinic not found.");
  return {
    timezone: row.timezone,
    bookingWindowDays: num(row.booking_window_days, 30),
    minNoticeMin: num(row.min_notice_min, 60),
    slotGranularityMin: num(row.slot_granularity_min, 15),
    currency: row.currency,
    cancellationPolicy: row.cancellation_policy,
  };
}

export async function loadService(
  db: TenantDb,
  clinicId: string,
  serviceId: string,
): Promise<ServiceSchedulingSettings> {
  const found = await rows<{
    id: string;
    duration_min: number;
    buffer_min: number;
    deposit_minor: string | number;
    is_active: boolean;
    patient_bookable: boolean;
  }>(
    db,
    sql`select id, duration_min, buffer_min, deposit_minor, is_active, patient_bookable
          from service
         where clinic_id = ${clinicId} and id = ${serviceId}`,
  );
  const row = found[0];
  if (!row) throw new AppError("NOT_FOUND", "Service not found.");
  return {
    id: row.id,
    durationMin: num(row.duration_min),
    bufferMin: num(row.buffer_min),
    depositMinor: num(row.deposit_minor),
    isActive: row.is_active,
    patientBookable: row.patient_bookable,
  };
}

/** Active providers who actually offer this service (`provider_service`). */
export async function loadProviderIds(
  db: TenantDb,
  clinicId: string,
  serviceId: string,
  providerId?: string | null,
): Promise<ProviderId[]> {
  const only = providerId ? sql` and p.id = ${providerId}` : sql``;
  const found = await rows<{ id: string }>(
    db,
    sql`select p.id
          from provider p
          join provider_service ps
            on ps.provider_id = p.id and ps.service_id = ${serviceId}
         where p.clinic_id = ${clinicId} and p.is_active${only}
         order by p.sort, p.id`,
  );
  return found.map((r) => r.id);
}

export async function loadAvailabilityRules(
  db: TenantDb,
  clinicId: string,
  providerIds: readonly string[],
): Promise<AvailabilityRule[]> {
  if (providerIds.length === 0) return [];
  const found = await rows<{
    provider_id: string;
    location_id: string | null;
    weekday: number;
    start_local: string;
    end_local: string;
    valid_from: string | null;
    valid_to: string | null;
  }>(
    db,
    sql`select provider_id, location_id, weekday,
               start_local::text as start_local, end_local::text as end_local,
               to_char(valid_from, 'YYYY-MM-DD') as valid_from,
               to_char(valid_to, 'YYYY-MM-DD') as valid_to
          from availability_rule
         where clinic_id = ${clinicId} and provider_id in ${[...providerIds]}`,
  );
  return found.map((r) => ({
    providerId: r.provider_id,
    locationId: r.location_id,
    weekday: num(r.weekday),
    startLocal: r.start_local,
    endLocal: r.end_local,
    validFrom: r.valid_from,
    validTo: r.valid_to,
  }));
}

/**
 * Everything that occupies a provider's calendar in `[from, to)`: occupying
 * appointments, unexpired holds, and time off (a `null provider_id` closes the
 * whole clinic).
 *
 * Expired holds are filtered by `expires_at > now()` rather than deleted here,
 * so a read never takes a write lock — the hold-expiry job and `holdSlot` do
 * the deleting (see packages/db/README.md on why the constraint cannot carry
 * the predicate itself).
 */
export async function loadBusy(
  db: TenantDb,
  clinicId: string,
  providerIds: readonly string[],
  from: Date,
  to: Date,
): Promise<BusyInterval[]> {
  if (providerIds.length === 0) return [];
  const ids = [...providerIds];
  const found = await rows<{
    provider_id: string | null;
    starts_at_ms: number;
    ends_at_ms: number;
    kind: BusyInterval["kind"];
  }>(
    db,
    sql`
      select provider_id,
             ${epochMs("lower(slot)")} as starts_at_ms,
             ${epochMs("upper(slot)")} as ends_at_ms,
             'appointment' as kind
        from appointment
       where clinic_id = ${clinicId}
         and provider_id in ${ids}
         and status in ('booked', 'confirmed', 'arrived', 'pending_deposit')
         and slot && tstzrange(${from}, ${to}, '[)')
      union all
      select provider_id,
             ${epochMs("lower(slot)")} as starts_at_ms,
             ${epochMs("upper(slot)")} as ends_at_ms,
             'hold' as kind
        from slot_hold
       where clinic_id = ${clinicId}
         and provider_id in ${ids}
         and expires_at > now()
         and slot && tstzrange(${from}, ${to}, '[)')
      union all
      select provider_id,
             ${epochMs("starts_at")} as starts_at_ms,
             ${epochMs("ends_at")} as ends_at_ms,
             'time_off' as kind
        from time_off
       where clinic_id = ${clinicId}
         and (provider_id is null or provider_id in ${ids})
         and starts_at < ${to}
         and ends_at > ${from}
    `,
  );
  return found.map((r) => ({
    providerId: r.provider_id,
    start: instant(r.starts_at_ms),
    end: instant(r.ends_at_ms),
    kind: r.kind,
  }));
}

/** Occupied appointments per provider in the range — the load-balance input. */
export async function loadProviderLoad(
  db: TenantDb,
  clinicId: string,
  providerIds: readonly string[],
  from: Date,
  to: Date,
): Promise<Record<string, number>> {
  if (providerIds.length === 0) return {};
  const found = await rows<{ provider_id: string; total: string | number }>(
    db,
    sql`select provider_id, count(*) as total
          from appointment
         where clinic_id = ${clinicId}
           and provider_id in ${[...providerIds]}
           and status in ('booked', 'confirmed', 'arrived', 'pending_deposit')
           and slot && tstzrange(${from}, ${to}, '[)')
         group by provider_id`,
  );
  const load: Record<string, number> = {};
  for (const id of providerIds) load[id] = 0;
  for (const row of found) load[row.provider_id] = num(row.total);
  return load;
}

/**
 * Delete this provider's expired holds.
 *
 * Called inside the same transaction as the insert in `holdSlot`. The GiST
 * exclusion constraint on `slot_hold` is unconditional — Postgres will not
 * accept the `where (expires_at > now())` predicate the data model sketches,
 * because an index predicate must be IMMUTABLE — so an expired hold would
 * otherwise keep blocking its slot forever.
 */
export async function deleteExpiredHoldsForProvider(
  db: TenantDb,
  clinicId: string,
  providerId: string,
): Promise<number> {
  return affected(
    db,
    sql`delete from slot_hold
         where clinic_id = ${clinicId} and provider_id = ${providerId} and expires_at <= now()`,
  );
}

/** Housekeeping sweep for one clinic (the worker's hold-expiry job). */
export async function deleteExpiredHolds(db: TenantDb, clinicId: string): Promise<number> {
  return affected(
    db,
    sql`delete from slot_hold where clinic_id = ${clinicId} and expires_at <= now()`,
  );
}

export interface HoldRow {
  id: string;
  clinicId: string;
  providerId: string;
  serviceId: string;
  patientId: string | null;
  conversationId: string | null;
  start: Date;
  end: Date;
  expired: boolean;
}

/** Read a hold `for update` so two bookings cannot consume the same one. */
export async function lockHold(
  db: TenantDb,
  clinicId: string,
  holdId: string,
): Promise<HoldRow | undefined> {
  const found = await rows<{
    id: string;
    clinic_id: string;
    provider_id: string;
    service_id: string;
    patient_id: string | null;
    conversation_id: string | null;
    starts_at_ms: number;
    ends_at_ms: number;
    expired: boolean;
  }>(
    db,
    sql`select id, clinic_id, provider_id, service_id, patient_id, conversation_id,
               ${epochMs("lower(slot)")} as starts_at_ms,
               ${epochMs("upper(slot)")} as ends_at_ms,
               expires_at <= now() as expired
          from slot_hold
         where clinic_id = ${clinicId} and id = ${holdId}
           for update`,
  );
  const row = found[0];
  if (!row) return undefined;
  return {
    id: row.id,
    clinicId: row.clinic_id,
    providerId: row.provider_id,
    serviceId: row.service_id,
    patientId: row.patient_id,
    conversationId: row.conversation_id,
    start: instant(row.starts_at_ms),
    end: instant(row.ends_at_ms),
    expired: row.expired,
  };
}

export async function deleteHold(db: TenantDb, clinicId: string, holdId: string): Promise<number> {
  return affected(db, sql`delete from slot_hold where clinic_id = ${clinicId} and id = ${holdId}`);
}

export interface AppointmentRow {
  id: string;
  clinicId: string;
  patientId: string;
  providerId: string;
  serviceId: string;
  locationId: string | null;
  start: Date;
  end: Date;
  status: string;
  source: string;
  visitReason: string | null;
  depositRequiredMinor: number;
  depositPaidMinor: number;
  depositStatus: string | null;
  rescheduleOf: string | null;
  cancelledReason: string | null;
}

const APPOINTMENT_COLUMNS = sql`
  id, clinic_id, patient_id, provider_id, service_id, location_id,
  ${epochMs("lower(slot)")} as starts_at_ms, ${epochMs("upper(slot)")} as ends_at_ms,
  status, source, visit_reason,
  deposit_required_minor, deposit_paid_minor, deposit_status, reschedule_of, cancelled_reason
`;

interface RawAppointment {
  id: string;
  clinic_id: string;
  patient_id: string;
  provider_id: string;
  service_id: string;
  location_id: string | null;
  starts_at_ms: number;
  ends_at_ms: number;
  status: string;
  source: string;
  visit_reason: string | null;
  deposit_required_minor: string | number;
  deposit_paid_minor: string | number;
  deposit_status: string | null;
  reschedule_of: string | null;
  cancelled_reason: string | null;
}

function toAppointment(row: RawAppointment): AppointmentRow {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    patientId: row.patient_id,
    providerId: row.provider_id,
    serviceId: row.service_id,
    locationId: row.location_id,
    start: instant(row.starts_at_ms),
    end: instant(row.ends_at_ms),
    status: row.status,
    source: row.source,
    visitReason: row.visit_reason,
    depositRequiredMinor: num(row.deposit_required_minor),
    depositPaidMinor: num(row.deposit_paid_minor),
    depositStatus: row.deposit_status,
    rescheduleOf: row.reschedule_of,
    cancelledReason: row.cancelled_reason,
  };
}

export async function lockAppointment(
  db: TenantDb,
  clinicId: string,
  appointmentId: string,
): Promise<AppointmentRow | undefined> {
  const found = await rows<RawAppointment>(
    db,
    sql`select ${APPOINTMENT_COLUMNS} from appointment
         where clinic_id = ${clinicId} and id = ${appointmentId}
           for update`,
  );
  const row = found[0];
  return row ? toAppointment(row) : undefined;
}

export async function getAppointment(
  db: TenantDb,
  clinicId: string,
  appointmentId: string,
): Promise<AppointmentRow | undefined> {
  const found = await rows<RawAppointment>(
    db,
    sql`select ${APPOINTMENT_COLUMNS} from appointment
         where clinic_id = ${clinicId} and id = ${appointmentId}`,
  );
  const row = found[0];
  return row ? toAppointment(row) : undefined;
}

/** True when an occupying appointment already covers `[start, end)`. */
export async function hasConflictingAppointment(
  db: TenantDb,
  clinicId: string,
  providerId: string,
  start: Date,
  end: Date,
): Promise<boolean> {
  const found = await rows<{ one: number }>(
    db,
    sql`select 1 as one from appointment
         where clinic_id = ${clinicId}
           and provider_id = ${providerId}
           and status in ('booked', 'confirmed', 'arrived', 'pending_deposit')
           and slot && tstzrange(${start}, ${end}, '[)')
         limit 1`,
  );
  return found.length > 0;
}

export interface InsertHoldInput {
  id: string;
  clinicId: string;
  providerId: string;
  serviceId: string;
  patientId?: string | null;
  conversationId?: string | null;
  start: Date;
  end: Date;
  ttlMinutes: number;
}

/**
 * Insert the hold.
 *
 * `expires_at` is computed by Postgres, not by the application: every other
 * statement compares it against `now()`, and a clock skew between an app
 * container and the database must not be able to resurrect an expired hold.
 */
export async function insertHold(db: TenantDb, input: InsertHoldInput): Promise<Date> {
  const found = await rows<{ expires_at_ms: number }>(
    db,
    sql`insert into slot_hold
          (id, clinic_id, provider_id, service_id, patient_id, conversation_id, slot, expires_at)
        values (
          ${input.id}, ${input.clinicId}, ${input.providerId}, ${input.serviceId},
          ${input.patientId ?? null}, ${input.conversationId ?? null},
          ${rangeLiteral(input.start, input.end)}::tstzrange,
          now() + ${input.ttlMinutes}::int * interval '1 minute'
        )
        returning ${epochMs("expires_at")} as expires_at_ms`,
  );
  const row = found[0];
  if (!row) throw new AppError("INTERNAL", "Hold insert returned no row.", { expose: false });
  return instant(row.expires_at_ms);
}

export interface InsertAppointmentInput {
  id: string;
  clinicId: string;
  patientId: string;
  providerId: string;
  serviceId: string;
  locationId?: string | null;
  start: Date;
  end: Date;
  status: string;
  source: string;
  intakeAnswers: Record<string, unknown>;
  visitReason?: string | null;
  depositRequiredMinor: number;
  depositPaidMinor?: number;
  rescheduleOf?: string | null;
}

export async function insertAppointment(
  db: TenantDb,
  input: InsertAppointmentInput,
): Promise<AppointmentRow> {
  const found = await rows<RawAppointment>(
    db,
    sql`insert into appointment
          (id, clinic_id, patient_id, provider_id, service_id, location_id, slot, status, source,
           intake_answers, visit_reason, deposit_required_minor, deposit_paid_minor, reschedule_of)
        values (
          ${input.id}, ${input.clinicId}, ${input.patientId}, ${input.providerId},
          ${input.serviceId}, ${input.locationId ?? null},
          ${rangeLiteral(input.start, input.end)}::tstzrange,
          ${input.status}::appointment_status, ${input.source},
          ${JSON.stringify(input.intakeAnswers ?? {})}::jsonb, ${input.visitReason ?? null},
          ${input.depositRequiredMinor}, ${input.depositPaidMinor ?? 0}, ${input.rescheduleOf ?? null}
        )
        returning ${APPOINTMENT_COLUMNS}`,
  );
  const row = found[0];
  if (!row)
    throw new AppError("INTERNAL", "Appointment insert returned no row.", { expose: false });
  return toAppointment(row);
}

export async function updateAppointmentStatus(
  db: TenantDb,
  input: {
    clinicId: string;
    appointmentId: string;
    status: string;
    cancelledReason?: string | null;
    depositPaidMinor?: number;
    depositStatus?: string | null;
  },
): Promise<AppointmentRow> {
  const found = await rows<RawAppointment>(
    db,
    sql`update appointment
           set status = ${input.status}::appointment_status,
               cancelled_reason = coalesce(${input.cancelledReason ?? null}, cancelled_reason),
               deposit_paid_minor = coalesce(${input.depositPaidMinor ?? null}, deposit_paid_minor),
               deposit_status = coalesce(${input.depositStatus ?? null}, deposit_status),
               updated_at = now()
         where clinic_id = ${input.clinicId} and id = ${input.appointmentId}
        returning ${APPOINTMENT_COLUMNS}`,
  );
  const row = found[0];
  if (!row) throw new AppError("NOT_FOUND", "Appointment not found.");
  return toAppointment(row);
}

export interface AuditEntry {
  clinicId: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/**
 * Write the audit row (CLAUDE.md hard rule 7).
 *
 * `before`/`after` carry ids, statuses, amounts and instants only — never a
 * name, a phone number or a message body (hard rule 4).
 */
export async function insertAuditLog(db: TenantDb, id: string, entry: AuditEntry): Promise<void> {
  await db.execute(
    sql`insert into audit_log (id, clinic_id, actor, action, entity, entity_id, before, after, reason)
        values (${id}, ${entry.clinicId}, ${entry.actor}, ${entry.action}, ${entry.entity},
                ${entry.entityId},
                ${entry.before === undefined ? null : JSON.stringify(entry.before)}::jsonb,
                ${entry.after === undefined ? null : JSON.stringify(entry.after)}::jsonb,
                ${entry.reason ?? null})`,
  );
}
