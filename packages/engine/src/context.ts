import { type TenantDb, type WithTenantDb } from "@sema/db";
import { formatInTz, formatMoney, money, type CurrencyCode } from "@sema/shared";
import { sql, type SQL } from "drizzle-orm";

import { agentPromptTemplate, fillPrompt } from "./prompts/index.js";

/**
 * The agent's context (CONVERSATION_ENGINE.md §1, §3.1, §8).
 *
 * "clinic profile, policies, knowledge, patient card, last 20 msgs, open
 * appointments, holds, now in clinic tz."
 *
 * Two rules shape every field on here.
 *
 *  1. **This is the agent's entire world.** The system prompt tells the model
 *     that anything outside the clinic facts block does not exist, so what this
 *     builder omits, the agent cannot say. Adding a field is therefore a
 *     decision about what the agent is allowed to assert.
 *  2. **Minimum PHI leaves the boundary** (COMPLIANCE.md §2, hard rule 4). The
 *     patient card carries a first name and counters — never a surname, phone
 *     number, date of birth or clinical note. `patientCardText` is the only
 *     rendering of it and `context.test.ts` asserts what it cannot contain.
 */

// ── The shape ────────────────────────────────────────────────────────────────

export interface ClinicProfile {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly currency: string;
  readonly defaultLanguage: string;
  readonly specialty: string | null;
}

export interface ClinicPolicies {
  readonly freeRescheduleHours: number;
  readonly forfeitHours: number;
  readonly bookingWindowDays: number;
  readonly minNoticeMin: number;
}

export interface KnowledgeFact {
  readonly category: string;
  readonly title: string | null;
  readonly body: string;
}

export interface ServiceFact {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly durationMin: number;
  readonly priceMinor: number | null;
  readonly priceNote: string | null;
  readonly depositMinor: number;
  readonly description: string | null;
  readonly prepInstructions: string | null;
  readonly intakeQuestions: readonly string[];
}

export interface ProviderFact {
  readonly id: string;
  readonly displayName: string;
  readonly title: string | null;
  readonly specialty: string | null;
  readonly bio: string | null;
  /** Service ids this provider offers — the agent must not guess. */
  readonly serviceIds: readonly string[];
}

export interface LocationFact {
  readonly id: string;
  readonly name: string;
  readonly address: string | null;
  readonly mapsUrl: string | null;
  readonly phone: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly isPrimary: boolean;
}

/** One provider's weekly hours, already rendered in clinic wall-clock time. */
export interface HoursFact {
  readonly providerId: string;
  readonly providerName: string;
  /** e.g. "Mon–Fri 8:00am–5:00pm; Sat 9:00am–1:00pm". */
  readonly summary: string;
}

export interface AppointmentFact {
  readonly id: string;
  readonly serviceId: string;
  readonly serviceName: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly start: Date;
  readonly end: Date;
  readonly status: string;
  readonly depositRequiredMinor: number;
  readonly depositPaidMinor: number;
}

export interface HoldFact {
  readonly id: string;
  readonly providerId: string;
  readonly serviceId: string;
  readonly start: Date;
  readonly end: Date;
  readonly expiresAt: Date;
}

/**
 * What the agent is told about the person it is talking to.
 *
 * `firstName` only, deliberately (COMPLIANCE.md §2: "Never send patient full
 * name when a first name or 'the patient' suffices").
 */
export interface PatientCard {
  readonly id: string;
  readonly firstName: string | null;
  readonly language: string | null;
  readonly noShowCount: number;
  readonly isVip: boolean;
  readonly isBlocked: boolean;
  readonly upcoming: readonly AppointmentFact[];
}

export interface HistoryMessage {
  readonly role: "patient" | "clinic";
  /** `agent` | `system` | `staff:<id>` for outbound; null inbound. */
  readonly sentBy: string | null;
  readonly text: string;
  readonly at: Date;
}

