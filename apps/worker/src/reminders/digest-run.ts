import type { TenantClient, WithTenant } from "@sema/db";
import { toLanguage, tryNormalisePhone, type PrefixedId } from "@sema/shared";

import { enqueueStaffNotification } from "../jobs/outbox.js";
import { rows } from "../jobs/sql.js";
import { auditExists, lockDigestKey, writeAudit } from "./audit.js";
import { parseDigestConfig } from "./config.js";
import {
  loadOwnerWeeklyMetrics,
  loadStaffMorningDigest,
  renderOwnerWeeklyDigest,
  renderOwnerWeeklyHeadline,
  renderStaffMorningDigest,
  renderStaffMorningHeadline,
} from "./digest.js";
import {
  digestRecipient,
  noopDigestDelivery,
  type DigestDelivery,
  type DigestKind,
  type DigestMessage,
  type DigestRecipient,
} from "./digest-delivery.js";
import {
  localHour,
  localWeekday,
  morningDigestWindow,
  weeklyDigestWindow,
  type Weekday,
} from "./digest-period.js";
import { loadClinic } from "./repository.js";
import type { JobLogger } from "./logging.js";

/**
 * Deciding whether a digest is due, building it, and sending it.
 *
 * The sweep runs hourly and each clinic answers "is it my hour yet?" in its own
 * timezone. That is a deliberate alternative to a cron per clinic: BullMQ's
 * repeat patterns are evaluated in the worker's timezone, and Sema is
 * multi-region by design (SPEC §1), so a `0 7 * * *` schedule would send
 * Nairobi's morning digest at whatever 07:00 means to a Frankfurt container.
 *
 * Running hourly means the "is it due" question is asked 24 times a day and
 * must answer yes exactly once. The idempotency key is an `audit_log` row keyed
 * by clinic, kind and period, taken under a transaction-scoped advisory lock so
 * two overlapping sweeps cannot both pass the check.
 */

export interface DigestDeps {
  readonly withTenant: WithTenant;
  readonly now: () => Date;
  readonly delivery?: DigestDelivery;
  readonly log?: JobLogger;
}

/** The template Sema registers for staff-facing digests (INTEGRATIONS.md §1). */
export const STAFF_DIGEST_TEMPLATE = "staff_digest";

export const DIGEST_ACTIONS: Readonly<Record<DigestKind, string>> = {
  owner_weekly: "digest.owner_weekly",
  staff_morning: "digest.staff_morning",
};

/** Who each digest goes to. Never a patient (SPEC §4.8, hard rule 4). */
const RECIPIENT_ROLES: Readonly<Record<DigestKind, readonly string[]>> = {
  owner_weekly: ["owner", "admin"],
  staff_morning: ["owner", "admin", "staff", "provider"],
};

export interface DigestReport {
  readonly clinicId: string;
  readonly sent: DigestKind[];
  readonly skipped: DigestKind[];
}

/**
 * Run both digests for one clinic if their moment has arrived.
 *
 * One tenant transaction for the whole clinic, so the advisory lock, the
 * metrics read, the outbox rows and the audit marker commit together.
 */
export async function runClinicDigests(
  deps: DigestDeps,
  input: { clinicId: PrefixedId<"clinic">; force?: DigestKind },
): Promise<DigestReport> {
  const now = deps.now();
  const delivery = deps.delivery ?? noopDigestDelivery;

  return deps.withTenant(input.clinicId, async (client) => {
    const clinic = await loadClinic(client, input.clinicId);
    if (!clinic) return { clinicId: input.clinicId, sent: [], skipped: [] };

    const config = parseDigestConfig(clinic.flags);
    const sent: DigestKind[] = [];
    const skipped: DigestKind[] = [];

    if (!config.enabled && !input.force) {
      return { clinicId: input.clinicId, sent, skipped };
    }

    const hour = localHour(now, clinic.timezone);
    const weekday = localWeekday(now, clinic.timezone);

    const morningDue = input.force === "staff_morning" || hour === config.morningHour;
    const weeklyDue =
      input.force === "owner_weekly" ||
      (weekday === config.ownerWeekday && hour === config.ownerHour);

    if (morningDue) {
      const done = await sendStaffMorning(client, {
        clinicId: input.clinicId,
        timezone: clinic.timezone,
        now,
        delivery,
      });
      (done ? sent : skipped).push("staff_morning");
    }

    if (weeklyDue) {
      const done = await sendOwnerWeekly(client, {
        clinicId: input.clinicId,
        timezone: clinic.timezone,
        currency: clinic.currency,
        weekStartsOn: config.ownerWeekday as Weekday,
        now,
        delivery,
      });
      (done ? sent : skipped).push("owner_weekly");
    }

    if (sent.length > 0) {
      deps.log?.info({ clinicId: input.clinicId, digests: sent.join(",") }, "digests delivered");
    }

    return { clinicId: input.clinicId, sent, skipped };
  });
}

/**
 * `loadClinic` deliberately does not select `name` — nothing else in the
 * reminder path needs it, and the fewer identifying columns a shared loader
 * hands around, the fewer places one can leak from. The digest reads it here.
 */
async function loadClinicName(client: TenantClient, clinicId: string): Promise<string> {
  const found = await rows<{ name: string }>(client, `select name from clinic where id = $1`, [
    clinicId,
  ]);
  return found[0]?.name ?? "Your clinic";
}

