import { AppError, type JOB_QUEUES } from "@sema/shared";
import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";

/**
 * The API's side of the queue: it produces, it never consumes.
 *
 * Hard rule 6 — "webhooks are idempotent and fast: ack < 3s, do work in the
 * queue". A webhook handler's entire job is to verify, dedup and enqueue, so
 * this module is deliberately small and, like `apps/worker/src/queues.ts`,
 * lazy: importing it must never open a socket, because `pnpm test` and
 * `buildApp()` both do.
 *
 * The consumer side (workers, concurrency, retry policy) lives in
 * `apps/worker/src/queues.ts`. The two agree on names through
 * `@sema/shared`'s `JOB_QUEUES` / `JOB_NAMES`.
 */

/**
 * Retry policy for jobs the API enqueues.
 *
 * Mirrors the worker's `DEFAULT_JOB_OPTIONS` (ARCHITECTURE.md §11: five
 * attempts, exponential backoff). BullMQ takes the options from whoever adds
 * the job, so they have to be stated here too.
 */
export const PRODUCER_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

export type ProducerQueueName = (typeof JOB_QUEUES)[keyof typeof JOB_QUEUES];

let connection: Redis | undefined;
const queues = new Map<string, Queue>();

function redisUrl(): string {
  const url = process.env["REDIS_URL"];
  if (!url) throw new AppError("INTERNAL", "REDIS_URL is not set.", { expose: false });
  return url;
}

function queuePrefix(): string {
  return process.env["QUEUE_PREFIX"] ?? "sema";
}

function getConnection(): Redis {
  if (!connection) {
    connection = new Redis(redisUrl(), {
      // Required by BullMQ: without it, blocking commands fail during a Redis
      // failover instead of waiting it out.
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });
  }
  return connection;
}

export function getQueue(name: ProducerQueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: getConnection() as unknown as ConnectionOptions,
      prefix: queuePrefix(),
      defaultJobOptions: PRODUCER_JOB_OPTIONS,
    });
    queues.set(name, queue);
  }
  return queue;
}

/** Close producers on shutdown. Safe when nothing ever connected. */
export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
  const current = connection;
  connection = undefined;
  if (current) await current.quit();
}
