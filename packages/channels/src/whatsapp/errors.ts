import { AppError } from "@sema/shared";

/**
 * Meta Graph API error handling (INTEGRATIONS.md §1 "Errors").
 *
 * The outbox needs three decisions out of a failed send, and nothing else:
 *   - can I fix this by sending a template instead?  → `needs_template`
 *   - will retrying ever help?                        → `retryable`
 *   - is this number simply unreachable?              → `undeliverable`
 *
 * Everything below exists to answer those three from a Graph error body,
 * without leaking a token, a phone number or a message body into a log line.
 */

export type WhatsAppFailureKind =
  /** 131047: no customer service window open. Re-engage with a template. */
  | "needs_template"
  /** 131026: the number cannot receive this message. Stop trying. */
  | "undeliverable"
  /** 130429 and friends: slow down and come back. */
  | "rate_limited"
  /** Our fault: a malformed payload, an unapproved template, bad parameters. */
  | "invalid_request"
  /** Token expired or revoked. Retrying does not help until onboarding re-runs. */
  | "auth"
  /** Meta is having a bad day, or the socket died. Retry. */
  | "transient"
  | "unknown";

/** Meta error codes we make explicit decisions about. */
export const META_ERROR_CODES = {
  /** Re-engagement message: outside the 24-hour customer service window. */
  reEngagementRequired: 131047,
  /** Message undeliverable — recipient cannot receive, or is not on WhatsApp. */
  undeliverable: 131026,
  /** Rate limit hit. */
  rateLimit: 130429,
  /** Spam rate limit hit — same treatment as a rate limit, slower. */
  spamRateLimit: 131048,
  /** Per-recipient pair rate limit. */
  pairRateLimit: 131056,
  /** Access token expired / invalid. */
  authExpired: 190,
  /** Temporary Meta-side failure. */
  temporarilyUnavailable: 131000,
} as const;

const KIND_BY_CODE = new Map<number, WhatsAppFailureKind>([
  [META_ERROR_CODES.reEngagementRequired, "needs_template"],
  [META_ERROR_CODES.undeliverable, "undeliverable"],
  [META_ERROR_CODES.rateLimit, "rate_limited"],
  [META_ERROR_CODES.spamRateLimit, "rate_limited"],
  [META_ERROR_CODES.pairRateLimit, "rate_limited"],
  [META_ERROR_CODES.authExpired, "auth"],
  [META_ERROR_CODES.temporarilyUnavailable, "transient"],
]);

/** Kinds where another attempt has a real chance of succeeding as-is. */
const RETRYABLE: ReadonlySet<WhatsAppFailureKind> = new Set<WhatsAppFailureKind>([
  "rate_limited",
  "transient",
]);

export interface WhatsAppErrorDetails {
  /** Meta's numeric `error.code`. */
  code?: number;
  /** Meta's `error_subcode`, when present. */
  subcode?: number;
  /** HTTP status of the Graph response. */
  status?: number;
  /** Meta's opaque trace id — the only thing worth quoting in a support ticket. */
  traceId?: string;
}

/**
 * A failed WhatsApp operation, classified.
 *
 * Extends AppError so the API error handler and the worker treat it like any
 * other typed error. `CHANNEL_SEND_FAILED` never reaches a patient — the
 * outbox retries or dead-letters, and staff see it in the inbox.
 */
export class WhatsAppError extends AppError {
  readonly kind: WhatsAppFailureKind;
  readonly details: WhatsAppErrorDetails;

  constructor(kind: WhatsAppFailureKind, message: string, details: WhatsAppErrorDetails = {}) {
    super("CHANNEL_SEND_FAILED", message, {
      expose: false,
      // Meta codes, statuses and trace ids are not personal data. A phone
      // number or a message body would be, and neither is ever put here.
      meta: {
        kind,
        code: details.code ?? null,
        subcode: details.subcode ?? null,
        status: details.status ?? null,
        traceId: details.traceId ?? null,
      },
    });
    this.name = "WhatsAppError";
    this.kind = kind;
    this.details = details;
  }

  /** Should the outbox try this exact message again? */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }

  /** Should the outbox re-send this as an approved template instead? */
  get needsTemplate(): boolean {
    return this.kind === "needs_template";
  }
}

export function isWhatsAppError(value: unknown): value is WhatsAppError {
  return value instanceof WhatsAppError;
}

/** The shape Meta returns on an error. Everything is optional in practice. */
interface GraphErrorBody {
  error?: {
    message?: unknown;
    type?: unknown;
    code?: unknown;
    error_subcode?: unknown;
    fbtrace_id?: unknown;
    error_data?: { details?: unknown };
  };
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Classify from the HTTP status alone, when there is no usable body. */
export function kindFromStatus(status: number): WhatsAppFailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "transient";
  if (status >= 400) return "invalid_request";
  return "unknown";
}

/**
 * Turn a Graph error response into a `WhatsAppError`.
 *
 * `body` is the parsed JSON, or undefined when the response was not JSON at
 * all (an HTML 502 from a proxy, say). Meta's own `error.message` is *not*
 * used as the error message: it sometimes echoes the recipient number back.
 */
export function toWhatsAppError(
  status: number,
  body: unknown,
  operation: string,
): WhatsAppError {
  const parsed = (typeof body === "object" && body !== null ? body : {}) as GraphErrorBody;
  const error = parsed.error ?? {};

  const code = asNumber(error.code);
  const subcode = asNumber(error.error_subcode);
  const traceId = asString(error.fbtrace_id);

  const kind = (code !== undefined ? KIND_BY_CODE.get(code) : undefined) ?? kindFromStatus(status);

  // Deliberately generic and code-driven: Meta's prose can contain the
  // recipient's number (hard rule 4).
  return new WhatsAppError(kind, `WhatsApp ${operation} failed (${kind}).`, {
    code,
    subcode,
    status,
    traceId,
  });
}

/** Network-level failure: DNS, TLS, socket reset, timeout. Always retryable. */
export function toTransportError(operation: string, cause: unknown): WhatsAppError {
  const error = new WhatsAppError("transient", `WhatsApp ${operation} could not reach Meta.`, {});
  // Keep the cause for logs without letting it into `meta` or the message.
  Object.defineProperty(error, "cause", { value: cause, enumerable: false, writable: false });
  return error;
}
