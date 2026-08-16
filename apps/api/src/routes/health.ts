import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

/**
 * Liveness probe. Deliberately dependency-free: it answers "is this process
 * up and serving?" and nothing else, so Fly/Railway never restarts a healthy
 * API because Postgres is briefly slow. Readiness (DB + Redis reachable)
 * arrives with the components it would check.
 */
const HealthResponse = z
  .object({
    status: z.literal("ok"),
  })
  .describe("Service is up and serving requests");

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().route({
    method: "GET",
    url: "/health",
    schema: {
      summary: "Liveness probe",
      description: "Returns 200 while the process is up. Does not touch Postgres or Redis.",
      tags: ["system"],
      response: { 200: HealthResponse },
    },
    // Health checks run every few seconds; logging them buries real traffic.
    logLevel: "warn",
    handler: async () => ({ status: "ok" }) as const,
  });
};
