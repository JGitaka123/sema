import { z } from "zod";

/**
 * Parsing Meta's inbound webhook envelope.
 *
 * The shape is `entry[].changes[].value.{messages,statuses,contacts}` with a
 * `metadata.phone_number_id` naming the clinic's sender. Meta adds fields
 * without warning, so every object here is permissive about *extra* keys and
 * strict about the handful we act on.
 *
 * The output is a flat list of events the rest of Sema understands. Nothing in
 * this file touches a database, a queue or a clock — it is a pure function
 * from JSON to events, which is what makes the fixture tests in
 * `fixtures/whatsapp/` worth having (docs/TESTING.md layer 3).
 */

const Text = z.object({ body: z.string() }).passthrough();

const Media = z
  .object({
    id: z.string(),
    mime_type: z.string().optional(),
    sha256: z.string().optional(),
    caption: z.string().optional(),
    voice: z.boolean().optional(),
    filename: z.string().optional(),
  })
  .passthrough();

const InteractiveReply = z
  .object({
    type: z.string(),
    button_reply: z.object({ id: z.string(), title: z.string() }).partial().optional(),
    list_reply: z
      .object({ id: z.string(), title: z.string(), description: z.string().optional() })
      .partial()
      .optional(),
  })
  .passthrough();

const InboundMessage = z
  .object({
    id: z.string(),
    from: z.string(),
    timestamp: z.string(),
    type: z.string(),
    text: Text.optional(),
    audio: Media.optional(),
    image: Media.optional(),
    video: Media.optional(),
    document: Media.optional(),
    sticker: Media.optional(),
    location: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        name: z.string().optional(),
        address: z.string().optional(),
      })
      .passthrough()
      .optional(),
    interactive: InteractiveReply.optional(),
    button: z.object({ payload: z.string(), text: z.string() }).partial().optional(),
    context: z.object({ id: z.string().optional() }).passthrough().optional(),
    errors: z.array(z.object({ code: z.number().optional() }).passthrough()).optional(),
  })
  .passthrough();

