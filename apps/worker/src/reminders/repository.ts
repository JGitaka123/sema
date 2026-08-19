import type { TenantClient } from "@sema/db";
import type { TimeZone } from "@sema/shared";

import { row, rows } from "../jobs/sql.js";
import type { ReminderKind } from "./config.js";

/**
 * Every statement the reminder, no-show and digest jobs run.
 *
 * Two conventions, both inherited from `packages/scheduling/src/repository.ts`:
 *
 *  - **`clinic_id = $1` on every statement**, even though each one already runs
 *    inside `withTenant` and is therefore covered by the `tenant_isolation`
 *    policy. Belt as well as braces, and it keeps the composite indexes usable.
 *  - **Instants come back as epoch milliseconds.** Drizzle's node-postgres type
 *    parser hands `timestamptz` back as `2030-01-07 06:00:00+00`, which is not
 *    ISO-8601, and `new Date()` parses it by engine-specific fallback rules.
 *    Asking Postgres for a number removes the ambiguity.
 */

const num = (value: unknown, fallback = 0): number => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
};

function instant(value: unknown): Date {
  return new Date(Math.round(num(value)));
}

// ── Clinic ───────────────────────────────────────────────────────────────────

export interface ClinicReminderSettings {
  readonly clinicId: string;
  readonly timezone: TimeZone;
  readonly currency: string;
  readonly defaultLanguage: string;
  readonly flags: unknown;
}

export async function loadClinic(
  client: TenantClient,
  clinicId: string,
): Promise<ClinicReminderSettings | undefined> {
  const found = await row<{
    id: string;
    timezone: string;
    currency: string;
    default_language: string;
    flags: unknown;
  }>(
    client,
    `select id, timezone, currency, default_language, flags
       from clinic where id = $1 and deleted_at is null`,
    [clinicId],
  );
  if (!found) return undefined;
  return {
    clinicId: found.id,
    timezone: found.timezone,
    currency: found.currency,
    defaultLanguage: found.default_language,
    flags: found.flags,
  };
}

// ── Reminder rows ────────────────────────────────────────────────────────────

export interface ExistingReminder {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly dueAt: Date;
}

export async function loadRemindersFor(
  client: TenantClient,
  clinicId: string,
  appointmentId: string,
): Promise<ExistingReminder[]> {
  const found = await rows<{
    id: string;
    kind: string;
    status: string;
    due_ms: number;
  }>(
    client,
    `select id, kind, status, (extract(epoch from due_at) * 1000)::float8 as due_ms
       from reminder where clinic_id = $1 and appointment_id = $2`,
    [clinicId, appointmentId],
  );
  return found.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    dueAt: instant(r.due_ms),
  }));
}

export async function insertReminder(
  client: TenantClient,
  input: {
    id: string;
    clinicId: string;
    appointmentId: string;
    kind: ReminderKind;
    dueAt: Date;
    jobId?: string | null;
  },
): Promise<void> {
  await client.query(
    `insert into reminder (id, clinic_id, appointment_id, kind, due_at, status, job_id)
     values ($1, $2, $3, $4::reminder_kind, $5::timestamptz, 'scheduled', $6)`,
    [
      input.id,
      input.clinicId,
      input.appointmentId,
      input.kind,
      input.dueAt.toISOString(),
      input.jobId ?? null,
    ],
  );
}

/**
 * Queue the rebook nudge, unless one already exists for this appointment.
 *
 * `where not exists` rather than a unique index because `reminder` has none and
 * adding one is a migration. The no-show marking that calls this is itself
 * guarded by the `booked → no_show` status transition, so this is the second
 * lock on a door that is already shut.
 */
