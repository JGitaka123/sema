/**
 * Job names, shared by whoever enqueues and whoever consumes.
 *
 * The API webhook produces; `apps/worker` consumes. Neither app can import the
 * other, so the vocabulary lives here — a string typo would otherwise mean
 * jobs that queue perfectly and are never processed.
 *
 * Queue *names* are owned by `apps/worker/src/queues.ts`; these are the job
 * names inside them. Renaming either orphans jobs already in Redis, so treat a
 * change as a migration.
 */

export const JOB_NAMES = {
  /** One inbound patient message, ready to be persisted (ARCHITECTURE.md §2). */
  inboundProcess: "inbound.process",
  /** A delivery receipt for a message we sent: sent | delivered | read | failed. */
  inboundStatus: "inbound.status",
  /** Deliver one `outbox` row through the channel adapter. */
  outboxSend: "outbox.send",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/**
 * The queues those jobs live on. Kept as a literal so the API can produce
 * without importing the worker; `apps/worker` has a test asserting these match
 * its own `QUEUE_NAMES`.
 */
export const JOB_QUEUES = {
  inbound: "inbound",
  outbox: "outbox",
} as const;
