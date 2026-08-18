import type { FastifyServerOptions } from "fastify";

/**
 * Logging configuration.
 *
 * CLAUDE.md hard rule 4: "PHI never leaves the tenant boundary: no PHI in
 * logs, analytics, error tracking". Request logging is therefore built around
 * explicit serialisers (only method/url/status are emitted, never whole
 * req/res objects) plus a redaction list for headers and fields that carry
 * patient data or secrets.
 *
 * If you add a route that accepts patient content, do not log the body.
 * Phone numbers that must appear in a log line go through `maskPhone` from
 * @sema/shared first.
 */
const REDACT_PATHS = [
  // Credentials and signatures.
  'req.headers["authorization"]',
  'req.headers["cookie"]',
  'req.headers["x-hub-signature-256"]',
  'res.headers["set-cookie"]',
  // Patient data, wherever it turns up in a logged object.
  "*.phone",
  "*.phoneNumber",
  "*.wa_id",
  "*.waId",
  "*.text",
  "*.patientName",
  "*.name",
];

export function loggerOptions(level: string): FastifyServerOptions["logger"] {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    serializers: {
      req(request: { method: string; url: string; id: string }) {
        return { method: request.method, url: request.url, id: request.id };
      },
      res(reply: { statusCode: number }) {
        return { statusCode: reply.statusCode };
      },
    },
  };
}
