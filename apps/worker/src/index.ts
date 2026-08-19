import { pathToFileURL } from "node:url";

import { type Worker } from "bullmq";
import pino from "pino";

import { HOLD_EXPIRY_JOB, registerHoldExpiry, runHoldExpiry } from "./jobs/hold-expiry.js";
import { ALL_QUEUE_NAMES, closeQueues, createWorker } from "./queues.js";

/**
 * Worker process entrypoint.
 *
 * Phase 0 registers a consumer per queue with a placeholder processor so the
 * wiring, logging and shutdown path are real and reviewable. Phase 2 adds the
 * first real one — hold expiry, on the `system` queue. The rest land with the
 * features that need them: inbound in Phase 3, payments in Phase 6, reminders
 * in Phase 7 (docs/BUILD_PLAN.md).
 */
const log = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  // No PHI in logs (hard rule 4) — job payloads are never logged wholesale.
  redact: { paths: ["*.phone", "*.text", "*.name", "*.wa_id"], censor: "[redacted]" },
});

export function startWorkers(): Worker[] {
  return ALL_QUEUE_NAMES.map((name) =>
    createWorker(name, async (job) => {
      // Log the identity of the work, never its contents.
      log.info({ queue: name, jobName: job.name, jobId: job.id }, "job received");
      if (job.name === HOLD_EXPIRY_JOB) return runHoldExpiry();
      return { ok: true };
    }),
  );
}

async function main(): Promise<void> {
  const workers = startWorkers();
  await registerHoldExpiry();
  log.info({ queues: ALL_QUEUE_NAMES }, "worker started");

  const shutdown = (signal: string): void => {
    log.info({ signal }, "shutting down");
    void Promise.all(workers.map((worker) => worker.close()))
      .then(closeQueues)
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Only run when executed directly, so tests can import the module freely.
// pathToFileURL (not string concatenation) — Windows paths are not URLs.
const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "worker failed to start");
    process.exit(1);
  });
}
