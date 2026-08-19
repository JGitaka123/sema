import {
  isWhatsAppError,
  type Channel,
  type OutboundMessage,
  type OutboundTemplate,
} from "@sema/channels";
import type { TenantClient, WithTenant } from "@sema/db";
import { AppError, newId, type PrefixedId } from "@sema/shared";

import { defaultChannelFactory, loadSender, requireSender, type ChannelFactory } from "../channel.js";
import { row } from "./sql.js";

/**
 * The outbox: the only door out of Sema.
 *
 * CLAUDE.md §Conventions — "never call the channel directly from request
 * handlers. Write to `outbox`, worker delivers, retries with backoff, marks
 * delivered/failed." Two things live here:
 *
 *   `enqueueOutbound` — write the `message` and `outbox` rows in one
 *                       transaction. Everything that wants to say something to
 *                       a patient calls this.
 *   `deliverOutbox`   — take one row and send it, once, with the 24-hour
 *                       window rule applied.
 *
 * Retry policy is BullMQ's (five attempts, exponential backoff —
 * ARCHITECTURE.md §11); this module records each attempt on the row and
 * dead-letters when they run out, so the inbox can show a human what failed
 * and why.
 */

/** ARCHITECTURE.md §11: five attempts, then dead-letter. */
export const MAX_ATTEMPTS = 5;

/** The message plus what to fall back to when the window has closed. */
export interface OutboxPayload {
  message: OutboundMessage;
  /**
   * The approved template to use instead when the 24-hour customer service
   * window has closed (COMPLIANCE.md §3). Without one, a free-form message
   * outside the window cannot be sent at all — Meta will reject it, so we do
   * not waste five attempts discovering that.
   */
  fallbackTemplate?: Omit<OutboundTemplate, "kind" | "to">;
}

export interface EnqueueOutboundParams {
  clinicId: PrefixedId<"clinic">;
  conversationId: string;
  message: OutboundMessage;
  fallbackTemplate?: OutboxPayload["fallbackTemplate"];
  /** `agent` | `system` | `staff:<staff_user id>` (DATA_MODEL: `message.sent_by`). */
  sentBy: string;
}

export interface EnqueuedOutbound {
  messageId: string;
  outboxId: string;
}

const MESSAGE_KIND_BY_OUTBOUND: Record<OutboundMessage["kind"], string> = {
  text: "text",
  interactive: "interactive",
  template: "template",
  location: "location",
};

/**
 * Extract the part of a message worth storing as `message.body`.
 *
 * A template has no body of its own until Meta renders it, so we store the
 * template name and let the inbox render from the registry.
 */
function bodyOf(message: OutboundMessage): string | null {
  switch (message.kind) {
    case "text":
    case "interactive":
      return message.body;
    case "location":
      return message.name ?? null;
    case "template":
      return null;
  }
}

/**
 * Write the message and its outbox row atomically.
 *
 * Called with a client that is already inside `withTenant`, so the caller can
 * book an appointment and queue its confirmation in one transaction — either
 * both happen or neither does.
 */
export async function enqueueOutbound(
  client: TenantClient,
  params: EnqueueOutboundParams,
): Promise<EnqueuedOutbound> {
  const messageId = newId("message");
  const outboxId = newId("outbox");

  const payload: OutboxPayload = {
    message: params.message,
    ...(params.fallbackTemplate === undefined
      ? {}
      : { fallbackTemplate: params.fallbackTemplate }),
  };

  await client.query(
    `insert into message
       (id, clinic_id, conversation_id, direction, kind, body, status, sent_by, template_name, at)
     values ($1, $2, $3, 'out', $4, $5, 'queued', $6, $7, now())`,
    [
      messageId,
      params.clinicId,
      params.conversationId,
      MESSAGE_KIND_BY_OUTBOUND[params.message.kind],
      bodyOf(params.message),
      params.sentBy,
      params.message.kind === "template" ? params.message.templateName : null,
    ],
  );

  await client.query(
    `insert into outbox (id, clinic_id, message_id, channel, payload, status, next_attempt_at)
     values ($1, $2, $3, 'whatsapp', $4::jsonb, 'pending', now())`,
    [outboxId, params.clinicId, messageId, JSON.stringify(payload)],
  );

  await client.query(
    `insert into audit_log (id, clinic_id, actor, action, entity, entity_id, after, at)
     values ($1, $2, $3, 'message.queued', 'message', $4, $5::jsonb, now())`,
    [
      newId("auditLog"),
      params.clinicId,
      params.sentBy,
      messageId,
      // Kind and template name only — never the body (hard rule 4, rule 7).
      JSON.stringify({
        kind: params.message.kind,
        template: params.message.kind === "template" ? params.message.templateName : null,
      }),
    ],
  );

  return { messageId, outboxId };
}

