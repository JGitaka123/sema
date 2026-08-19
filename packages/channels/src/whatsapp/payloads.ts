import { AppError, toWaId } from "@sema/shared";

import type {
  InteractiveOption,
  OutboundInteractive,
  OutboundLocation,
  OutboundMessage,
  OutboundTemplate,
  OutboundText,
} from "../types.js";

/**
 * Pure payload builders for the WhatsApp Cloud API.
 *
 * Nothing here does I/O; every function is `input → JSON`. That is the whole
 * point: the wire format is the part that is fiddly, versioned by Meta and
 * easy to get subtly wrong, so it is the part that gets exhaustive unit tests
 * with no network (docs/TESTING.md layer 1).
 *
 * Meta's limits are enforced here rather than discovered at send time — a
 * rejected send inside the 24-hour window can cost us the window.
 */

/** Meta limits, as of Graph v20. Keep the numbers next to what enforces them. */
export const WHATSAPP_LIMITS = {
  /** Body text of a plain message. */
  textBody: 4096,
  /** Reply buttons per interactive message; more than this must become a list. */
  maxButtons: 3,
  /** Rows across all sections of a list message. */
  maxListRows: 10,
  buttonTitle: 20,
  listRowTitle: 24,
  listRowDescription: 72,
  listButtonText: 20,
  interactiveBody: 1024,
  interactiveHeader: 60,
  interactiveFooter: 60,
  optionId: 256,
} as const;

const MESSAGING_PRODUCT = "whatsapp" as const;

function invalid(message: string, field: string): AppError {
  // No values in the message or meta: an over-long body is still a message
  // body, and a recipient is still a phone number (hard rule 4).
  return new AppError("VALIDATION_FAILED", message, { expose: false, meta: { field } });
}

function requireText(value: string, max: number, field: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw invalid(`${field} cannot be empty.`, field);
  if (trimmed.length > max) throw invalid(`${field} exceeds the WhatsApp limit.`, field);
  return trimmed;
}

/**
 * The `to` field. Meta wants E.164 *without* the leading "+" — it accepts
 * both, but its own webhooks use the bare form, and matching them keeps
 * fixtures and logs consistent.
 */
function recipient(to: string): string {
  if (!to.startsWith("+")) throw invalid("Recipient must be E.164.", "to");
  return toWaId(to as `+${string}`);
}

export interface TextPayload {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "text";
  text: { body: string; preview_url: boolean };
}

export function buildTextPayload(message: OutboundText): TextPayload {
  return {
    messaging_product: MESSAGING_PRODUCT,
    recipient_type: "individual",
    to: recipient(message.to),
    type: "text",
    text: {
      body: requireText(message.body, WHATSAPP_LIMITS.textBody, "body"),
      preview_url: message.previewUrl ?? false,
    },
  };
}

function optionId(option: InteractiveOption): string {
  const id = option.id.trim();
  if (id === "") throw invalid("Option id cannot be empty.", "options.id");
  if (id.length > WHATSAPP_LIMITS.optionId) {
    throw invalid("Option id exceeds the WhatsApp limit.", "options.id");
  }
  return id;
}

function assertUniqueOptionIds(options: readonly InteractiveOption[]): void {
  const ids = options.map((o) => o.id.trim());
  if (new Set(ids).size !== ids.length) {
    // Duplicate ids make the patient's reply ambiguous — which slot did they
    // pick? Fail here rather than book the wrong one.
    throw invalid("Interactive options must have unique ids.", "options.id");
  }
}

export interface ButtonsPayload {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "interactive";
  interactive: {
    type: "button";
    header?: { type: "text"; text: string };
    body: { text: string };
    footer?: { text: string };
    action: { buttons: { type: "reply"; reply: { id: string; title: string } }[] };
  };
}

export interface ListPayload {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "interactive";
  interactive: {
    type: "list";
    header?: { type: "text"; text: string };
    body: { text: string };
    footer?: { text: string };
    action: {
      button: string;
      sections: {
        title: string;
        rows: { id: string; title: string; description?: string }[];
      }[];
    };
  };
}

export type InteractivePayload = ButtonsPayload | ListPayload;

/**
 * Buttons or list, decided by option count (INTEGRATIONS.md §1).
 *
 * The caller never chooses: "three slots" and "seven slots" are the same
 * intent, and letting the engine pick the wire format would put a Meta detail
 * in a prompt.
 */
