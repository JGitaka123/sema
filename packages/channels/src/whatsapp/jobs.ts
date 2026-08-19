import { z } from "zod";

import type { InboundMessageEvent, StatusEvent, WebhookEvent } from "./webhook.js";

/**
 * What actually travels on the queue between `apps/api` and `apps/worker`.
 *
 * A job payload is JSON in Redis, so `Date` does not survive the trip — it
 * arrives as a string and every `.getTime()` downstream explodes. Timestamps
 * are therefore ISO strings on the wire and are re-hydrated on the way out,
 * once, here.
 *
 * The Zod schemas are not ceremony: a job can sit in Redis across a deploy, so
 * the consumer may be a different version of the code from the producer. A
 * payload that no longer parses should fail as a validation error on one job,
 * not as a `TypeError` that kills the worker.
 *
 * The payload deliberately carries no `clinic_id`: the webhook has not
 * resolved one yet (hard rule 6 — it does no lookups beyond dedup), and the
 * worker resolves it from `phoneNumberId`. ARCHITECTURE.md §2 sketches
 * `{clinic_id, wa_message_id, raw}`; step 2 of the same section then has the
 * worker resolve the clinic, which is the ordering we follow.
 */

const IsoDate = z.string().datetime();

export const InboundJobData = z.object({
  phoneNumberId: z.string().min(1),
  waMessageId: z.string().min(1),
  fromWaId: z.string().min(1),
  /** WhatsApp profile name. PHI — never logged (hard rule 4). */
  profileName: z.string().optional(),
  sentAt: IsoDate,
  kind: z.enum(["text", "audio", "image", "document", "location", "interactive", "system"]),
  /** Message body or caption. PHI. */
  body: z.string().optional(),
  replyId: z.string().optional(),
  media: z
    .object({
      mediaId: z.string(),
      mime: z.string().optional(),
      sha256: z.string().optional(),
      filename: z.string().optional(),
      voice: z.boolean().optional(),
    })
    .optional(),
  location: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      name: z.string().optional(),
      address: z.string().optional(),
    })
    .optional(),
  contextWaMessageId: z.string().optional(),
  rawType: z.string(),
});

export type InboundJobData = z.infer<typeof InboundJobData>;

export const StatusJobData = z.object({
  phoneNumberId: z.string().min(1),
  waMessageId: z.string().min(1),
  status: z.enum(["sent", "delivered", "read", "failed"]),
  at: IsoDate,
  errorCode: z.number().optional(),
});

export type StatusJobData = z.infer<typeof StatusJobData>;

/** Strip undefined keys so the JSON in Redis stays small and stable. */
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function toInboundJobData(event: InboundMessageEvent): InboundJobData {
  return compact({
    phoneNumberId: event.phoneNumberId,
    waMessageId: event.waMessageId,
    fromWaId: event.fromWaId,
    profileName: event.profileName,
    sentAt: event.sentAt.toISOString(),
    kind: event.kind,
    body: event.body,
    replyId: event.replyId,
    media: event.media,
    location: event.location,
    contextWaMessageId: event.contextWaMessageId,
    rawType: event.rawType,
  });
}

export function toStatusJobData(event: StatusEvent): StatusJobData {
  return compact({
    phoneNumberId: event.phoneNumberId,
    waMessageId: event.waMessageId,
    status: event.status,
    at: event.at.toISOString(),
    errorCode: event.errorCode,
  });
}

export function toJobData(event: WebhookEvent): InboundJobData | StatusJobData {
  return event.type === "message" ? toInboundJobData(event) : toStatusJobData(event);
}