export async function insertRebookNudgeIfAbsent(
  client: TenantClient,
  input: { id: string; clinicId: string; appointmentId: string; dueAt: Date },
): Promise<boolean> {
  const inserted = await rows<{ id: string }>(
    client,
    // Every parameter is cast: in `insert … select` Postgres does not infer a
    // select-list parameter's type from the target column, and an uncast $4
    // fails with "could not determine data type of parameter".
    `insert into reminder (id, clinic_id, appointment_id, kind, due_at, status)
     select $1::text, $2::text, $3::text, 'no_show_rebook'::reminder_kind,
            $4::timestamptz, 'scheduled'::text
      where not exists (
        select 1 from reminder
         where clinic_id = $2::text and appointment_id = $3::text
           and kind = 'no_show_rebook'
      )
     returning id`,
    [input.id, input.clinicId, input.appointmentId, input.dueAt.toISOString()],
  );
  return inserted.length > 0;
}

export async function updateReminderDueAt(
  client: TenantClient,
  clinicId: string,
  reminderId: string,
  dueAt: Date,
): Promise<void> {
  await client.query(
    `update reminder set due_at = $3::timestamptz, updated_at = now()
      where clinic_id = $1 and id = $2 and status = 'scheduled'`,
    [clinicId, reminderId, dueAt.toISOString()],
  );
}

/**
 * Retire scheduled reminders.
 *
 * `skipped`, not deleted: DATA_MODEL.md gives `reminder.status` the value, and
 * "we decided not to send this, and why" is exactly the sort of thing a clinic
 * asks about three weeks later.
 */
export async function skipScheduledReminders(
  client: TenantClient,
  clinicId: string,
  appointmentId: string,
  kinds?: readonly string[],
): Promise<number> {
  const filter = kinds ? ` and kind = any($3::reminder_kind[])` : "";
  const params: unknown[] = kinds
    ? [clinicId, appointmentId, [...kinds]]
    : [clinicId, appointmentId];
  const updated = await rows<{ id: string }>(
    client,
    `update reminder set status = 'skipped', updated_at = now()
      where clinic_id = $1 and appointment_id = $2 and status = 'scheduled'${filter}
      returning id`,
    params,
  );
  return updated.length;
}

// ── Appointments ─────────────────────────────────────────────────────────────

export interface AppointmentForReminders {
  readonly id: string;
  readonly serviceId: string;
  readonly status: string;
  readonly start: Date;
}

export async function loadAppointment(
  client: TenantClient,
  clinicId: string,
  appointmentId: string,
): Promise<AppointmentForReminders | undefined> {
  const found = await row<{
    id: string;
    service_id: string;
    status: string;
    start_ms: number;
  }>(
    client,
    `select id, service_id, status,
            (extract(epoch from lower(slot)) * 1000)::float8 as start_ms
       from appointment where clinic_id = $1 and id = $2`,
    [clinicId, appointmentId],
  );
  if (!found) return undefined;
  return {
    id: found.id,
    serviceId: found.service_id,
    status: found.status,
    start: instant(found.start_ms),
  };
}

/** Appointments whose reminders the reconciler should re-derive. */
export async function listAppointmentsToSync(
  client: TenantClient,
  clinicId: string,
  from: Date,
  to: Date,
  limit: number,
): Promise<string[]> {
  const found = await rows<{ id: string }>(
    client,
    `select id from appointment
      where clinic_id = $1
        and lower(slot) >= $2::timestamptz and lower(slot) < $3::timestamptz
      order by lower(slot)
      limit $4::int`,
    [clinicId, from.toISOString(), to.toISOString(), limit],
  );
  return found.map((r) => r.id);
}

// ── The due-reminder claim ───────────────────────────────────────────────────

/**
 * Claim due reminders for this transaction.
 *
 * `for update … skip locked` is the whole idempotency story for the sweep: two
 * workers running the same minute cannot both take the same row, and once the
 * transaction commits the row is no longer `scheduled`, so a third run finds
 * nothing. No `sending` state is needed, because deciding and enqueuing are
 * both database writes inside this one transaction — a crash mid-way rolls back
 * the outbox row as well as the status, and the reminder is retried intact.
 */