/**
 * Queue a template addressed to a **staff** number (INTEGRATIONS.md §5:
 * "WhatsApp template to staff number for emergencies … email daily digest").
 *
 * Same door out of Sema, one row short of the patient path: no `message` row.
 * `message.conversation_id` is `not null` and a conversation belongs to a
 * patient, so giving a staff notification one would either invent a fake
 * conversation or file the clinic's own digest into a patient's thread in the
 * inbox. `outbox.message_id` is nullable precisely so a delivery can exist
 * without a conversation, and `deliverOutbox` already reads it defensively.
 *
 * Templates only. There is no 24-hour window to reason about — a staff member
 * has not messaged the clinic's own number — so a free-form body would be
 * rejected by Meta, and `chooseDelivery` passes a template through untouched.
 *
 * Phase 7 (reminders/digests) is the first caller; Phase 8's escalation alerts
 * are the next.
 */
export async function enqueueStaffNotification(
  client: TenantClient,
  params: {
    clinicId: PrefixedId<"clinic">;
    template: Omit<OutboundTemplate, "kind">;
    /** Non-PHI context for the audit row: a digest kind, an escalation id. */
    audit?: Record<string, string | number | boolean | null>;
  },
): Promise<{ outboxId: string }> {
  const outboxId = newId("outbox");
  const payload: OutboxPayload = {
    message: { ...params.template, kind: "template" },
  };

  await client.query(
    `insert into outbox (id, clinic_id, message_id, channel, payload, status, next_attempt_at)
     values ($1, $2, null, 'whatsapp', $3::jsonb, 'pending', now())`,
    [outboxId, params.clinicId, JSON.stringify(payload)],
  );

  await client.query(
    `insert into audit_log (id, clinic_id, actor, action, entity, entity_id, after, at)
     values ($1, $2, 'system', 'staff_notification.queued', 'outbox', $3, $4::jsonb, now())`,
    [
      newId("auditLog"),
      params.clinicId,
      outboxId,
      // Template name and caller context only — never the parameters, which
      // carry names and times (hard rule 4).
      JSON.stringify({ template: params.template.templateName, ...(params.audit ?? {}) }),
    ],
  );

  return { outboxId };
}

// ── The 24-hour window rule ──────────────────────────────────────────────────

export type DeliveryChoice =
  /** Send exactly what was queued. */
  | { kind: "as_is"; message: OutboundMessage }
  /** Window closed: send the approved template instead. */
  | { kind: "template"; message: OutboundTemplate; reason: "window_closed" }
  /** Window closed and nothing approved to send. Cannot be delivered. */
  | { kind: "blocked"; reason: "window_closed_no_template" };

/**
 * Decide what may actually go out, given the window.
 *
 * COMPLIANCE.md §3: "24-hour customer service window: free-form only inside;
 * outside use approved templates". This is enforced here rather than
 * discovered from Meta error 131047, because a rejected send still costs a
 * round trip and, at scale, quality rating.
 *
 * Pure, so the rule is testable without Postgres, Redis or Meta.
 */
export function chooseDelivery(
  payload: OutboxPayload,
  sessionExpiresAt: Date | null | undefined,
  now: Date,
): DeliveryChoice {
  // A template is always allowed: that is the entire point of templates.
  if (payload.message.kind === "template") {
    return { kind: "as_is", message: payload.message };
  }

  const open = sessionExpiresAt !== null && sessionExpiresAt !== undefined && now < sessionExpiresAt;
  if (open) return { kind: "as_is", message: payload.message };

  const fallback = payload.fallbackTemplate;
  if (!fallback) return { kind: "blocked", reason: "window_closed_no_template" };

  return {
    kind: "template",
    reason: "window_closed",
    message: { ...fallback, kind: "template", to: payload.message.to },
  };
}

// ── Delivery ─────────────────────────────────────────────────────────────────

export interface DeliverDeps {
  withTenant: WithTenant;
  channelFactory?: ChannelFactory;
  now?: () => Date;
}

export interface DeliverParams {
  clinicId: PrefixedId<"clinic">;
  outboxId: string;
  /** BullMQ's `job.attemptsMade`, zero-based. Decides dead-lettering. */
  attempt: number;
}

export type DeliverOutcome =
  | { status: "sent"; externalMessageId: string; usedTemplate: boolean }
  /** Row was already sent or in flight. Idempotency, not an error. */
  | { status: "skipped"; reason: "not_pending" | "missing" }
  /** Will be retried by BullMQ. */
  | { status: "retry"; reason: string }
  /** Terminal: dead-lettered for the inbox to surface. */
  | { status: "dead"; reason: string };

interface OutboxRow {
  id: string;
  message_id: string | null;
  payload: OutboxPayload;
  attempts: number;
}

/** Exponential backoff mirroring BullMQ's, for `next_attempt_at`. */
function nextAttemptAt(now: Date, attempts: number): Date {
  return new Date(now.getTime() + 2_000 * 2 ** Math.max(attempts - 1, 0));
}

/**
 * Deliver one outbox row.
 *
 * The claim is a guarded state transition — `pending` → `sending` in a single
 * `update … where status = 'pending' returning id`. Two workers racing the
 * same row, or a BullMQ job delivered twice, cannot both win it, so a patient
 * never receives the same message twice.
 */
