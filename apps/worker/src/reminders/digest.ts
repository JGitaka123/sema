import type { TenantClient } from "@sema/db";
import { formatInTz, formatMoney, money, type CurrencyCode } from "@sema/shared";

import { row, rows } from "../jobs/sql.js";
import type { DigestWindow } from "./digest-period.js";

/**
 * The numbers behind the two digests (SPEC §4.8 "Reports", §11 "Success
 * metrics").
 *
 * The queries live here and the delivery lives in `digest-delivery.ts`, because
 * *what a clinic is told* and *how it reaches them* change for entirely
 * different reasons — and because the metrics are the part worth testing
 * against a real database.
 *
 * Nothing here reads a message body. The owner digest is counts and money; the
 * morning digest carries patient names, which the staff receiving it already
 * see in the inbox all day. Neither ever goes to a patient.
 */

const num = (value: unknown, fallback = 0): number => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
};

const KNOWN_CURRENCIES = ["KES", "USD", "EUR", "GBP", "UGX", "TZS", "RWF"] as const;

/**
 * `clinic.currency` is a `char(3)`, so it is a string as far as the database is
 * concerned. A digest must not fail to render because a tenant was seeded with
 * a code `@sema/shared` does not price yet.
 */
function renderAmount(amountMinor: number, currency: string): string {
  if ((KNOWN_CURRENCIES as readonly string[]).includes(currency)) {
    return formatMoney(money(amountMinor, currency as CurrencyCode));
  }
  return `${currency} ${amountMinor}`;
}

// ── Owner weekly ─────────────────────────────────────────────────────────────

export interface OwnerWeeklyMetrics {
  readonly window: DigestWindow;
  readonly currency: string;
  /** Appointments created during the week, whatever they became afterwards. */
  readonly bookings: number;
  /** Appointments whose slot fell in the week and reached a final outcome. */
  readonly outcomes: number;
  readonly noShows: number;
  /** `null` when nothing concluded — a rate over zero is noise, not zero. */
  readonly noShowRatePct: number | null;
  readonly depositsCollectedMinor: number;
  readonly agentMessages: number;
  readonly staffMessages: number;
  readonly afterHoursInbound: number;
}

export async function loadOwnerWeeklyMetrics(
  client: TenantClient,
  clinicId: string,
  window: DigestWindow,
  currency: string,
): Promise<OwnerWeeklyMetrics> {
  const params = [clinicId, window.from.toISOString(), window.to.toISOString()];

  const booked = await row<{ total: string }>(
    client,
    `select count(*)::text as total from appointment
      where clinic_id = $1
        and created_at >= $2::timestamptz and created_at < $3::timestamptz`,
    params,
  );

  /**
   * Outcomes are keyed on when the *appointment* was, not when it was booked:
   * "what proportion of last week's clinic list turned up" is the question an
   * owner is actually asking. `arrived` counts as attended even if nobody ever
   * marked it complete.
   */
  const outcome = await row<{ concluded: string; no_shows: string }>(
    client,
    `select count(*) filter (
              where status in ('no_show', 'arrived', 'completed')
            )::text as concluded,
            count(*) filter (where status = 'no_show')::text as no_shows
       from appointment
      where clinic_id = $1
        and lower(slot) >= $2::timestamptz and lower(slot) < $3::timestamptz`,
    params,
  );

  /**
   * Deposits are read off the appointment, not off `payment`: Phase 6 owns that
   * table and it does not exist in the data yet. `deposit_paid_minor` is
   * written by the payment callback, so this keeps working when it does.
   */
  const deposits = await row<{ total: string }>(
    client,
    `select coalesce(sum(deposit_paid_minor), 0)::text as total from appointment
      where clinic_id = $1
        and created_at >= $2::timestamptz and created_at < $3::timestamptz`,
    params,
  );

  const handled = await row<{ agent: string; staff: string }>(
    client,
    `select count(*) filter (where sent_by = 'agent')::text     as agent,
            count(*) filter (where sent_by like 'staff:%')::text as staff
       from message
      where clinic_id = $1 and direction = 'out'
        and at >= $2::timestamptz and at < $3::timestamptz`,
    params,
  );

  /**
   * After-hours volume, derived from the clinic's own `availability_rule` rows
   * rather than a hard-coded 9-to-5. A clinic with no rules configured has no
   * open hours, so every message counts as after-hours — which is the honest
   * answer for a tenant that has not finished onboarding.
   */
  const afterHours = await row<{ total: string }>(
    client,
    `select count(*)::text as total
       from message m
      where m.clinic_id = $1 and m.direction = 'in'
        and m.at >= $2::timestamptz and m.at < $3::timestamptz
        and not exists (
          select 1 from availability_rule ar
           where ar.clinic_id = m.clinic_id
             and ar.weekday = extract(dow from (m.at at time zone $4::text))::int
             and (m.at at time zone $4::text)::time >= ar.start_local
             and (m.at at time zone $4::text)::time <  ar.end_local
        )`,
    [...params, window.timezone],
  );

  const outcomes = num(outcome?.concluded);
  const noShows = num(outcome?.no_shows);

  return {
    window,
    currency,
    bookings: num(booked?.total),
    outcomes,
    noShows,
    noShowRatePct: outcomes === 0 ? null : Math.round((noShows / outcomes) * 1000) / 10,
    depositsCollectedMinor: num(deposits?.total),
    agentMessages: num(handled?.agent),
    staffMessages: num(handled?.staff),
    afterHoursInbound: num(afterHours?.total),
  };
}

