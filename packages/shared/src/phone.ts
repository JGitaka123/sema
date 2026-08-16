import { AppError } from "./errors.js";

/**
 * Phone normalisation.
 *
 * CLAUDE.md: "E.164 in DB. Normalise on ingest (`+2547...`). Never log raw."
 *
 * Launch market is Kenya, so `KE` is the default region for local-format input
 * ("0712 345 678"). Fully-qualified `+<cc>...` input from any country is
 * accepted so the multi-region story in CLAUDE.md is not blocked. We do not
 * pull in libphonenumber for v1: the only local format we must parse is
 * Kenyan, and the bundle cost is not justified yet.
 */

export type E164 = `+${string}`;

/** Kenyan mobile subscriber numbers: 9 digits, starting 7 (legacy) or 1 (11x). */
const KE_COUNTRY_CODE = "254";
const KE_SUBSCRIBER_RE = /^[17]\d{8}$/;

/** Generic E.164: country code + subscriber, 8..15 digits total. */
const E164_RE = /^\+[1-9]\d{7,14}$/;

export interface NormalisePhoneOptions {
  /** Region used to interpret local formats. Only "KE" is supported in v1. */
  defaultCountry?: "KE";
}

/**
 * Strip spaces, dashes, dots and brackets — everything humans type. The explicit
 * \u00a0 covers the non-breaking space that phone keyboards and copy-paste out of
 * WhatsApp routinely insert.
 */
function stripFormatting(input: string): string {
  return input.replace(/[\s\u00a0\-().]/g, "");
}

/**
 * Normalise a phone number to E.164, or return undefined when it cannot be
 * confidently parsed. Never throws — use at parse boundaries where you want to
 * branch, and `normalisePhone` where an invalid number is a hard error.
 */
export function tryNormalisePhone(
  input: string | null | undefined,
  options: NormalisePhoneOptions = {},
): E164 | undefined {
  if (typeof input !== "string") return undefined;

  let value = stripFormatting(input.trim());
  if (value === "") return undefined;

  // "00" is the international access prefix used across East Africa.
  if (value.startsWith("00")) value = `+${value.slice(2)}`;

  const country = options.defaultCountry ?? "KE";

  // Already international.
  if (value.startsWith("+")) {
    if (!/^\+\d+$/.test(value)) return undefined;
    if (value.startsWith(`+${KE_COUNTRY_CODE}`)) {
      const subscriber = value.slice(1 + KE_COUNTRY_CODE.length);
      return KE_SUBSCRIBER_RE.test(subscriber)
        ? (`+${KE_COUNTRY_CODE}${subscriber}` as E164)
        : undefined;
    }
    return E164_RE.test(value) ? (value as E164) : undefined;
  }

  if (country !== "KE") return undefined;
  if (!/^\d+$/.test(value)) return undefined;

  // WhatsApp delivers the wa_id without a "+", e.g. "254712345678".
  if (value.startsWith(KE_COUNTRY_CODE)) {
    const subscriber = value.slice(KE_COUNTRY_CODE.length);
    return KE_SUBSCRIBER_RE.test(subscriber)
      ? (`+${KE_COUNTRY_CODE}${subscriber}` as E164)
      : undefined;
  }

  // National format with trunk prefix: "0712345678".
  if (value.startsWith("0")) {
    const subscriber = value.slice(1);
    return KE_SUBSCRIBER_RE.test(subscriber)
      ? (`+${KE_COUNTRY_CODE}${subscriber}` as E164)
      : undefined;
  }

  // Bare subscriber number: "712345678".
  return KE_SUBSCRIBER_RE.test(value) ? (`+${KE_COUNTRY_CODE}${value}` as E164) : undefined;
}

/** Normalise to E.164 or throw a typed, non-leaking AppError. */
export function normalisePhone(
  input: string | null | undefined,
  options: NormalisePhoneOptions = {},
): E164 {
  const normalised = tryNormalisePhone(input, options);
  if (!normalised) {
    // The raw value is deliberately absent from the message and meta: an
    // invalid phone number is still personal data (hard rule 4).
    throw new AppError("VALIDATION_FAILED", "That phone number doesn't look right.", {
      meta: { field: "phone" },
    });
  }
  return normalised;
}

export function isE164(value: unknown): value is E164 {
  return typeof value === "string" && E164_RE.test(value);
}

/**
 * Log-safe rendering: keeps country code and last 3 digits only.
 * `+254712345678` → `+254•••••678`. Use this anywhere a number would
 * otherwise reach pino, OpenTelemetry or Sentry.
 */
export function maskPhone(input: string | null | undefined): string {
  if (typeof input !== "string" || input.length < 5) return "•••";
  const normalised = tryNormalisePhone(input) ?? input;
  const head = normalised.slice(0, 4);
  const tail = normalised.slice(-3);
  const hidden = Math.max(normalised.length - head.length - tail.length, 0);
  return `${head}${"•".repeat(hidden)}${tail}`;
}

/** The WhatsApp `wa_id` form: E.164 without the leading "+". */
export function toWaId(value: E164): string {
  return value.slice(1);
}