export interface AgentContext {
  readonly clinic: ClinicProfile;
  readonly policies: ClinicPolicies;
  readonly knowledge: readonly KnowledgeFact[];
  readonly services: readonly ServiceFact[];
  readonly providers: readonly ProviderFact[];
  readonly locations: readonly LocationFact[];
  readonly hours: readonly HoursFact[];
  readonly patient: PatientCard;
  readonly conversationId: string;
  /** Newest last. At most `HISTORY_LIMIT`. */
  readonly history: readonly HistoryMessage[];
  /** `conversation.agent_summary`, used when history was truncated (§8). */
  readonly summary: string | null;
  /** True when older messages exist than the ones in `history`. */
  readonly historyTruncated: boolean;
  readonly openHolds: readonly HoldFact[];
  /** Agent-authored replies already sent in the clinic-local day (§3.3). */
  readonly agentTurnsToday: number;
  readonly now: Date;
}

/** CONVERSATION_ENGINE.md §1: "last 20 msgs". */
export const HISTORY_LIMIT = 20;

/** How much of one historical message is worth sending. */
export const MAX_HISTORY_CHARS = 600;

// ── Loading ──────────────────────────────────────────────────────────────────

export interface ContextDeps {
  readonly withTenantDb: WithTenantDb;
  readonly now?: () => Date;
}

export interface LoadContextInput {
  readonly clinicId: string;
  readonly conversationId: string;
  readonly patientId: string;
}

async function rows<T>(db: TenantDb, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows: T[] };
  return result.rows ?? [];
}

const num = (value: unknown, fallback = 0): number => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
};

/**
 * Epoch milliseconds for a `timestamptz`, for the same reason
 * `packages/scheduling/src/repository.ts` does it: the node-postgres type
 * parser hands `timestamptz` back as a non-ISO string that `new Date()` parses
 * by engine-specific fallback rules.
 */
function epochMs(expression: string): SQL {
  return sql.raw(`(extract(epoch from ${expression}) * 1000)::float8`);
}

function instant(value: unknown): Date {
  return new Date(Math.round(num(value)));
}

/** `flags` is operator-editable jsonb; read it defensively. */
function flag(flags: unknown, key: string): unknown {
  if (typeof flags !== "object" || flags === null) return undefined;
  return (flags as Record<string, unknown>)[key];
}

/**
 * The first name, and only the first name.
 *
 * `preferred_name` is what front-desk staff typed as "what they like to be
 * called"; otherwise the first token of the full name. A surname never reaches
 * the model (COMPLIANCE.md §2).
 */
