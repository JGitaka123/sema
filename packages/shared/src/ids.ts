import { ulid } from "ulid";

/**
 * Every externally visible identifier is a prefixed ULID (CLAUDE.md §Conventions).
 * The prefix makes IDs self-describing in logs, URLs and model tool calls, and
 * lets us reject an appointment id passed where a patient id was expected.
 *
 * The DB stores the *prefixed* string, so ids are copy-pasteable end to end.
 */
export const ID_PREFIXES = {
  clinic: "cli",
  location: "loc",
  user: "usr",
  provider: "prv",
  service: "svc",
  patient: "pat",
  appointment: "apt",
  conversation: "conv",
  message: "msg",
  outbox: "out",
  escalation: "esc",
  paymentRequest: "pyr",
  payment: "pay",
  slotHold: "hld",
  auditLog: "aud",
  knowledge: "knw",
  // Added in Phase 1 so every table in docs/DATA_MODEL.md with an `id` column
  // has a prefix of its own. No prefix may be a prefix of another one — a test
  // in ids.test.ts enforces both properties.
  intakeQuestion: "siq",
  availabilityRule: "avr",
  timeOff: "tof",
  consent: "pcn",
  attachment: "att",
  reminder: "rem",
  template: "tpl",
  note: "nte",
  subscription: "sub",
  payer: "pyer",
  encounter: "enc",
  // Phase 3: a clinic's connected WhatsApp sender (INTEGRATIONS.md §1).
  clinicWhatsapp: "cwa",
} as const;

export type IdEntity = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdEntity];

/** `pat_01J...` — a branded-ish template type, cheap to use and readable. */
export type PrefixedId<E extends IdEntity = IdEntity> = `${(typeof ID_PREFIXES)[E]}_${string}`;

/** ULIDs are 26 chars of Crockford base32 (no I, L, O, U). */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Generate a new prefixed ULID, e.g. `newId("patient")` → `pat_01J8...`. */
export function newId<E extends IdEntity>(entity: E): PrefixedId<E> {
  return `${ID_PREFIXES[entity]}_${ulid()}` as PrefixedId<E>;
}

/** True when `value` is a well-formed id for `entity`. */
export function isId<E extends IdEntity>(entity: E, value: unknown): value is PrefixedId<E> {
  if (typeof value !== "string") return false;
  const prefix = ID_PREFIXES[entity];
  if (!value.startsWith(`${prefix}_`)) return false;
  return ULID_RE.test(value.slice(prefix.length + 1));
}

/**
 * Narrow an untrusted value to an id of `entity`, or return undefined.
 * Callers at a boundary should prefer the Zod schema in `schemas.ts`.
 */
export function parseId<E extends IdEntity>(entity: E, value: unknown): PrefixedId<E> | undefined {
  return isId(entity, value) ? value : undefined;
}

/** The ULID part, without the prefix. Useful for sorting — ULIDs sort by time. */
export function idBody(value: string): string {
  const idx = value.indexOf("_");
  return idx === -1 ? value : value.slice(idx + 1);
}
