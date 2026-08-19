import type { E164 } from "@sema/shared";

/**
 * The `Channel` interface (ARCHITECTURE.md §6).
 *
 * WhatsApp is the only implementation in v1. SMS and voice are explicitly out
 * of scope ("interface only", CLAUDE.md §Out of scope) — the point of this
 * abstraction is that adding them later does not touch the engine, the outbox
 * or the inbox, only a new adapter directory next to `whatsapp/`.
 *
 * Nothing in here knows about Postgres, queues or clinics. An adapter is a
 * stateless thing that turns a Sema message into an HTTP call and back.
 */

/** The vendor's id for a message we sent — WhatsApp's `wamid.…`. */
export interface SendResult {
  externalMessageId: string;
}

interface OutboundBase {
  to: E164;
}

export interface OutboundText extends OutboundBase {
  kind: "text";
  body: string;
  /** Let the channel render a link preview. Off by default: quieter, cheaper. */
  previewUrl?: boolean;
}

/** One tappable choice. `id` comes back on the inbound interactive reply. */
export interface InteractiveOption {
  id: string;
  title: string;
  /** List rows only; ignored for buttons. */
  description?: string;
}

/**
 * A question with choices. The adapter picks the wire format: WhatsApp reply
 * buttons for up to three options, a list message beyond that (INTEGRATIONS.md
 * §1 "Interactive buttons (≤3) for slot picks / yes-no; list messages for > 3
 * options").
 */
export interface OutboundInteractive extends OutboundBase {
  kind: "interactive";
  body: string;
  options: InteractiveOption[];
  header?: string;
  footer?: string;
  /** Label on the button that opens a list. Ignored when buttons are used. */
  listButtonText?: string;
  /** Section heading inside a list. Ignored when buttons are used. */
  listSectionTitle?: string;
}

/** A template parameter. Positional — WhatsApp templates use `{{1}}`, `{{2}}`. */
export type TemplateParameter = string;

export interface OutboundTemplate extends OutboundBase {
  kind: "template";
  /** The approved template name, e.g. `appt_reminder_24h`. */
  templateName: string;
  /** BCP-47-ish Meta language code, e.g. `en`, `sw`. */
  language: string;
  bodyParameters?: TemplateParameter[];
  headerParameters?: TemplateParameter[];
  /** Positional parameters for URL buttons, by button index. */
  buttonParameters?: { index: number; parameters: TemplateParameter[] }[];
}

export interface OutboundLocation extends OutboundBase {
  kind: "location";
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

export type OutboundMessage =
  | OutboundText
  | OutboundInteractive
  | OutboundTemplate
  | OutboundLocation;

/** Media pulled down from the vendor, on its way to object storage. */
export interface DownloadedMedia {
  mediaId: string;
  mime: string;
  bytes: Uint8Array;
  sha256?: string;
  /** Vendor-reported size, when it gave one. */
  fileSize?: number;
}

export interface Channel {
  /** Stable name, stored on `outbox.channel`. */
  readonly name: "whatsapp";

  sendText(message: OutboundText): Promise<SendResult>;
  sendInteractive(message: OutboundInteractive): Promise<SendResult>;
  sendTemplate(message: OutboundTemplate): Promise<SendResult>;
  sendLocation(message: OutboundLocation): Promise<SendResult>;

  /** Dispatch on `kind`. Convenience for the outbox, which is generic. */
  send(message: OutboundMessage): Promise<SendResult>;

  downloadMedia(mediaId: string): Promise<DownloadedMedia>;

  /** Blue ticks. Best effort: a failure here must never fail the inbound job. */
  markRead(externalMessageId: string): Promise<void>;
}
