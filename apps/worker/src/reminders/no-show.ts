import type { WithTenant } from "@sema/db";
import { newId, type PrefixedId } from "@sema/shared";

import { writeAudit } from "./audit.js";
import { parseReminderConfig } from "./config.js";
import { NO_SHOW_LOOKBACK_HOURS } from "./plan.js";
import {
  claimNoShowCandidates,
  incrementNoShowCount,
  insertRebookNudgeIfAbsent,
  loadClinic,
  markAppointmentNoShow,
  skipScheduledReminders,
} from "./repository.js";
import type { JobLogger } from "./logging.js";

/**
 * No-show detection.
 *
 * SPEC §4.4: "30 min after slot start with no `arrived`, mark `no_show`, send a
 * gentle rebook message." Four things happen, all in one tenant transaction:
 *
 *   1. `appointment.status → no_show`
 *   2. `patient.flags.no_show_count += 1`   (the flag the inbox surfaces)
 *   3. an `audit_log` row                    (hard rule 7)
 *   4. a `no_show_rebook` reminder, due now  (the nudge)
 *
 * The nudge is a `reminder` row rather than a direct send so it inherits the
 * whole sending path: the opt-out and blocked checks, the template, the outbox
 * retry, the audit. It goes out on the next reminder sweep, a minute later —
 * which is also a small, welcome grace period for a patient who is simply
 * running very late.
 *
 * Idempotency is the `status in ('booked','confirmed','pending_deposit')`
 * predicate plus `for update skip locked`: once a row is `no_show` no sweep can
 * claim it again, so a second run in the same minute marks nothing.
 */

export interface NoShowDeps {
  readonly withTenant: WithTenant;
  readonly now: () => Date;
  readonly log?: JobLogger;
}

export interface NoShowReport {
  readonly clinicId: string;
  readonly marked: number;
  readonly nudged: number;
}

/** How many appointments one clinic may be marked in a single sweep. */
export const NO_SHOW_BATCH_LIMIT = 200;

export async function markNoShows(
  deps: NoShowDeps,
  input: { clinicId: PrefixedId<"clinic">; limit?: number },
): Promise<NoShowReport> {
  const now = deps.now();

  return deps.withTenant(input.clinicId, async (client) => {
    const clinic = await loadClinic(client, input.clinicId);
    if (!clinic) return { clinicId: input.clinicId, marked: 0, nudged: 0 };

    // Clinic-level config only: a no-show grace period is a property of how the
    // front desk runs, not of the service booked.
    const config = parseReminderConfig(clinic.flags);
    if (!config.noShowEnabled) return { clinicId: input.clinicId, marked: 0, nudged: 0 };

    const candidates = await claimNoShowCandidates(client, input.clinicId, {
      now,
      afterMin: config.noShowAfterMin,
      lookbackHours: NO_SHOW_LOOKBACK_HOURS,
      limit: input.limit ?? NO_SHOW_BATCH_LIMIT,
    });

    let marked = 0;
    let nudged = 0;

    for (const candidate of candidates) {
      await markAppointmentNoShow(client, input.clinicId, candidate.appointmentId);
      const noShowCount = await incrementNoShowCount(client, input.clinicId, candidate.patientId);

      // Any pre-visit reminder still pending for a slot that has already passed
      // is now meaningless. (Normally there is none — they were due before the
      // appointment — but a clinic that shortened an offset can leave one.)
      const cancelledReminders = await skipScheduledReminders(
        client,
        input.clinicId,
        candidate.appointmentId,
        ["pre_24h", "pre_2h"],
      );

      if (config.noShowRebook) {
        const inserted = await insertRebookNudgeIfAbsent(client, {
          id: newId("reminder"),
          clinicId: input.clinicId,
          appointmentId: candidate.appointmentId,
          dueAt: now,
        });
        if (inserted) nudged += 1;
      }

      await writeAudit(client, {
        clinicId: input.clinicId,
        actor: "system",
        action: "appointment.no_show",
        entity: "appointment",
        entityId: candidate.appointmentId,
        before: { status: candidate.status },
        after: {
          status: "no_show",
          providerId: candidate.providerId,
          serviceId: candidate.serviceId,
          startsAt: candidate.start.toISOString(),
          patientNoShowCount: noShowCount,
          cancelledReminders,
          rebookNudge: config.noShowRebook,
        },
        reason: `grace_min:${config.noShowAfterMin}`,
      });

      marked += 1;

      deps.log?.info(
        {
          appointmentId: candidate.appointmentId,
          providerId: candidate.providerId,
          graceMin: config.noShowAfterMin,
        },
        "appointment marked no-show",
      );
    }

    return { clinicId: input.clinicId, marked, nudged };
  });
}