export async function claimDueReminderIds(
  client: TenantClient,
  clinicId: string,
  now: Date,
  limit: number,
): Promise<string[]> {
  const found = await rows<{ id: string }>(
    client,
    `select id from reminder
      where clinic_id = $1 and status = 'scheduled' and due_at <= $2::timestamptz
      order by due_at
      limit $3::int
      for update skip locked`,
    [clinicId, now.toISOString(), limit],
  );
  return found.map((r) => r.id);
}

export interface DueReminderRow {
  readonly reminderId: string;
  readonly kind: string;
  readonly dueAt: Date;
  readonly appointmentId: string;
  readonly appointmentStatus: string;
  readonly start: Date;
  readonly patientId: string;
  readonly phoneE164: string;
  readonly patientName: string | null;
  readonly language: string | null;
  readonly patientBlocked: boolean;
  readonly serviceName: string;
  readonly providerName: string;
  readonly locationName: string | null;
  readonly conversationId: string | null;
  readonly conversationMode: string | null;
  readonly serviceMessagesGranted: boolean | null;
}

/** Everything a claimed reminder needs, in one round trip. */
export async function loadDueReminders(
  client: TenantClient,
  clinicId: string,
  reminderIds: readonly string[],
): Promise<DueReminderRow[]> {
  if (reminderIds.length === 0) return [];
  const found = await rows<{
    reminder_id: string;
    kind: string;
    due_ms: number;
    appointment_id: string;
    appointment_status: string;
    start_ms: number;
    patient_id: string;
    phone_e164: string;
    preferred_name: string | null;
    full_name: string | null;
    language: string | null;
    blocked: boolean | null;
    service_name: string;
    provider_name: string;
    location_name: string | null;
    conversation_id: string | null;
    conversation_mode: string | null;
    service_messages_granted: boolean | null;
  }>(
    client,
    `select r.id                                                    as reminder_id,
            r.kind::text                                            as kind,
            (extract(epoch from r.due_at) * 1000)::float8           as due_ms,
            a.id                                                    as appointment_id,
            a.status::text                                          as appointment_status,
            (extract(epoch from lower(a.slot)) * 1000)::float8      as start_ms,
            p.id                                                    as patient_id,
            p.phone_e164, p.preferred_name, p.full_name, p.language,
            (p.flags ->> 'blocked')::bool                           as blocked,
            s.name                                                  as service_name,
            pr.display_name                                         as provider_name,
            l.name                                                  as location_name,
            conv.id                                                 as conversation_id,
            conv.mode::text                                         as conversation_mode,
            (select pc.granted from patient_consent pc
              where pc.clinic_id = r.clinic_id and pc.patient_id = p.id
                and pc.kind = 'service_messages'
              order by pc.at desc limit 1)                          as service_messages_granted
       from reminder r
       join appointment a on a.id = r.appointment_id and a.clinic_id = r.clinic_id
       join patient p     on p.id = a.patient_id     and p.clinic_id = r.clinic_id
       join service s     on s.id = a.service_id     and s.clinic_id = r.clinic_id
       join provider pr   on pr.id = a.provider_id   and pr.clinic_id = r.clinic_id
       left join location l on l.id = a.location_id  and l.clinic_id = r.clinic_id
       left join lateral (
         select cv.id, cv.mode from conversation cv
          where cv.clinic_id = r.clinic_id and cv.patient_id = p.id
          order by cv.last_message_at desc nulls last, cv.created_at desc
          limit 1
       ) conv on true
      where r.clinic_id = $1 and r.id = any($2::text[])`,
    [clinicId, [...reminderIds]],
  );

  return found.map((r) => ({
    reminderId: r.reminder_id,
    kind: r.kind,
    dueAt: instant(r.due_ms),
    appointmentId: r.appointment_id,
    appointmentStatus: r.appointment_status,
    start: instant(r.start_ms),
    patientId: r.patient_id,
    phoneE164: r.phone_e164,
    patientName: r.preferred_name ?? r.full_name,
    language: r.language,
    patientBlocked: r.blocked === true,
    serviceName: r.service_name,
    providerName: r.provider_name,
    locationName: r.location_name,
    conversationId: r.conversation_id,
    conversationMode: r.conversation_mode,
    serviceMessagesGranted: r.service_messages_granted,
  }));
}