/** Plain text, because it has to read well in WhatsApp and in an email body. */
export function renderOwnerWeeklyDigest(clinicName: string, m: OwnerWeeklyMetrics): string {
  const to = new Date(m.window.to.getTime() - 1);
  const period = `${formatInTz(m.window.from, m.window.timezone, "d MMM")} – ${formatInTz(
    to,
    m.window.timezone,
    "d MMM yyyy",
  )}`;
  const handled = m.agentMessages + m.staffMessages;
  const agentShare = handled === 0 ? null : Math.round((m.agentMessages / handled) * 100);

  return [
    `${clinicName} — weekly summary (${period})`,
    ``,
    `Appointments booked: ${m.bookings}`,
    `No-shows: ${m.noShows} of ${m.outcomes}` +
      (m.noShowRatePct === null ? "" : ` (${m.noShowRatePct}%)`),
    `Deposits collected: ${renderAmount(m.depositsCollectedMinor, m.currency)}`,
    `Replies sent: ${m.agentMessages} by the assistant, ${m.staffMessages} by the team` +
      (agentShare === null ? "" : ` (${agentShare}% automated)`),
    `Messages received outside opening hours: ${m.afterHoursInbound}`,
  ].join("\n");
}

/**
 * The same week in one line.
 *
 * WhatsApp rejects a template parameter containing a newline or a tab, so the
 * message that goes to a staff number cannot be the block above. The full text
 * goes out by email; this is what fits in `{{3}}` of `staff_digest`.
 */
export function renderOwnerWeeklyHeadline(m: OwnerWeeklyMetrics): string {
  const parts = [
    `${m.bookings} booked`,
    m.noShowRatePct === null ? `${m.noShows} no-shows` : `${m.noShowRatePct}% no-show`,
    `${renderAmount(m.depositsCollectedMinor, m.currency)} deposits`,
    `${m.afterHoursInbound} after-hours messages`,
  ];
  return oneLine(parts.join(" · "));
}

/** Template parameters may not contain newlines or tabs. Meta rejects them. */
function oneLine(value: string): string {
  return value.replace(/\s*[\r\n\t]+\s*/g, " ").trim();
}

// ── Staff morning ────────────────────────────────────────────────────────────

export interface MorningAppointment {
  readonly appointmentId: string;
  readonly start: Date;
  readonly providerId: string;
  readonly providerName: string;
  readonly serviceName: string;
  readonly patientName: string | null;
  readonly status: string;
}

export interface StaffMorningDigest {
  readonly window: DigestWindow;
  readonly appointments: readonly MorningAppointment[];
}

export async function loadStaffMorningDigest(
  client: TenantClient,
  clinicId: string,
  window: DigestWindow,
): Promise<StaffMorningDigest> {
  const found = await rows<{
    id: string;
    start_ms: number;
    provider_id: string;
    provider_name: string;
    service_name: string;
    preferred_name: string | null;
    full_name: string | null;
    status: string;
  }>(
    client,
    `select a.id,
            (extract(epoch from lower(a.slot)) * 1000)::float8 as start_ms,
            a.provider_id, pr.display_name as provider_name,
            s.name as service_name,
            p.preferred_name, p.full_name,
            a.status::text as status
       from appointment a
       join provider pr on pr.id = a.provider_id and pr.clinic_id = a.clinic_id
       join service  s  on s.id  = a.service_id  and s.clinic_id = a.clinic_id
       join patient  p  on p.id  = a.patient_id  and p.clinic_id = a.clinic_id
      where a.clinic_id = $1
        and lower(a.slot) >= $2::timestamptz and lower(a.slot) < $3::timestamptz
        and a.status in ('booked', 'confirmed', 'pending_deposit', 'arrived')
      order by lower(a.slot), pr.sort, pr.id`,
    [clinicId, window.from.toISOString(), window.to.toISOString()],
  );

  return {
    window,
    appointments: found.map((r) => ({
      appointmentId: r.id,
      start: new Date(Math.round(num(r.start_ms))),
      providerId: r.provider_id,
      providerName: r.provider_name,
      serviceName: r.service_name,
      patientName: r.preferred_name ?? r.full_name,
      status: r.status,
    })),
  };
}

/**
 * Render the day, grouped by provider.
 *
 * SPEC §2.2: "Dr. Otieno … may not log in at all; gets a morning WhatsApp
 * digest." So this has to be readable on a phone in one glance: a line per
 * appointment, times first.
 */
export function renderStaffMorningDigest(clinicName: string, digest: StaffMorningDigest): string {
  const date = formatInTz(digest.window.from, digest.window.timezone, "EEEE d MMMM");
  const header = `${clinicName} — ${date}`;

  if (digest.appointments.length === 0) {
    return `${header}\n\nNo appointments booked today.`;
  }

  const byProvider = new Map<string, MorningAppointment[]>();
  for (const appointment of digest.appointments) {
    const list = byProvider.get(appointment.providerName) ?? [];
    list.push(appointment);
    byProvider.set(appointment.providerName, list);
  }

  const sections = [...byProvider.entries()].map(([provider, list]) => {
    const lines = list.map((a) => {
      const time = formatInTz(a.start, digest.window.timezone, "HH:mm");
      const who = a.patientName ?? "Patient";
      const flag = a.status === "pending_deposit" ? " (deposit pending)" : "";
      return `  ${time}  ${who} — ${a.serviceName}${flag}`;
    });
    return [`${provider} (${list.length})`, ...lines].join("\n");
  });

  return [header, `${digest.appointments.length} appointment(s) today`, "", ...sections].join("\n");
}

/** The day in one line, for the `staff_digest` template parameter. */
export function renderStaffMorningHeadline(digest: StaffMorningDigest): string {
  const first = digest.appointments[0];
  if (!first) return "No appointments booked today.";
  const time = formatInTz(first.start, digest.window.timezone, "HH:mm");
  return oneLine(`${digest.appointments.length} appointment(s) today, first at ${time}.`);
}