async function loadRecipients(
  client: TenantClient,
  clinicId: string,
  kind: DigestKind,
): Promise<DigestRecipient[]> {
  const found = await rows<{
    id: string;
    name: string;
    role: string;
    email: string;
    phone: string | null;
  }>(
    client,
    `select id, name, role::text as role, email::text as email, phone
       from staff_user
      where clinic_id = $1 and role = any($2::staff_role[])
      order by role, name`,
    [clinicId, [...RECIPIENT_ROLES[kind]]],
  );
  return found.map((r) =>
    digestRecipient({
      staffUserId: r.id,
      name: r.name,
      role: r.role,
      email: r.email,
      phone: r.phone,
    }),
  );
}

/**
 * Queue the WhatsApp copy, one template per staff member with a usable number,
 * and hand the full text to the email seam.
 */
async function deliver(
  client: TenantClient,
  input: {
    clinicId: PrefixedId<"clinic">;
    kind: DigestKind;
    message: DigestMessage;
    headline: string;
    periodLabel: string;
    language: string;
    phones: Map<string, string>;
    delivery: DigestDelivery;
  },
): Promise<void> {
  for (const recipient of input.message.recipients) {
    const raw = input.phones.get(recipient.staffUserId);
    const to = raw ? tryNormalisePhone(raw) : undefined;
    if (!to) continue;
    await enqueueStaffNotification(client, {
      clinicId: input.clinicId,
      template: {
        to,
        templateName: STAFF_DIGEST_TEMPLATE,
        language: toLanguage(input.language),
        bodyParameters: [input.message.clinicName, input.periodLabel, input.headline],
      },
      audit: {
        digest: input.kind,
        period: input.message.periodKey,
        staffUserId: recipient.staffUserId,
      },
    });
  }

  await input.delivery.deliver(input.message);
}

/** Staff phone numbers, kept out of `DigestRecipient` (which is masked). */
async function loadPhones(
  client: TenantClient,
  clinicId: string,
  kind: DigestKind,
): Promise<Map<string, string>> {
  const found = await rows<{ id: string; phone: string | null }>(
    client,
    `select id, phone from staff_user
      where clinic_id = $1 and role = any($2::staff_role[]) and phone is not null`,
    [clinicId, [...RECIPIENT_ROLES[kind]]],
  );
  return new Map(found.filter((r) => r.phone).map((r) => [r.id, r.phone as string]));
}

async function claim(
  client: TenantClient,
  clinicId: string,
  kind: DigestKind,
  periodKey: string,
): Promise<boolean> {
  await lockDigestKey(client, clinicId, `${kind}:${periodKey}`);
  const already = await auditExists(client, clinicId, DIGEST_ACTIONS[kind], periodKey);
  return !already;
}

async function sendStaffMorning(
  client: TenantClient,
  input: {
    clinicId: PrefixedId<"clinic">;
    timezone: string;
    now: Date;
    delivery: DigestDelivery;
  },
): Promise<boolean> {
  const window = morningDigestWindow(input.now, input.timezone);
  if (!(await claim(client, input.clinicId, "staff_morning", window.periodKey))) return false;

  const clinicName = await loadClinicName(client, input.clinicId);
  const digest = await loadStaffMorningDigest(client, input.clinicId, window);
  const recipients = await loadRecipients(client, input.clinicId, "staff_morning");
  const phones = await loadPhones(client, input.clinicId, "staff_morning");

  const message: DigestMessage = {
    clinicId: input.clinicId,
    clinicName,
    kind: "staff_morning",
    periodKey: window.periodKey,
    subject: `${clinicName} — today's appointments`,
    body: renderStaffMorningDigest(clinicName, digest),
    recipients,
  };

  await deliver(client, {
    clinicId: input.clinicId,
    kind: "staff_morning",
    message,
    headline: renderStaffMorningHeadline(digest),
    periodLabel: "Today",
    language: "en",
    phones,
    delivery: input.delivery,
  });

  await writeAudit(client, {
    clinicId: input.clinicId,
    actor: "system",
    action: DIGEST_ACTIONS.staff_morning,
    entity: "digest",
    entityId: window.periodKey,
    after: { recipients: recipients.length, appointments: digest.appointments.length },
  });

  return true;
}

async function sendOwnerWeekly(
  client: TenantClient,
  input: {
    clinicId: PrefixedId<"clinic">;
    timezone: string;
    currency: string;
    weekStartsOn: Weekday;
    now: Date;
    delivery: DigestDelivery;
  },
): Promise<boolean> {
  const window = weeklyDigestWindow(input.now, input.timezone, input.weekStartsOn);
  if (!(await claim(client, input.clinicId, "owner_weekly", window.periodKey))) return false;

  const clinicName = await loadClinicName(client, input.clinicId);
  const metrics = await loadOwnerWeeklyMetrics(client, input.clinicId, window, input.currency);
  const recipients = await loadRecipients(client, input.clinicId, "owner_weekly");
  const phones = await loadPhones(client, input.clinicId, "owner_weekly");

  const message: DigestMessage = {
    clinicId: input.clinicId,
    clinicName,
    kind: "owner_weekly",
    periodKey: window.periodKey,
    subject: `${clinicName} — weekly summary`,
    body: renderOwnerWeeklyDigest(clinicName, metrics),
    recipients,
  };

  await deliver(client, {
    clinicId: input.clinicId,
    kind: "owner_weekly",
    message,
    headline: renderOwnerWeeklyHeadline(metrics),
    periodLabel: "Last week",
    language: "en",
    phones,
    delivery: input.delivery,
  });

  await writeAudit(client, {
    clinicId: input.clinicId,
    actor: "system",
    action: DIGEST_ACTIONS.owner_weekly,
    entity: "digest",
    entityId: window.periodKey,
    after: {
      recipients: recipients.length,
      bookings: metrics.bookings,
      noShows: metrics.noShows,
      depositsCollectedMinor: metrics.depositsCollectedMinor,
      afterHoursInbound: metrics.afterHoursInbound,
    },
  });

  return true;
}
