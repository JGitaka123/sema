import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { AppError } from "@sema/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { loadConfig, type ApiConfig } from "./config.js";
import { loggerOptions, type LogDestination } from "./logger.js";
import { healthRoutes } from "./routes/health.js";
import { whatsappWebhookRoutes, type WhatsAppWebhookDeps } from "./routes/webhooks/whatsapp.js";

export interface BuildAppOptions {
  config?: ApiConfig;
  /** Set false in tests to keep output clean. */
  logger?: boolean;
  /**
   * Collect log lines instead of writing them to stdout, through the real
   * pino configuration — redaction list and serialisers included. The PHI
   * tests use it; production leaves it undefined.
   */
  logDestination?: LogDestination;
  /**
   * Override the WhatsApp webhook's Postgres/Redis wiring. Tests pass fakes;
   * production leaves it undefined and the route builds the real thing on
   * first use.
   */
  whatsappDeps?: WhatsAppWebhookDeps;
}

/**
 * Build the API without listening, so tests can drive it through
 * `app.inject()` and the server entrypoint can own process lifecycle.
 *
 * Zod is the single source of truth for validation *and* the OpenAPI document
 * (CLAUDE.md: "Zod for all boundaries, OpenAPI generated from Zod").
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  // An explicit destination implies logging is wanted, even under NODE_ENV=test.
  const useLogger = options.logger ?? (options.logDestination !== undefined || config.NODE_ENV !== "test");

  const app = Fastify({
    logger: useLogger ? loggerOptions(config.LOG_LEVEL, options.logDestination) : false,
    // Meta signs the raw body; keeping the limit tight also caps webhook abuse.
    bodyLimit: 1_048_576,
    // Webhooks must ack in < 3s (hard rule 6) — fail fast rather than hang.
    requestTimeout: 10_000,
    // Trust the platform proxy (Fly/Railway) for client IPs and protocol.
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Sema API",
        description:
          "AI front-desk for clinics. Staff inbox API, WhatsApp and M-Pesa webhooks. " +
          "All patient data is tenant-scoped; every endpoint requires a clinic context.",
        version: "0.0.0",
      },
      servers: [{ url: config.API_PUBLIC_URL }],
      tags: [
        { name: "system", description: "Health and diagnostics" },
        { name: "webhooks", description: "Signed callbacks from Meta and Safaricom" },
      ],
    },
    transform: jsonSchemaTransform,
  });

  // The Swagger *document* is always generated — tests assert against it and
  // clients generate from it. The interactive UI is a local convenience only:
  // it serves a few MB of static assets, which is wasted work in tests and an
  // unauthenticated surface anywhere patient data exists.
  if (config.NODE_ENV === "development") {
    await app.register(fastifySwaggerUi, { routePrefix: "/docs" });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = AppError.from(error);

    // 5xx is our bug: log it with the request id, return nothing useful.
    // 4xx is the caller's: no log noise.
    if (appError.status >= 500) {
      request.log.error(
        { code: appError.code, err: appError, ...(appError.meta ?? {}) },
        "request failed",
      );
    }

    // Hard rule: never leak internals. AppError.toJSON() already decides what
    // is safe to expose based on `expose`.
    return reply.status(appError.status).send(appError.toJSON());
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: "NOT_FOUND", message: "Route not found." } }),
  );

  await app.register(healthRoutes);

  // Registered as its own plugin so Fastify's encapsulation keeps the raw-body
  // content-type parser it installs from leaking to the rest of the API.
  await app.register(whatsappWebhookRoutes, {
    config,
    ...(options.whatsappDeps === undefined ? {} : { deps: options.whatsappDeps }),
  });

  return app;
}