const StatusUpdate = z
  .object({
    id: z.string(),
    status: z.string(),
    timestamp: z.string(),
    recipient_id: z.string().optional(),
    conversation: z
      .object({ id: z.string().optional(), origin: z.object({}).passthrough().optional() })
      .passthrough()
      .optional(),
    pricing: z.object({}).passthrough().optional(),
    errors: z
      .array(
        z
          .object({ code: z.number().optional(), title: z.string().optional() })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const ChangeValue = z
  .object({
    messaging_product: z.string().optional(),
    metadata: z
      .object({
        display_phone_number: z.string().optional(),
        phone_number_id: z.string(),
      })
      .passthrough()
      .optional(),
    contacts: z
      .array(
        z
          .object({
            wa_id: z.string().optional(),
            profile: z.object({ name: z.string().optional() }).passthrough().optional(),
          })
          .passthrough(),
      )
      .optional(),
    messages: z.array(InboundMessage).optional(),
    statuses: z.array(StatusUpdate).optional(),
  })
  .passthrough();

const Change = z
  .object({ field: z.string().optional(), value: ChangeValue })
  .passthrough();

const Entry = z
  .object({ id: z.string().optional(), changes: z.array(Change).optional() })
  .passthrough();

/**
 * Deliberately not exported.
 *
 * The inferred type of this schema is enormous — deep, and `.passthrough()` at
 * every level — and exporting it makes `tsc` give up on serialising a
 * declaration for it (TS7056). Nothing outside this module needs it: the
 * exported surface is `parseWebhook` and the flat event types below, which is
 * the better contract anyway.
 */
const WhatsAppWebhookBody = z
  .object({ object: z.string().optional(), entry: z.array(Entry).optional() })
  .passthrough();

/** Our normalised message kinds, matching the `message_kind` DB enum. */
export type InboundKind =
  | "text"
  | "audio"
  | "image"
  | "document"
  | "location"
  | "interactive"
  | "system";

export interface InboundMediaRef {
  mediaId: string;
  mime?: string;
  sha256?: string;
  filename?: string;
  /** True for a WhatsApp voice note as opposed to an uploaded audio file. */
  voice?: boolean;
}

/** One patient message, flattened and paired with the sender that received it. */
export interface InboundMessageEvent {
  type: "message";
  /** Meta's sender id — resolves to a clinic. */
  phoneNumberId: string;
  /** `wamid.…`, the dedup key. */
  waMessageId: string;
  /** Sender's wa_id: E.164 without the "+". Normalise before storing. */
  fromWaId: string;
  /** WhatsApp profile name, when Meta included the contact. PHI — do not log. */
  profileName?: string;
  /** Meta's unix seconds, as a Date. Their clock, not ours. */
  sentAt: Date;
  kind: InboundKind;
  /** Text body, media caption, or the title of the option the patient tapped. */
  body?: string;
  /** The `id` of a tapped button or list row — what the engine routes on. */
  replyId?: string;
  media?: InboundMediaRef;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  /** `wamid` of the message this one replies to, if any. */
  contextWaMessageId?: string;
  /** Meta's raw `type`, kept for kinds we deliberately map to `system`. */
  rawType: string;
}

export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";

/** A delivery receipt for a message *we* sent. */
export interface StatusEvent {
  type: "status";
  phoneNumberId: string;
  /** The `wamid` we stored on `message.wa_message_id` when Meta acked the send. */
  waMessageId: string;
  status: DeliveryStatus;
  at: Date;
  /** Meta error code on a failure, e.g. 131026 undeliverable. */
  errorCode?: number;
}

export type WebhookEvent = InboundMessageEvent | StatusEvent;

export interface ParsedWebhook {
  events: WebhookEvent[];
  /** Entries we understood the envelope of but chose not to act on. */
  ignored: number;
}

/** Meta sends unix *seconds*, as a string. */
function toDate(timestamp: string): Date {
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date();
}

const MEDIA_KINDS = ["audio", "image", "document", "video", "sticker"] as const;
type MediaKind = (typeof MEDIA_KINDS)[number];

/** Video and stickers land on `document` / `image`: the DB enum has no slot. */
const KIND_BY_MEDIA: Record<MediaKind, InboundKind> = {
  audio: "audio",
  image: "image",
  document: "document",
  video: "document",
  sticker: "image",
};

const STATUSES: ReadonlySet<string> = new Set(["sent", "delivered", "read", "failed"]);

function normaliseMessage(
  raw: z.infer<typeof InboundMessage>,
  phoneNumberId: string,
  profileName: string | undefined,
): InboundMessageEvent {
  const base = {
    type: "message" as const,
    phoneNumberId,
    waMessageId: raw.id,
    fromWaId: raw.from,
    sentAt: toDate(raw.timestamp),
    rawType: raw.type,
    ...(profileName === undefined ? {} : { profileName }),
    ...(raw.context?.id === undefined ? {} : { contextWaMessageId: raw.context.id }),
  };

  if (raw.type === "text" && raw.text) {
    return { ...base, kind: "text", body: raw.text.body };
  }

  if (raw.type === "location" && raw.location) {
    const { latitude, longitude, name, address } = raw.location;
    return {
      ...base,
      kind: "location",
      location: {
        latitude,
        longitude,
        ...(name === undefined ? {} : { name }),
        ...(address === undefined ? {} : { address }),
      },
    };
  }

  if (raw.type === "interactive" && raw.interactive) {
    const reply = raw.interactive.button_reply ?? raw.interactive.list_reply;
    return {
      ...base,
      kind: "interactive",
      ...(reply?.title === undefined ? {} : { body: reply.title }),
      ...(reply?.id === undefined ? {} : { replyId: reply.id }),
    };
  }

  // A template quick-reply button. Meta reports it as its own type, but for us
  // it is the same thing as tapping a reply button.
  if (raw.type === "button" && raw.button) {
    return {
      ...base,
      kind: "interactive",
      ...(raw.button.text === undefined ? {} : { body: raw.button.text }),
      ...(raw.button.payload === undefined ? {} : { replyId: raw.button.payload }),
    };
  }

  for (const mediaKind of MEDIA_KINDS) {
    const media = raw[mediaKind];
    if (raw.type === mediaKind && media) {
      return {
        ...base,
        kind: KIND_BY_MEDIA[mediaKind],
        ...(media.caption === undefined ? {} : { body: media.caption }),
        media: {
          mediaId: media.id,
          ...(media.mime_type === undefined ? {} : { mime: media.mime_type }),
          ...(media.sha256 === undefined ? {} : { sha256: media.sha256 }),
          ...(media.filename === undefined ? {} : { filename: media.filename }),
          ...(media.voice === undefined ? {} : { voice: media.voice }),
        },
      };
    }
  }

  // Unsupported (contacts, order, reaction, unknown) or an errored message.
  // We still record it, so staff see that the patient sent *something* and the
  // conversation is not silently one-sided.
  return { ...base, kind: "system" };
}

/**
 * Flatten a verified webhook body into events.
 *
 * Never throws on a payload that parses as JSON: a change we do not recognise
 * is counted in `ignored`, not raised. Meta retries anything that is not a
 * 200, so throwing on an unknown field would put us in a redelivery loop over
 * a field we do not even use.
 */
export function parseWebhook(body: unknown): ParsedWebhook {
  const parsed = WhatsAppWebhookBody.safeParse(body);
  if (!parsed.success) return { events: [], ignored: 1 };

  const events: WebhookEvent[] = [];
  let ignored = 0;

  for (const entry of parsed.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const phoneNumberId = value.metadata?.phone_number_id;

      // Without a sender id we cannot route to a clinic, so there is nothing
      // useful to do — this is how `account_update` and
      // `message_template_status_update` changes land here in Phase 3.
      if (!phoneNumberId) {
        ignored += 1;
        continue;
      }

      // Meta sends one contact per message batch, in order; in practice a
      // change carries one patient. Take the first name and only use it when
      // the batch has a single contact, to avoid attributing the wrong one.
      const profileName =
        value.contacts?.length === 1 ? value.contacts[0]?.profile?.name : undefined;

      for (const message of value.messages ?? []) {
        events.push(normaliseMessage(message, phoneNumberId, profileName));
      }

      for (const status of value.statuses ?? []) {
        if (!STATUSES.has(status.status)) {
          ignored += 1;
          continue;
        }
        const errorCode = status.errors?.[0]?.code;
        events.push({
          type: "status",
          phoneNumberId,
          waMessageId: status.id,
          status: status.status as DeliveryStatus,
          at: toDate(status.timestamp),
          ...(errorCode === undefined ? {} : { errorCode }),
        });
      }

      if (!value.messages?.length && !value.statuses?.length) ignored += 1;
    }
  }

  return { events, ignored };
}

/**
 * The ids to dedup on, in payload order.
 *
 * Messages dedup on their own `wamid`. Statuses do not: the same message
 * legitimately produces `sent`, `delivered` and `read`, so the id is qualified
 * by the status — otherwise `delivered` would swallow `read`.
 */
export function dedupKeys(events: readonly WebhookEvent[]): string[] {
  return events.map((event) =>
    event.type === "message" ? event.waMessageId : `${event.waMessageId}:${event.status}`,
  );
}
