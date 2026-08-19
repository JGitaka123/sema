import { JOB_NAMES } from "@sema/shared";
import type { PrefixedId } from "@sema/shared";

import { QUEUE_NAMES, getQueue, jobKey } from "../queues.js";

/**
 * Hand an outbox row to the delivery queue.
 *
 * Called *after* the transaction that wrote the row has committed — enqueuing
 * inside it would let a worker pick up a row that is then rolled back.
 *
 * The job id is deterministic (`jobKey`), so publishing the same row twice —
 * a retried caller, a redelivered upstream job — collapses onto one job. The
 * `pending → sending` claim in `deliverOutbox` is the second guard.
 */
export async function publishOutbox(
  clinicId: PrefixedId<"clinic">,
  outboxId: string,
): Promise<void> {
  await getQueue(QUEUE_NAMES.outbox).add(
    JOB_NAMES.outboxSend,
    { clinicId, outboxId },
    { jobId: jobKey("outbox", outboxId) },
  );
}