export async function deliverOutbox(
  params: DeliverParams,
  deps: DeliverDeps,
): Promise<DeliverOutcome> {
  const now = deps.now ?? ((): Date => new Date());
  const factory = deps.channelFactory ?? defaultChannelFactory;

  const claimed = await deps.withTenant(params.clinicId, async (client) => {
    const claim = await row<OutboxRow>(
      client,
      `update outbox
         set status = 'sending', attempts = attempts + 1, updated_at = now()
       where id = $1 and clinic_id = $2 and status in ('pending', 'failed')
       returning id, message_id, payload, attempts`,
      [params.outboxId, params.clinicId],
    );
    if (!claim) return undefined;

    // Read the window inside the same transaction that claimed the row.
    const conversation = await row<{ session_expires_at: string | null }>(
      client,
      `select c.session_expires_at
       from message m join conversation c on c.id = m.conversation_id
       where m.id = $1`,
      [claim.message_id],
    );

    const sender = await loadSender(client, params.clinicId);
    return { claim, conversation, sender };
  });

  if (!claimed) {
    // Either the row is gone or someone else owns it. Both are fine.
    return { status: "skipped", reason: "not_pending" };
  }

  const { claim, conversation, sender } = claimed;
  const expiresAt = conversation?.session_expires_at
    ? new Date(conversation.session_expires_at)
    : null;

  const choice = chooseDelivery(claim.payload, expiresAt, now());

  if (choice.kind === "blocked") {
    // Retrying cannot help: the window will not reopen until the patient
    // writes to us, and there is no approved template to reach them with.
    await finalise(deps, params, claim, "dead", choice.reason);
    return { status: "dead", reason: choice.reason };
  }

  let channel: Channel;
  try {
    channel = factory(requireSender(sender));
  } catch (error) {
    const reason = AppError.is(error) ? error.code : "no_sender";
    await finalise(deps, params, claim, "dead", reason);
    return { status: "dead", reason };
  }

  try {
    const result = await channel.send(choice.message);
    await deps.withTenant(params.clinicId, async (client) => {
      await client.query(
        `update outbox set status = 'sent', last_error = null, next_attempt_at = null, updated_at = now()
         where id = $1`,
        [claim.id],
      );
      if (claim.message_id) {
        await client.query(
          `update message
             set status = 'sent',
                 wa_message_id = $2,
                 kind = $3,
                 template_name = coalesce($4, template_name),
                 updated_at = now()
           where id = $1`,
          [
            claim.message_id,
            result.externalMessageId,
            choice.message.kind === "template" ? "template" : claim.payload.message.kind,
            choice.message.kind === "template" ? choice.message.templateName : null,
          ],
        );
      }
    });

    return {
      status: "sent",
      externalMessageId: result.externalMessageId,
      usedTemplate: choice.kind === "template",
    };
  } catch (error) {
    const wa = isWhatsAppError(error) ? error : undefined;
    const reason = wa?.kind ?? "send_failed";

    /**
     * 131047 means the window closed between our check and Meta's — a genuine
     * race, not a bug. There is nothing to retry as-is, and we have already
     * established there is no fallback template (or we would have used one).
     */
    const terminal =
      wa !== undefined
        ? !wa.retryable
        : // A validation failure in the payload builder is our bug and will
          // fail identically on every attempt.
          AppError.is(error) && error.code === "VALIDATION_FAILED";

    const attemptsUsed = claim.attempts;
    const exhausted = attemptsUsed >= MAX_ATTEMPTS;

    if (terminal || exhausted) {
      await finalise(deps, params, claim, "dead", reason);
      return { status: "dead", reason };
    }

    await finalise(deps, params, claim, "failed", reason);
    // Rethrow so BullMQ counts the attempt and applies its backoff. The row is
    // back in `failed`, which the claim above accepts.
    throw error;
  }
}

/** Record the outcome on the row (and the message, when terminal). */
async function finalise(
  deps: DeliverDeps,
  params: DeliverParams,
  claim: OutboxRow,
  status: "failed" | "dead",
  reason: string,
): Promise<void> {
  const now = (deps.now ?? ((): Date => new Date()))();
  await deps.withTenant(params.clinicId, async (client) => {
    await client.query(
      `update outbox
         set status = $2, last_error = $3, next_attempt_at = $4, updated_at = now()
       where id = $1`,
      [claim.id, status, reason, status === "failed" ? nextAttemptAt(now, claim.attempts) : null],
    );

    if (status === "dead") {
      // A staff notification has no `message` row (`enqueueStaffNotification`),
      // so the update is conditional but the audit is not: a dead letter is the
      // thing an on-call human has to see either way (ARCHITECTURE.md §11:
      // "dead-letter to inbox alert").
      if (claim.message_id) {
        await client.query(
          `update message set status = 'failed', updated_at = now() where id = $1`,
          [claim.message_id],
        );
      }
      await client.query(
        `insert into audit_log (id, clinic_id, actor, action, entity, entity_id, after, at)
         values ($1, $2, 'system', 'outbox.dead_letter', 'outbox', $3, $4::jsonb, now())`,
        [
          newId("auditLog"),
          params.clinicId,
          claim.id,
          JSON.stringify({ reason, attempts: claim.attempts, message_id: claim.message_id }),
        ],
      );
    }
  });
}
