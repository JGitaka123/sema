import type { TenantClient, WithTenant } from "@sema/db";
import { maskPhone, tryNormalisePhone, type E164, type PrefixedId } from "@sema/shared";

import { enqueueOutbound } from "../jobs/outbox.js";
import { writeAudit } from "./audit.js";
import { REMINDER_KINDS, type ReminderKind } from "./config.js";
import { decideReminderSend, type SkipReason } from "./decide.js";
import {
  claimDueReminderIds,
  loadClinic,
  loadDueReminders,
  markReminderSent,
  markReminderStatus,
  type DueReminderRow,
} from "./repository.js";
import { reminderTemplate } from "./templates.js";
import type { JobLogger } from "./logging.js";

/**
 * Sending the reminders that have come due.
 *
 * Everything goes out through `enqueueOutbound` (CLAUDE.md §Conventions —
 * "never call the channel directly"), so a reminder gets the same retry,
 * backoff and dead-lettering as every other outbound message, and appears in
 * the staff inbox as a message on the patient's thread.
 *
 * Claim, decide, enqueue and mark all happen in **one** tenant transaction.
 * That is what makes running the sweep twice safe: the second run finds the
 * rows no longer `scheduled`, and a crash halfway rolls the outbox row back
 * along with the status, so the reminder is retried rather than lost or
 * duplicated.
 */

export interface ReminderSendDeps {
  readonly withTenant: WithTenant;
  readonly now: () => Date;
  readonly log?: JobLogger;
}

export interface ReminderSendReport {
  readonly clinicId: string;
  readonly sent: number;
  readonly skipped: number;
  /** Outbox rows to hand to the delivery queue *after* the commit. */
  readonly outboxIds: string[];
  readonly skipReasons: Partial<Record<SkipReason | "invalid_phone", number>>;
}

/** How many reminders one clinic may send per sweep. Keeps a batch bounded. */
export const REMINDER_BATCH_LIMIT = 200;

function isReminderKind(value: string): value is ReminderKind {
  return (REMINDER_KINDS as readonly string[]).includes(value);
}

export async function sendDueReminders(
  deps: ReminderSendDeps,
  input: { clinicId: PrefixedId<"clinic">; limit?: number },
): Promise<ReminderSendReport> {
  const now = deps.now();
  const limit = input.limit ?? REMINDER_BATCH_LIMIT;

  return deps.withTenant(input.clinicId, async (client) => {
    const ids = await claimDueReminderIds(client, input.clinicId, now, limit);
    if (ids.length === 0) {
      return { clinicId: input.clinicId, sent: 0, skipped: 0, outboxIds: [], skipReasons: {} };
    }

    const clinic = await loadClinic(client, input.clinicId);
    const rows = await loadDueReminders(client, input.clinicId, ids);

    const outboxIds: string[] = [];
    const skipReasons: Partial<Record<SkipReason | "invalid_phone", number>> = {};
    let sent = 0;
    let skipped = 0;

    const skip = async (
      reminder: DueReminderRow,
      reason: SkipReason | "invalid_phone",
    ): Promise<void> => {
      await markReminderStatus(client, input.clinicId, reminder.reminderId, "skipped");
      await writeAudit(client, {
        clinicId: input.clinicId,
        actor: "system",
        action: "reminder.skipped",
        entity: "reminder",
        entityId: reminder.reminderId,
        after: { kind: reminder.kind, appointmentId: reminder.appointmentId },
        reason,
      });
      skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
      skipped += 1;
    };

    for (const reminder of rows) {
      if (!isReminderKind(reminder.kind)) {
        // `post_visit`, `recall` and `custom` are Phase 2 kinds with no sender
        // yet. Leaving them `scheduled` would make this sweep claim them again
        // every minute forever.
        await skip(reminder, "appointment_inactive");
        continue;
      }

      const decision = decideReminderSend(
        {
          kind: reminder.kind,
          dueAt: reminder.dueAt,
          appointmentStatus: reminder.appointmentStatus,
          patientBlocked: reminder.patientBlocked,
          serviceMessagesGranted: reminder.serviceMessagesGranted,
          conversationId: reminder.conversationId,
          conversationMode: reminder.conversationMode,
        },
        now,
      );

      if (decision.action === "skip") {
        await skip(reminder, decision.reason);
        continue;
      }

      const to = tryNormalisePhone(reminder.phoneE164);
      if (!to) {
        await skip(reminder, "invalid_phone");
        continue;
      }

      const outboxId = await queueReminder(client, {
        clinicId: input.clinicId,
        // `decideReminderSend` returning `send` guarantees a conversation.
        conversationId: reminder.conversationId as string,
        kind: reminder.kind,
        reminder,
        to,
        timezone: clinic?.timezone ?? "Africa/Nairobi",
        defaultLanguage: clinic?.defaultLanguage ?? "en",
      });

      outboxIds.push(outboxId);
      sent += 1;

      deps.log?.info(
        {
          reminderId: reminder.reminderId,
          appointmentId: reminder.appointmentId,
          kind: reminder.kind,
          // Hard rule 4: the number is masked before it can reach a log sink.
          patientPhone: maskPhone(reminder.phoneE164),
        },
        "reminder queued",
      );
    }

    return { clinicId: input.clinicId, sent, skipped, outboxIds, skipReasons };
  });
}

async function queueReminder(
  client: TenantClient,
  input: {
    clinicId: PrefixedId<"clinic">;
    conversationId: string;
    kind: ReminderKind;
    reminder: DueReminderRow;
    to: E164;
    timezone: string;
    defaultLanguage: string;
  },
): Promise<string> {
  const message = reminderTemplate(input.kind, {
    to: input.to,
    patientName: input.reminder.patientName,
    serviceName: input.reminder.serviceName,
    providerName: input.reminder.providerName,
    locationName: input.reminder.locationName,
    start: input.reminder.start,
    timezone: input.timezone,
    language: input.reminder.language ?? input.defaultLanguage,
  });

  const queued = await enqueueOutbound(client, {
    clinicId: input.clinicId,
    conversationId: input.conversationId,
    message,
    // Not `agent`: no model was involved, and a clinic reading its audit log
    // should be able to tell a scheduled notice from something the AI decided.
    sentBy: "system",
  });

  await markReminderSent(client, input.clinicId, input.reminder.reminderId, queued.messageId);

  await writeAudit(client, {
    clinicId: input.clinicId,
    actor: "system",
    action: "reminder.sent",
    entity: "reminder",
    entityId: input.reminder.reminderId,
    after: {
      kind: input.kind,
      appointmentId: input.reminder.appointmentId,
      template: message.templateName,
      messageId: queued.messageId,
    },
  });

  return queued.outboxId;
}
