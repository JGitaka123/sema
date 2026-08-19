import { InboundJobData, StatusJobData } from "@sema/channels";
import { createWithTenantDb, getPool, withTenant } from "@sema/db";
import {
  createAnthropicClient,
  createClassifierCache,
  recordingDepositRequester,
} from "@sema/engine";
import { createScheduler } from "@sema/scheduling";
import { AppError, JOB_NAMES, isId, systemClock } from "@sema/shared";
import type { Job, Processor } from "bullmq";
import { z } from "zod";

import { QUEUE_NAMES, type QueueName } from "../queues.js";
import { handleInbound, type EngineDeps } from "./engine.js";
import { deliverOutbox, type DeliverOutcome } from "./outbox.js";
import { processInboundMessage, processStatusUpdate, type InboundDeps } from "./inbound.js";

/**
 * Turning BullMQ jobs into calls on the pure-ish functions next door.
 *
 * The job functions themselves take their dependencies as arguments, so they
 * can be driven by an integration test against a real Postgres without a
 * Redis anywhere. This file is the thin layer that supplies the production
 * ones and validates what came off the queue.
 */

/**
 * The engine's dependencies, built once per process.
 *
 * Lazily, and cached: importing this module must not open a Postgres pool or
 * require `ANTHROPIC_API_KEY`, so a build, a `--help` or a unit test of another
 * job never needs either.
 */
let engineDeps: EngineDeps | undefined;

function getEngineDeps(): EngineDeps {
  if (!engineDeps) {
    const withTenantDb = createWithTenantDb(getPool());
    engineDeps = {
      executor: getPool(),
      withTenant,
      withTenantDb,
      client: createAnthropicClient(),
      scheduler: createScheduler({ withTenantDb, clock: systemClock }),
      // Phase 6 swaps this for the Daraja-backed requester. Until then the
      // agent records the intent and no money moves (see tools/deposit.ts).
      depositRequester: recordingDepositRequester({ withTenantDb }),
      cache: createClassifierCache(),
    };
  }
  return engineDeps;
}

/** Production wiring: the app pool plus tenant-scoped transactions. */
function inboundDeps(): InboundDeps {
  return {
    executor: getPool(),
    withTenant,
    /**
     * The Phase 4/5 seam, now filled: classify → route → scripted replies or
     * the agent → guardrails → outbox. `inbound.ts` only calls this when a
     * human is not in control (hard rule 3).
     */
    onPersisted: async (persisted) => {
      await handleInbound(persisted, getEngineDeps());
    },
  };
}

/** Test seam: drop the cached dependencies. */
export function resetEngineDeps(): void {
  engineDeps = undefined;
}

const OutboxJobData = z.object({
  clinicId: z.string().refine((v) => isId("clinic", v), "not a clinic id"),
  outboxId: z.string().min(1),
});

/**
 * Validate at the queue boundary like any other boundary.
 *
 * A job can outlive a deploy, so the payload in Redis may have been written by
 * an older version. A schema failure should fail that one job loudly, not
 * throw a `TypeError` from somewhere deep in a SQL builder.
 */
function parse<T>(schema: z.ZodType<T>, data: unknown, jobName: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", `Malformed ${jobName} job payload.`, {
      expose: false,
      // Field paths only. A job payload holds a message body (hard rule 4).
      meta: { fields: parsed.error.issues.map((i) => i.path.join(".")).join(",") },
    });
  }
  return parsed.data;
}

export const inboundProcessor: Processor<unknown, unknown> = async (job: Job) => {
  switch (job.name) {
    case JOB_NAMES.inboundProcess:
      return processInboundMessage(
        parse(InboundJobData, job.data, JOB_NAMES.inboundProcess),
        inboundDeps(),
      );
    case JOB_NAMES.inboundStatus:
      return processStatusUpdate(
        parse(StatusJobData, job.data, JOB_NAMES.inboundStatus),
        inboundDeps(),
      );
    default:
      throw new AppError("VALIDATION_FAILED", "Unknown inbound job.", {
        expose: false,
        meta: { jobName: job.name },
      });
  }
};

export const outboxProcessor: Processor<unknown, DeliverOutcome> = async (job: Job) => {
  const data = parse(OutboxJobData, job.data, JOB_NAMES.outboxSend);
  return deliverOutbox(
    {
      clinicId: data.clinicId as `cli_${string}`,
      outboxId: data.outboxId,
      attempt: job.attemptsMade,
    },
    { withTenant },
  );
};

/** The processors Phase 3 supplies, by queue. Everything else stays a stub. */
export const PROCESSORS: Partial<Record<QueueName, Processor<unknown, unknown>>> = {
  [QUEUE_NAMES.inbound]: inboundProcessor,
  [QUEUE_NAMES.outbox]: outboxProcessor as Processor<unknown, unknown>,
};
