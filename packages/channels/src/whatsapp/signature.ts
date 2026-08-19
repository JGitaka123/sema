import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * `X-Hub-Signature-256` verification (ARCHITECTURE.md §9: "Webhook signature
 * verification mandatory; reject if missing").
 *
 * This is the only thing standing between a public HTTPS endpoint and someone
 * writing messages into a clinic's inbox, so three things matter more than
 * elegance:
 *
 *  1. **The raw bytes.** The HMAC is over exactly what Meta sent. Any
 *     `JSON.parse` → `JSON.stringify` round trip changes key order, unicode
 *     escaping and whitespace, and the signature stops matching (or, worse,
 *     someone "fixes" it by comparing against re-serialised JSON, and now the
 *     signature verifies a document that is not the one we act on). Callers
 *     must hand us the Buffer, before any parsing. This is the classic bug in
 *     every WhatsApp integration.
 *  2. **Constant-time comparison.** A `===` on hex digests leaks the digest
 *     one byte at a time to anyone who can measure it.
 *  3. **Missing is invalid.** No header, wrong prefix, wrong length: reject.
 */

export const SIGNATURE_HEADER = "x-hub-signature-256";
const PREFIX = "sha256=";
/** SHA-256 as lowercase hex. */
const DIGEST_HEX_LENGTH = 64;

/** Compute the header value Meta would send for `body`. Also used by wa:simulate. */
export function signPayload(body: Buffer | string, appSecret: string): string {
  const digest = createHmac("sha256", appSecret)
    .update(typeof body === "string" ? Buffer.from(body, "utf8") : body)
    .digest("hex");
  return `${PREFIX}${digest}`;
}

export type SignatureFailure =
  | "missing_secret"
  | "missing_header"
  | "malformed_header"
  | "mismatch";

export type SignatureResult = { ok: true } | { ok: false; reason: SignatureFailure };

/**
 * Verify `header` against the raw request body.
 *
 * Returns a result rather than throwing: the caller decides the HTTP status,
 * and a rejected webhook is not exceptional — it is the endpoint doing its
 * job, several times a day, for internet background noise.
 */
export function verifySignature(
  rawBody: Buffer,
  header: string | string[] | undefined,
  appSecret: string | undefined,
): SignatureResult {
  // A missing secret must never read as "valid". Failing closed here is why
  // the config refuses to boot in production without one.
  if (!appSecret) return { ok: false, reason: "missing_secret" };

  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, reason: "missing_header" };
  }
  if (!value.startsWith(PREFIX)) return { ok: false, reason: "malformed_header" };

  const provided = value.slice(PREFIX.length).toLowerCase();
  // Length and alphabet are checked before the compare so `timingSafeEqual`
  // never throws on mismatched buffer lengths — and so a truncated signature
  // is a clean rejection rather than a 500.
  if (provided.length !== DIGEST_HEX_LENGTH || !/^[0-9a-f]+$/.test(provided)) {
    return { ok: false, reason: "malformed_header" };
  }

  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");

  const equal = timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  return equal ? { ok: true } : { ok: false, reason: "mismatch" };
}

/**
 * The `GET /webhooks/whatsapp` handshake Meta performs when the webhook URL is
 * first configured, and again whenever it is re-verified.
 *
 * Returns the challenge to echo back verbatim, or undefined to 403. The token
 * compare is constant-time too: it is a shared secret like any other.
 */
export function verifyHandshake(
  query: { mode?: unknown; token?: unknown; challenge?: unknown },
  verifyToken: string | undefined,
): string | undefined {
  if (!verifyToken) return undefined;
  if (query.mode !== "subscribe") return undefined;
  if (typeof query.token !== "string" || typeof query.challenge !== "string") return undefined;

  const provided = Buffer.from(query.token, "utf8");
  const expected = Buffer.from(verifyToken, "utf8");
  if (provided.length !== expected.length) return undefined;
  if (!timingSafeEqual(provided, expected)) return undefined;

  return query.challenge;
}
