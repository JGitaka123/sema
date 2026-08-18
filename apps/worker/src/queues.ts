import { AppError } from "@sema/shared";
import { Queue, Worker, type ConnectionOptions, type JobsOptions, type Processor } from "bullmq";
import { Redis } from "ioredis";

/**
 * Queue and worker wiring.
 *
 * Everything here is lazy on purpose: importing this module must never open a
 * socket. Unit tests, `--help` and the API's build step all import it, and
 * none of them have Redis. The first call to `getConnection()` is what
 * connects.
 */

/**
 * The queues Sema runs. Names are stable strings — renaming one orphans jobs
 * already in Redis, so treat them as a migration.
 */
export const QUEUE_NAMES = {
  /** Inbound WhatsApp messages, handed off from the webhook (hard rule 6). */
  inbound: "inbound",
  /** Outbound delivery. Nothing calls the channel directly from a handler. */
  outbox: "outbox",
  /** Appointment reminders, follow-ups, no-show marking. */
  reminders: "reminders",
  /** M-Pesa callback processing and the reconciler. */
  payments: "payments",
  /** Nightly and scheduled housekeeping: digests, retention, hold expiry. */
  system: "system",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUE_NAMES: QueueName[] = Object.values(QUEUE_NAMES);

/**
 * Default job options.
 *
 * ARCHITECTURE.md §11: "Outbox delivery retry: 5 attempts, exponential
 * backoff, dead-letter to inbox alert". Failed jobs are kept so the inbox can
 * surface a dead letter; completed jobs are trimmed to keep Redis small.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

function redisUrl(): string {
  const url = process.env["REDIS_URL"];
  if (!url) {
    throw new AppError("INTERNAL", "REDIS_URL is not set.", { expose: false });
  }
  return url;
}

/** Prefix keeps environments sharing one Redis from colliding. */
export function queuePrefix(): string {
  return process.env["QUEUE_PREFIX"] ?? "sema";
}

let connection: Redis | undefined;

/**
 * The shared ioredis connection. Created on first call, never at import.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ — without it, blocking
 * commands fail during a Redis failover instead of waiting it out.
 */
export function getConnection(): Redis {
  if (!connection) {
    connection = new Redis(redisUrl(), {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });
  }
  return connection;
}

const queues = new Map<QueueName, Queue>();

/** Get (or lazily create) a queue producer. */
export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: getConnection() as unknown as ConnectionOptions,
      prefix: queuePrefix(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    queues.set(name, queue);
  }
  return queue;
}

/** Create a consumer for `name`. Callers own the returned Worker's lifecycle. */
export function createWorker<T = unknown, R = unknown>(
  name: QueueName,
  processor: Processor<T, R>,
  concurrency = 5,
): Worker<T, R> {
  return new Worker<T, R>(name, processor, {
    connection: getConnection() as unknown as ConnectionOptions,
    prefix: queuePrefix(),
    concurrency,
  });
}

/**
 * Deterministic job id.
 *
 * CLAUDE.md: "all worker jobs idempotent by job key". Enqueuing the same
 * logical work twice — a retried Meta webhook, a duplicated Daraja callback —
 * must produce the same id so BullMQ de-duplicates it for us.
 */
export function jobKey(...parts: Array<string | number>): string {
  if (parts.length === 0) {
    throw new AppError("INTERNAL", "A job key needs at least one part.", { expose: false });
  }
  return parts
    .map((part) => String(part).trim())
    .map((part) => {
      if (part === "") {
        throw new AppError("INTERNAL", "A job key part cannot be empty.", { expose: false });
      }
      // ":" is BullMQ's key separator; allowing it in a part would let one
      // part masquerade as two.
      return part.replace(/:/g, "-");
    })
    .join(":");
}

/** Whether anything has actually connected. Used by tests and shutdown. */
export function isConnected(): boolean {
  return connection !== undefined;
}

/** Close queues and the shared connection. Safe when nothing ever connected. */
export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();

  const current = connection;
  connection = undefined;
  if (current) await current.quit();
}
