import { pathToFileURL } from "node:url";

import { type Worker } from "bullmq";
import pino from "pino";

import { PROCESSORS } from "./jobs/index.js";
import { ALL_QUEUE_NAMES, closeQueues, createWorker } from "./queues.js";

/**
 * Worker process entrypoint.
 *
 * Phase 0 registered a consumer per queue with a placeholder processor so the
 * wiring, logging and shutdown path were real and reviewable. Phase 3 supplies
 * the first real ones — `inbound` and `outbox`, from `./jobs` — and the rest
 * keep the placeholder until their phase: payments in Phase 6, reminders in
 * Phase 7 (docs/BUILD_PLAN.md).
 */
const log = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  // No PHI in logs (hard rule 4) — job payloads are never logged wholesale.
  redact: {
    paths: ["*.phone", "*.text", "*.name", "*.wa_id", "*.body", "*.profileName", "*.fromWaId"],
    censor: "[redacted]",
  },
});

export function startWorkers(): Worker[] {
  return ALL_QUEUE_NAMES.map((name) => {
    const processor = PROCESSORS[name];

    return createWorker(name, async (job) => {
      // Log the identity of the work, never its contents.
      log.info({ queue: name, jobName: job.name, jobId: job.id }, "job received");

      if (!processor) return { ok: true };

      try {
        const result = await processor(job, "");
        log.info(
          // A job outcome is a status word, not patient data.
          { queue: name, jobName: job.name, jobId: job.id, outcome: outcomeOf(result) },
          "job done",
        );
        return result;
      } catch (error) {
        // The error object itself may carry a `meta`; `AppError` guarantees it
        // is PHI-free, and the redaction list above catches the rest.
        log.warn({ queue: name, jobName: job.name, jobId: job.id, err: error }, "job failed");
        throw error;
      }
    });
  });
}

/** The `status` field of a job result, when there is one. Never the payload. */
function outcomeOf(result: unknown): string | undefined {
  if (typeof result === "object" && result !== null && "status" in result) {
    const status = (result as { status: unknown }).status;
    if (typeof status === "string") return status;
  }
  return undefined;
}

async function main(): Promise<void> {
  const workers = startWorkers();
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