export function buildInteractivePayload(message: OutboundInteractive): InteractivePayload {
  const { options } = message;
  if (options.length === 0) throw invalid("Interactive messages need options.", "options");
  if (options.length > WHATSAPP_LIMITS.maxListRows) {
    throw invalid("Too many options for one WhatsApp message.", "options");
  }
  assertUniqueOptionIds(options);

  const to = recipient(message.to);
  const body = { text: requireText(message.body, WHATSAPP_LIMITS.interactiveBody, "body") };
  const header =
    message.header === undefined
      ? undefined
      : ({
          type: "text",
          text: requireText(message.header, WHATSAPP_LIMITS.interactiveHeader, "header"),
        } as const);
  const footer =
    message.footer === undefined
      ? undefined
      : { text: requireText(message.footer, WHATSAPP_LIMITS.interactiveFooter, "footer") };

  if (options.length <= WHATSAPP_LIMITS.maxButtons) {
    return {
      messaging_product: MESSAGING_PRODUCT,
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        ...(header ? { header } : {}),
        body,
        ...(footer ? { footer } : {}),
        action: {
          buttons: options.map((option) => ({
            type: "reply" as const,
            reply: {
              id: optionId(option),
              title: requireText(option.title, WHATSAPP_LIMITS.buttonTitle, "options.title"),
            },
          })),
        },
      },
    };
  }

  return {
    messaging_product: MESSAGING_PRODUCT,
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      ...(header ? { header } : {}),
      body,
      ...(footer ? { footer } : {}),
      action: {
        button: requireText(
          message.listButtonText ?? "Choose",
          WHATSAPP_LIMITS.listButtonText,
          "listButtonText",
        ),
        sections: [
          {
            title: requireText(
              message.listSectionTitle ?? "Options",
              WHATSAPP_LIMITS.listRowTitle,
              "listSectionTitle",
            ),
            rows: options.map((option) => ({
              id: optionId(option),
              title: requireText(option.title, WHATSAPP_LIMITS.listRowTitle, "options.title"),
              ...(option.description === undefined
                ? {}
                : {
                    description: requireText(
                      option.description,
                      WHATSAPP_LIMITS.listRowDescription,
                      "options.description",
                    ),
                  }),
            })),
          },
        ],
      },
    },
  };
}

interface TemplateComponent {
  type: "header" | "body" | "button";
  sub_type?: "url" | "quick_reply";
  index?: string;
  parameters: { type: "text"; text: string }[];
}

export interface TemplatePayload {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "template";
  template: {
    name: string;
    language: { code: string };
    components?: TemplateComponent[];
  };
}

function textParameters(values: readonly string[], field: string): { type: "text"; text: string }[] {
  return values.map((value) => {
    const text = value.trim();
    // Meta rejects a parameter containing a newline or four consecutive
    // spaces, with an unhelpful error. Catch it where the cause is visible.
    if (text === "") throw invalid("Template parameters cannot be empty.", field);
    if (/\n|\t| {4}/.test(text)) {
      throw invalid("Template parameters cannot contain newlines, tabs or runs of spaces.", field);
    }
    return { type: "text" as const, text };
  });
}

/**
 * A template send — the only thing allowed outside the 24-hour window
 * (COMPLIANCE.md §3). The outbox decides *whether* to use one; this only
 * builds it.
 */
export function buildTemplatePayload(message: OutboundTemplate): TemplatePayload {
  const name = message.templateName.trim();
  if (!/^[a-z0-9_]{1,512}$/.test(name)) {
    // Meta's own rule for template names; a mismatch here is a bug in our
    // template registry, not something a patient can cause.
    throw invalid("Template names are lowercase letters, digits and underscores.", "templateName");
  }
  const language = message.language.trim();
  if (language === "") throw invalid("Template language is required.", "language");

  const components: TemplateComponent[] = [];
  if (message.headerParameters?.length) {
    components.push({
      type: "header",
      parameters: textParameters(message.headerParameters, "headerParameters"),
    });
  }
  if (message.bodyParameters?.length) {
    components.push({
      type: "body",
      parameters: textParameters(message.bodyParameters, "bodyParameters"),
    });
  }
  for (const button of message.buttonParameters ?? []) {
    components.push({
      type: "button",
      sub_type: "url",
      index: String(button.index),
      parameters: textParameters(button.parameters, "buttonParameters"),
    });
  }

  return {
    messaging_product: MESSAGING_PRODUCT,
    recipient_type: "individual",
    to: recipient(message.to),
    type: "template",
    template: {
      name,
      language: { code: language },
      ...(components.length > 0 ? { components } : {}),
    },
  };
}

export interface LocationPayload {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "location";
  location: { latitude: number; longitude: number; name?: string; address?: string };
}

export function buildLocationPayload(message: OutboundLocation): LocationPayload {
  const { latitude, longitude } = message;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw invalid("Latitude is out of range.", "latitude");
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw invalid("Longitude is out of range.", "longitude");
  }

  return {
    messaging_product: MESSAGING_PRODUCT,
    recipient_type: "individual",
    to: recipient(message.to),
    type: "location",
    location: {
      latitude,
      longitude,
      ...(message.name === undefined ? {} : { name: message.name.trim() }),
      ...(message.address === undefined ? {} : { address: message.address.trim() }),
    },
  };
}

export interface MarkReadPayload {
  messaging_product: "whatsapp";
  status: "read";
  message_id: string;
}

export function buildMarkReadPayload(externalMessageId: string): MarkReadPayload {
  const id = externalMessageId.trim();
  if (id === "") throw invalid("A message id is required to mark as read.", "messageId");
  return { messaging_product: MESSAGING_PRODUCT, status: "read", message_id: id };
}

/** Build whatever payload `message.kind` calls for. Used by the adapter. */
export function buildPayload(message: OutboundMessage): Record<string, unknown> {
  switch (message.kind) {
    case "text":
      return buildTextPayload(message) as unknown as Record<string, unknown>;
    case "interactive":
      return buildInteractivePayload(message) as unknown as Record<string, unknown>;
    case "template":
      return buildTemplatePayload(message) as unknown as Record<string, unknown>;
    case "location":
      return buildLocationPayload(message) as unknown as Record<string, unknown>;
  }
}
