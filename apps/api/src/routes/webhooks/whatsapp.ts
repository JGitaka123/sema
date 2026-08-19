import {
  SIGNATURE_HEADER,
  dedupKeys,
  parseWebhook,
  toJobData,
  verifyHandshake,
  verifySignature,
  type WebhookEvent,
} from "@sema/channels";
import { claimWebhooks, getPool } from "@sema/db";
import { JOB_NAMES, JOB_QUEUES } from "@sema/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { ApiConfig } from "../../config.js";
import { getQueue } from "../../queue.js";

/**
 * `GET|POST /webhooks/whatsapp` — Meta's Cloud API webhook.
 *
 * The contract, in order (ARCHITECTURE.md §2, §9; hard rule 6):
 *
 *   1. verify `X-Hub-Signature-256` over the **raw request bytes**, timing-safe,
 *      rejecting when it is missing;
 *   2. parse the envelope into events;
 *   3. dedup each one in `webhook_dedup` (`on conflict do nothing`);
 *   4. enqueue the survivors;
 *   5. 200, in well under three seconds.
 *
 * Nothing else. No clinic lookup, no patient upsert, no channel call — Meta
 * retries anything slower than ~5s and anything that is not a 2xx, and a
 * webhook that does real work turns one slow query into a redelivery storm.
 * Everything after step 4 happens in `apps/worker`.
 */

/** Injected so the route can be tested without Postgres or Redis. */
export interface WhatsAppWebhookDeps {
  /** Claim ids, returning only those not seen before. */
  claim(ids: readonly string[]): Promise<string[]>;
  /** Enqueue jobs. Job ids are deterministic, so BullMQ dedups a replay too. */
  enqueue(jobs: readonly QueuedJob[]): Promise<void>;
}

export interface QueuedJob {
  name: string;
  jobId: string;
  data: unknown;
}

export interface WhatsAppWebhookOptions {
  config: ApiConfig;
  deps?: WhatsAppWebhookDeps;
}

/** Production wiring: Postgres for dedup, BullMQ for the handoff. */
export function defaultDeps(): WhatsAppWebhookDeps {
  return {
    claim: (ids) => claimWebhooks(getPool(), "whatsapp", ids),
    enqueue: async (jobs) => {
      if (jobs.length === 0) return;
      await getQueue(JOB_QUEUES.inbound).addBulk(
        jobs.map((job) => ({ name: job.name, data: job.data, opts: { jobId: job.jobId } })),
      );
    },
  };
}

const VerifyQuery = z.object({
  "hub.mode": z.string().optional(),
  "hub.verify_token": z.string().optional(),
  "hub.challenge": z.string().optional(),
});

/** Fastify does not expose the raw body; we stash it on the request. */
interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

const jobNameFor = (event: WebhookEvent): string =>
  event.type === "message" ? JOB_NAMES.inboundProcess : JOB_NAMES.inboundStatus;