export async function markReminderSent(
  client: TenantClient,
  clinicId: string,
  reminderId: string,
  sentMessageId: string,
): Promise<void> {
  await client.query(
    `update reminder set status = 'sent', sent_message_id = $3, updated_at = now()
      where clinic_id = $1 and id = $2`,
    [clinicId, reminderId, sentMessageId],
  );
}

export async function markReminderStatus(
  client: TenantClient,
  clinicId: string,
  reminderId: string,
  status: "skipped" | "failed",
): Promise<void> {
  await client.query(
    `update reminder set status = $3, updated_at = now() where clinic_id = $1 and id = $2`,
    [clinicId, reminderId, status],
  );
}

// ── No-show ──────────────────────────────────────────────────────────────────

export interface NoShowCandidate {
  readonly appointmentId: string;
  readonly patientId: string;
  readonly providerId: string;
  readonly serviceId: string;
  readonly start: Date;
  readonly status: string;
}

/**
 * Appointments that have passed their grace period without an arrival.
 *
 * `for update skip locked` again, so two sweeps cannot both mark the same row —
 * and `status in (…)` means a second pass after the first commits sees nothing,
 * because the row is now `no_show`.
 */
export async function claimNoShowCandidates(
  client: TenantClient,
  clinicId: string,
  input: { now: Date; afterMin: number; lookbackHours: number; limit: number },
): Promise<NoShowCandidate[]> {
  const found = await rows<{
    id: string;
    patient_id: string;
    provider_id: string;
    service_id: string;
    status: string;
    start_ms: number;
  }>(
    client,
    `select id, patient_id, provider_id, service_id, status::text as status,
            (extract(epoch from lower(slot)) * 1000)::float8 as start_ms
       from appointment
      where clinic_id = $1
        and status in ('booked', 'confirmed', 'pending_deposit')
        and arrived_at is null
        and lower(slot) <= $2::timestamptz - make_interval(mins => $3::int)
        and lower(slot) >  $2::timestamptz - make_interval(hours => $4::int)
      order by lower(slot)
      limit $5::int
      for update skip locked`,
    [clinicId, input.now.toISOString(), input.afterMin, input.lookbackHours, input.limit],
  );
  return found.map((r) => ({
    appointmentId: r.id,
    patientId: r.patient_id,
    providerId: r.provider_id,
    serviceId: r.service_id,
    status: r.status,
    start: instant(r.start_ms),
  }));
}

export async function markAppointmentNoShow(
  client: TenantClient,
  clinicId: string,
  appointmentId: string,
): Promise<void> {
  await client.query(
    `update appointment set status = 'no_show', updated_at = now()
      where clinic_id = $1 and id = $2`,
    [clinicId, appointmentId],
  );
}

/**
 * `patient.flags.no_show_count += 1`, computed by Postgres.
 *
 * Read-modify-write in JavaScript would lose an increment whenever two
 * appointments for the same patient are marked in the same sweep.
 */
export async function incrementNoShowCount(
  client: TenantClient,
  clinicId: string,
  patientId: string,
): Promise<number> {
  const updated = await row<{ count: number }>(
    client,
    `update patient
        set flags = jsonb_set(
              coalesce(flags, '{}'::jsonb),
              '{no_show_count}',
              to_jsonb(coalesce((flags ->> 'no_show_count')::int, 0) + 1),
              true
            ),
            updated_at = now()
      where clinic_id = $1 and id = $2
      returning (flags ->> 'no_show_count')::int as count`,
    [clinicId, patientId],
  );
  return updated?.count ?? 0;
}