export function firstNameOf(preferred: string | null, full: string | null): string | null {
  const source = (preferred ?? "").trim() !== "" ? preferred : full;
  if (source === null) return null;
  const first = source.trim().split(/\s+/)[0];
  return first === undefined || first === "" ? null : first;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "09:00:00" → "9:00am". Postgres `time` has no timezone; it is wall clock. */
function formatLocalTime(value: string): string {
  const [hourText, minuteText] = value.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return value;
  const suffix = hour < 12 ? "am" : "pm";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${String(minute).padStart(2, "0")}${suffix}`;
}

/**
 * Collapse a provider's weekly rules into one line, merging runs of adjacent
 * weekdays that share the same window ("Mon–Fri 8:00am–5:00pm").
 */
export function summariseHours(
  rules: readonly { weekday: number; startLocal: string; endLocal: string }[],
): string {
  if (rules.length === 0) return "no hours set";
  const sorted = [...rules].sort((a, b) => a.weekday - b.weekday || a.startLocal.localeCompare(b.startLocal));

  const groups: { from: number; to: number; window: string }[] = [];
  for (const rule of sorted) {
    const window = `${formatLocalTime(rule.startLocal)}–${formatLocalTime(rule.endLocal)}`;
    const last = groups[groups.length - 1];
    if (last && last.window === window && last.to === rule.weekday - 1) {
      last.to = rule.weekday;
    } else {
      groups.push({ from: rule.weekday, to: rule.weekday, window });
    }
  }

  return groups
    .map((group) => {
      const from = WEEKDAY_NAMES[group.from] ?? String(group.from);
      const to = WEEKDAY_NAMES[group.to] ?? String(group.to);
      return group.from === group.to ? `${from} ${group.window}` : `${from}–${to} ${group.window}`;
    })
    .join("; ");
}

/**
 * Load everything the agent gets to know, in one tenant transaction.
 *
 * One transaction rather than several so the facts are consistent with each
 * other: an agent that read the service catalogue before a staff edit and the
 * availability after it would offer a slot for a service that no longer exists.
 */
export async function loadAgentContext(
  deps: ContextDeps,
  input: LoadContextInput,
): Promise<AgentContext> {
  const now = (deps.now ?? ((): Date => new Date()))();
  const { clinicId, conversationId, patientId } = input;

  return deps.withTenantDb(clinicId, async (db) => {
    const clinicRows = await rows<{
      id: string;
      name: string;
      timezone: string;
      currency: string;
      default_language: string;
      booking_window_days: number;
      min_notice_min: number;
      cancellation_policy: unknown;
    }>(
      db,
      sql`select id, name, timezone, currency, default_language,
                 booking_window_days, min_notice_min, cancellation_policy
            from clinic where id = ${clinicId} and deleted_at is null`,
    );
    const clinicRow = clinicRows[0];
    if (!clinicRow) throw new Error("clinic not found");

    const policyRaw = (clinicRow.cancellation_policy ?? {}) as Record<string, unknown>;

    const knowledgeRows = await rows<{ category: string; title: string | null; body: string }>(
      db,
      sql`select category, title, body from knowledge_item
           where clinic_id = ${clinicId} and is_public
           order by category, sort, id`,
    );

    const serviceRows = await rows<{
      id: string;
      name: string;
      category: string | null;
      duration_min: number;
      price_minor: string | number | null;
      price_note: string | null;
      deposit_minor: string | number;
      description_public: string | null;
      prep_instructions: string | null;
    }>(
      db,
      sql`select id, name, category, duration_min, price_minor, price_note,
                 deposit_minor, description_public, prep_instructions
            from service
           where clinic_id = ${clinicId} and is_active and patient_bookable
           order by category nulls last, name`,
    );

    const intakeRows = await rows<{ service_id: string; question: string }>(
      db,
      sql`select service_id, question from service_intake_question
           where clinic_id = ${clinicId} order by service_id, sort, id`,
    );

    const providerRows = await rows<{
      id: string;
      display_name: string;
      title: string | null;
      specialty: string | null;
      bio_public: string | null;
    }>(
      db,
      sql`select id, display_name, title, specialty, bio_public
            from provider where clinic_id = ${clinicId} and is_active
           order by sort, id`,
    );

    const providerServiceRows = await rows<{ provider_id: string; service_id: string }>(
      db,
      sql`select provider_id, service_id from provider_service where clinic_id = ${clinicId}`,
    );

    const locationRows = await rows<{
      id: string;
      name: string;
      address: string | null;
      maps_url: string | null;
      phone: string | null;
      lat: string | null;
      lng: string | null;
      is_primary: boolean;
    }>(
      db,
      sql`select id, name, address, maps_url, phone, lat::text, lng::text, is_primary
            from location where clinic_id = ${clinicId} order by is_primary desc, name`,
    );

    const availabilityRows = await rows<{
      provider_id: string;
      weekday: number;
      start_local: string;
      end_local: string;
    }>(
      db,
      sql`select provider_id, weekday,
                 start_local::text as start_local, end_local::text as end_local
            from availability_rule
           where clinic_id = ${clinicId}
             and (valid_from is null or valid_from <= current_date)
             and (valid_to is null or valid_to >= current_date)`,
    );

    const patientRows = await rows<{
      id: string;
      full_name: string | null;
      preferred_name: string | null;
      language: string | null;
      flags: unknown;
    }>(
      db,
      sql`select id, full_name, preferred_name, language, flags
            from patient where clinic_id = ${clinicId} and id = ${patientId}`,
    );
    const patientRow = patientRows[0];
    if (!patientRow) throw new Error("patient not found");

    const upcomingRows = await rows<{
      id: string;
      service_id: string;
      service_name: string;
      provider_id: string;
      provider_name: string;
      starts_at_ms: number;
      ends_at_ms: number;
      status: string;
      deposit_required_minor: string | number;
      deposit_paid_minor: string | number;
    }>(
      db,
      sql`select a.id, a.service_id, s.name as service_name,
                 a.provider_id, p.display_name as provider_name,
                 ${epochMs("lower(a.slot)")} as starts_at_ms,
                 ${epochMs("upper(a.slot)")} as ends_at_ms,
                 a.status, a.deposit_required_minor, a.deposit_paid_minor
            from appointment a
            join service s on s.id = a.service_id
            join provider p on p.id = a.provider_id
           where a.clinic_id = ${clinicId}
             and a.patient_id = ${patientId}
             and a.status in ('pending_deposit', 'booked', 'confirmed')
             and upper(a.slot) > now()
           order by lower(a.slot)
           limit 10`,
    );

    const conversationRows = await rows<{ agent_summary: string | null }>(
      db,
      sql`select agent_summary from conversation
           where clinic_id = ${clinicId} and id = ${conversationId}`,
    );

    // One extra row, so "is there more history than we sent?" is answered
    // without a second count query.
    const messageRows = await rows<{
      direction: string;
      body: string | null;
      transcript: string | null;
      sent_by: string | null;
      at_ms: number;
    }>(
      db,
      sql`select direction, body, transcript, sent_by, ${epochMs("at")} as at_ms
            from message
           where clinic_id = ${clinicId} and conversation_id = ${conversationId}
             and coalesce(body, transcript) is not null
           order by at desc, id desc
           limit ${HISTORY_LIMIT + 1}`,
    );

    const holdRows = await rows<{
      id: string;
      provider_id: string;
      service_id: string;
      starts_at_ms: number;
      ends_at_ms: number;
      expires_at_ms: number;
    }>(
      db,
      sql`select id, provider_id, service_id,
                 ${epochMs("lower(slot)")} as starts_at_ms,
                 ${epochMs("upper(slot)")} as ends_at_ms,
                 ${epochMs("expires_at")} as expires_at_ms
            from slot_hold
           where clinic_id = ${clinicId}
             and (conversation_id = ${conversationId} or patient_id = ${patientId})
             and expires_at > now()
           order by lower(slot)`,
    );

    /**
     * The turn budget (CONVERSATION_ENGINE.md §3.3).
     *
     * Per **clinic day**, not per rolling 24h: a patient who exhausted the
     * agent yesterday evening starts fresh this morning, which is what a
     * patient would expect and what a front desk would do.
     *
     * Scripted safety replies are excluded. They are queued under the same
     * `sent_by = 'agent'` and carry `meta.scripted = true`; counting them would
     * mean an emergency script, an out-of-scope redirect and a consent notice
     * ate into the budget for the *actual* booking conversation that follows.
     */
    const turnRows = await rows<{ total: string | number }>(
      db,
      sql`select count(*) as total from message
           where clinic_id = ${clinicId} and conversation_id = ${conversationId}
             and direction = 'out' and sent_by = 'agent'
             and coalesce(meta ->> 'scripted', 'false') <> 'true'
             and (at at time zone ${clinicRow.timezone})::date
                 = (now() at time zone ${clinicRow.timezone})::date`,
    );

    const intakeByService = new Map<string, string[]>();
    for (const row of intakeRows) {
      const list = intakeByService.get(row.service_id) ?? [];
      list.push(row.question);
      intakeByService.set(row.service_id, list);
    }

    const servicesByProvider = new Map<string, string[]>();
    for (const row of providerServiceRows) {
      const list = servicesByProvider.get(row.provider_id) ?? [];
      list.push(row.service_id);
      servicesByProvider.set(row.provider_id, list);
    }

    const providerNames = new Map(providerRows.map((p) => [p.id, p.display_name]));

    const hoursByProvider = new Map<
      string,
      { weekday: number; startLocal: string; endLocal: string }[]
    >();
    for (const row of availabilityRows) {
      const list = hoursByProvider.get(row.provider_id) ?? [];
      list.push({
        weekday: num(row.weekday),
        startLocal: row.start_local,
        endLocal: row.end_local,
      });
      hoursByProvider.set(row.provider_id, list);
    }

    const history: HistoryMessage[] = messageRows
      .slice(0, HISTORY_LIMIT)
      .reverse()
      .map((row) => ({
        role: row.direction === "in" ? ("patient" as const) : ("clinic" as const),
        sentBy: row.sent_by,
        text: clampHistory(row.body ?? row.transcript ?? ""),
        at: instant(row.at_ms),
      }));

    return {
      clinic: {
        id: clinicRow.id,
        name: clinicRow.name,
        timezone: clinicRow.timezone,
        currency: clinicRow.currency,
        defaultLanguage: clinicRow.default_language,
        specialty: providerRows[0]?.specialty ?? null,
      },
      policies: {
        freeRescheduleHours: num(policyRaw["free_reschedule_hours"], 24),
        forfeitHours: num(policyRaw["forfeit_hours"], 2),
        bookingWindowDays: num(clinicRow.booking_window_days, 30),
        minNoticeMin: num(clinicRow.min_notice_min, 60),
      },
      knowledge: knowledgeRows.map((row) => ({
        category: row.category,
        title: row.title,
        body: row.body,
      })),
      services: serviceRows.map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category,
        durationMin: num(row.duration_min),
        priceMinor: row.price_minor === null ? null : num(row.price_minor),
        priceNote: row.price_note,
        depositMinor: num(row.deposit_minor),
        description: row.description_public,
        prepInstructions: row.prep_instructions,
        intakeQuestions: intakeByService.get(row.id) ?? [],
      })),
      providers: providerRows.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        title: row.title,
        specialty: row.specialty,
        bio: row.bio_public,
        serviceIds: servicesByProvider.get(row.id) ?? [],
      })),
      locations: locationRows.map((row) => ({
        id: row.id,
        name: row.name,
        address: row.address,
        mapsUrl: row.maps_url,
        phone: row.phone,
        lat: row.lat === null ? null : num(row.lat),
        lng: row.lng === null ? null : num(row.lng),
        isPrimary: row.is_primary,
      })),
      hours: [...hoursByProvider.entries()].map(([providerId, rules]) => ({
        providerId,
        providerName: providerNames.get(providerId) ?? providerId,
        summary: summariseHours(rules),
      })),
      patient: {
        id: patientRow.id,
        firstName: firstNameOf(patientRow.preferred_name, patientRow.full_name),
        language: patientRow.language,
        noShowCount: num(flag(patientRow.flags, "no_show_count")),
        isVip: flag(patientRow.flags, "vip") === true,
        isBlocked: flag(patientRow.flags, "blocked") === true,
        upcoming: upcomingRows.map((row) => ({
          id: row.id,
          serviceId: row.service_id,
          serviceName: row.service_name,
          providerId: row.provider_id,
          providerName: row.provider_name,
          start: instant(row.starts_at_ms),
          end: instant(row.ends_at_ms),
          status: row.status,
          depositRequiredMinor: num(row.deposit_required_minor),
          depositPaidMinor: num(row.deposit_paid_minor),
        })),
      },
      conversationId,
      history,
      summary: conversationRows[0]?.agent_summary ?? null,
      historyTruncated: messageRows.length > HISTORY_LIMIT,
      openHolds: holdRows.map((row) => ({
        id: row.id,
        providerId: row.provider_id,
        serviceId: row.service_id,
        start: instant(row.starts_at_ms),
        end: instant(row.ends_at_ms),
        expiresAt: instant(row.expires_at_ms),
      })),
      agentTurnsToday: num(turnRows[0]?.total),
      now,
    } satisfies AgentContext;
  });
}

function clampHistory(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_HISTORY_CHARS ? trimmed : `${trimmed.slice(0, MAX_HISTORY_CHARS)}…`;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function priceText(service: ServiceFact, currency: string): string {
  const parts: string[] = [];
  if (service.priceMinor !== null) {
    parts.push(formatMoney(money(service.priceMinor, currency as CurrencyCode)));
  }
  if (service.priceNote !== null && service.priceNote.trim() !== "") parts.push(service.priceNote);
  return parts.length === 0 ? "price not listed" : parts.join(" — ");
}

function depositText(service: ServiceFact, currency: string): string {
  return service.depositMinor > 0
    ? `deposit ${formatMoney(money(service.depositMinor, currency as CurrencyCode))} required to confirm`
    : "no deposit";
}

/**
 * The clinic facts block (system prompt part 3).
 *
 * Rendered as flat labelled lines rather than prose or JSON: the guardrail's
 * grounding check does a substring match against this same text, so every
 * number and name the agent is allowed to say must appear here in exactly the
 * form the agent would write it.
 */
export function renderClinicFacts(context: AgentContext): string {
  const clinic = context.clinic;
  const lines: string[] = [];

  lines.push(`CLINIC: ${clinic.name}`);
  lines.push(`TIMEZONE: ${clinic.timezone}`);
  lines.push(`CURRENCY: ${clinic.currency}`);
  lines.push("");

  lines.push("SERVICES (id — name — duration — price — deposit):");
  if (context.services.length === 0) lines.push("  (none configured)");
  for (const service of context.services) {
    lines.push(
      `  ${service.id} — ${service.name} — ${service.durationMin} min — ` +
        `${priceText(service, clinic.currency)} — ${depositText(service, clinic.currency)}`,
    );
    if (service.description !== null && service.description.trim() !== "") {
      lines.push(`      about: ${service.description}`);
    }
    if (service.prepInstructions !== null && service.prepInstructions.trim() !== "") {
      lines.push(`      preparation (clinic's own wording, quote verbatim): ${service.prepInstructions}`);
    }
    for (const question of service.intakeQuestions) {
      lines.push(`      ask before booking: ${question}`);
    }
  }
  lines.push("");

  lines.push("PROVIDERS (id — name — what they do):");
  if (context.providers.length === 0) lines.push("  (none configured)");
  for (const provider of context.providers) {
    const title = provider.title === null ? "" : `, ${provider.title}`;
    const specialty = provider.specialty === null ? "" : ` — ${provider.specialty}`;
    lines.push(`  ${provider.id} — ${provider.displayName}${title}${specialty}`);
    if (provider.bio !== null && provider.bio.trim() !== "") lines.push(`      bio: ${provider.bio}`);
    lines.push(`      offers services: ${provider.serviceIds.join(", ") || "(none)"}`);
  }
  lines.push("");

  lines.push("WORKING HOURS (clinic time):");
  if (context.hours.length === 0) lines.push("  (none configured)");
  for (const entry of context.hours) {
    lines.push(`  ${entry.providerName}: ${entry.summary}`);
  }
  lines.push("");

  lines.push("LOCATIONS:");
  if (context.locations.length === 0) lines.push("  (none configured)");
  for (const location of context.locations) {
    lines.push(`  ${location.name}${location.isPrimary ? " (main)" : ""}`);
    if (location.address !== null) lines.push(`      address: ${location.address}`);
    if (location.phone !== null) lines.push(`      phone: ${location.phone}`);
  }
  lines.push("");

  lines.push("BOOKING POLICY:");
  lines.push(
    `  Free to reschedule or cancel up to ${context.policies.freeRescheduleHours} hours before the appointment.`,
  );
  lines.push(
    `  Inside ${context.policies.forfeitHours} hours the deposit is not refunded. The tools enforce this; do not pre-judge it.`,
  );
  lines.push(`  Bookings can be made up to ${context.policies.bookingWindowDays} days ahead.`);
  lines.push(
    `  The earliest bookable time is ${context.policies.minNoticeMin} minutes from now.`,
  );
  lines.push("");

  lines.push("CLINIC KNOWLEDGE (the clinic's own words):");
  if (context.knowledge.length === 0) lines.push("  (none written yet)");
  for (const item of context.knowledge) {
    const heading = item.title === null ? item.category : `${item.category} — ${item.title}`;
    lines.push(`  [${heading}] ${item.body}`);
  }

  return lines.join("\n");
}