export const whatsappWebhookRoutes: FastifyPluginAsync<WhatsAppWebhookOptions> = async (
  app,
  options,
) => {
  const { config } = options;
  // Resolved lazily so a test that supplies its own deps never touches the
  // real pool or Redis, and so importing the module stays free.
  let deps = options.deps;
  const getDeps = (): WhatsAppWebhookDeps => (deps ??= defaultDeps());

  /**
   * Keep the body as raw bytes.
   *
   * This is the whole ballgame. Fastify's default JSON parser hands the route
   * a parsed object, and the raw bytes are gone — so a signature check has to
   * re-serialise, which changes key order, spacing and unicode escaping and
   * silently verifies a *different* document from the one we act on.
   *
   * The parser is registered inside this plugin, which Fastify encapsulates,
   * so only these routes get raw bodies; the rest of the API keeps normal JSON
   * parsing. Verification happens first, `JSON.parse` second, on the exact
   * bytes that were verified.
   */
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      (request as RawBodyRequest).rawBody = body as Buffer;
      done(null, body);
    },
  );

  /**
   * The subscription handshake. Meta calls this once when the webhook URL is
   * saved, and again on re-verification, expecting the challenge echoed back
   * as `text/plain`.
   */
  app.withTypeProvider<ZodTypeProvider>().route({
    method: "GET",
    url: "/webhooks/whatsapp",
    schema: {
      summary: "Meta webhook verification handshake",
      description:
        "Echoes hub.challenge when hub.verify_token matches WHATSAPP_VERIFY_TOKEN. 403 otherwise.",
      tags: ["webhooks"],
      querystring: VerifyQuery,
    },
    handler: async (request, reply) => {
      const query = request.query as z.infer<typeof VerifyQuery>;
      const challenge = verifyHandshake(
        {
          mode: query["hub.mode"],
          token: query["hub.verify_token"],
          challenge: query["hub.challenge"],
        },
        config.WHATSAPP_VERIFY_TOKEN,
      );

      if (challenge === undefined) {
        request.log.warn({ route: "whatsapp.verify" }, "webhook verification rejected");
        return reply.status(403).send();
      }

      // Meta compares the body byte for byte; it must not be JSON.
      return reply.type("text/plain").send(challenge);
    },
  });

  app.route({
    method: "POST",
    url: "/webhooks/whatsapp",
    schema: {
      summary: "Meta webhook delivery",
      description:
        "Verifies X-Hub-Signature-256 over the raw body, dedups on wa_message_id and enqueues. " +
        "Does no database work beyond dedup: the ack budget is under three seconds.",
      tags: ["webhooks"],
    },
    // The body is PHI. Fastify's request logging never sees it (the parser
    // hands over a Buffer), and nothing below logs it either.
    handler: async (request, reply) => {
      const rawBody = (request as RawBodyRequest).rawBody ?? Buffer.alloc(0);

      const signature = verifySignature(
        rawBody,
        request.headers[SIGNATURE_HEADER],
        config.WHATSAPP_APP_SECRET,
      );
      if (!signature.ok) {
        // Reason only — never the header value, never the body. An unsigned
        // POST to a public URL is internet background noise, so this is a
        // warn, not an error.
        request.log.warn(
          { route: "whatsapp.webhook", reason: signature.reason },
          "webhook signature rejected",
        );
        return reply.status(401).send({
          error: { code: "UNAUTHORIZED", message: "Invalid signature." },
        });
      }

      let payload: unknown;
      try {
        payload = rawBody.length === 0 ? {} : JSON.parse(rawBody.toString("utf8"));
      } catch {
        // Signed but unparseable. Meta will not fix itself by retrying, and a
        // 4xx stops the redelivery loop.
        request.log.warn({ route: "whatsapp.webhook" }, "webhook body was not JSON");
        return reply.status(400).send({
          error: { code: "BAD_REQUEST", message: "Body is not JSON." },
        });
      }

      const { events, ignored } = parseWebhook(payload);

      if (events.length === 0) {
        // Nothing actionable — a template status update, an account update, a
        // change with no metadata. 200 so Meta stops resending it.
        request.log.debug({ route: "whatsapp.webhook", ignored }, "webhook had no events");
        return reply.status(200).send({ accepted: 0, duplicates: 0 });
      }

      const keys = dedupKeys(events);
      const claimed = new Set(await getDeps().claim(keys));

      const jobs: QueuedJob[] = [];
      for (const [index, event] of events.entries()) {
        const key = keys[index];
        if (key === undefined || !claimed.has(key)) continue;
        jobs.push({
          name: jobNameFor(event),
          // Deterministic: a replay that somehow got past the table still
          // collapses onto the same BullMQ job (CLAUDE.md §Idempotency).
          jobId: `wa:${key}`,
          data: toJobData(event),
        });
      }

      await getDeps().enqueue(jobs);

      const duplicates = events.length - jobs.length;
      request.log.info(
        { route: "whatsapp.webhook", accepted: jobs.length, duplicates, ignored },
        "webhook accepted",
      );

      return reply.status(200).send({ accepted: jobs.length, duplicates });
    },
  });
};