/** The patient card (system prompt part 4). PHI-minimal by construction. */
export function renderPatientCard(context: AgentContext): string {
  const { patient, clinic } = context;
  const lines: string[] = [];

  lines.push(
    patient.firstName === null
      ? "You do not know this patient's name yet. Do not ask for it unless you are booking."
      : `First name: ${patient.firstName}. Use it, never a surname.`,
  );
  lines.push(
    `Preferred language on record: ${patient.language ?? "unknown"} (clinic default ${clinic.defaultLanguage}). Match the language of their latest message over this.`,
  );

  if (patient.noShowCount > 0) {
    lines.push(
      `Missed appointments on record: ${patient.noShowCount}. Do not mention this to the patient or lecture them about it.`,
    );
  }
  if (patient.isVip) lines.push("Flagged VIP by the clinic.");

  if (patient.upcoming.length === 0) {
    lines.push("Upcoming appointments: none.");
  } else {
    lines.push("Upcoming appointments:");
    for (const appointment of patient.upcoming) {
      lines.push(
        `  ${appointment.id} — ${appointment.serviceName} with ${appointment.providerName} — ` +
          `${formatInTz(appointment.start, clinic.timezone, "EEE d MMM, h:mm a")} — status ${appointment.status}`,
      );
    }
  }

  if (context.openHolds.length > 0) {
    lines.push("Slots held for this patient right now (they expire, so do not dawdle):");
    for (const hold of context.openHolds) {
      lines.push(
        `  ${hold.id} — ${formatInTz(hold.start, clinic.timezone, "EEE d MMM, h:mm a")} — ` +
          `expires ${formatInTz(hold.expiresAt, clinic.timezone, "h:mm a")}`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * The conservative addendum the router asks for on a low-confidence
 * classification (CONVERSATION_ENGINE.md §2, `RouteDecision.agentAddendum`).
 */
export const CONSERVATIVE_ADDENDUM = `
# 9. Extra caution for this message

The safety classifier was not confident about this message. Treat it as more likely than usual to be something you should not handle. Do not stretch to interpret it: if you are not certain what the patient is asking for administratively, ask one short clarifying question, or call \`escalate\` with kind \`low_confidence\` and send a holding message. Do not answer a question you had to guess at.
`.trim();

export interface RenderPromptInput {
  readonly context: AgentContext;
  readonly toolGuidance: string;
  readonly addendum?: "conservative" | undefined;
}

/** Assemble the eight-part system prompt (CONVERSATION_ENGINE.md §3.1). */
export function renderAgentPrompt(input: RenderPromptInput): string {
  const { context } = input;
  const base = fillPrompt(agentPromptTemplate(), {
    CLINIC_NAME: context.clinic.name,
    CLINIC_FACTS: renderClinicFacts(context),
    PATIENT_CARD: renderPatientCard(context),
    TOOL_GUIDANCE: input.toolGuidance,
    NOW_LOCAL: formatInTz(context.now, context.clinic.timezone, "EEE d MMM yyyy, h:mm a"),
    CLINIC_TIMEZONE: context.clinic.timezone,
    WEEKDAY: formatInTz(context.now, context.clinic.timezone, "EEEE"),
  });

  return input.addendum === "conservative" ? `${base}\n\n${CONSERVATIVE_ADDENDUM}\n` : base;
}

/**
 * The transcript the model sees.
 *
 * Beyond `HISTORY_LIMIT` messages the summary replaces the older half rather
 * than being added to it (CONVERSATION_ENGINE.md §8: "included in context
 * instead of full history beyond 20 messages") — otherwise a long conversation
 * grows without bound and the oldest, least relevant turns crowd out the ones
 * that matter.
 */
export function renderHistory(context: AgentContext): string {
  const lines: string[] = [];

  if (context.historyTruncated && context.summary !== null && context.summary.trim() !== "") {
    lines.push(`Summary of the conversation so far: ${context.summary.trim()}`);
    lines.push("");
  }

  if (context.history.length > 0) {
    lines.push("Recent messages (oldest first):");
    for (const message of context.history) {
      const who =
        message.role === "patient"
          ? "patient"
          : message.sentBy !== null && message.sentBy.startsWith("staff")
            ? "clinic staff"
            : "you";
      lines.push(`${who}: ${message.text}`);
    }
  }

  return lines.join("\n");
}
