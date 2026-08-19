import { JOB_NAMES, JOB_QUEUES } from "@sema/shared";
import { describe, expect, it } from "vitest";

import { QUEUE_NAMES } from "../queues.js";

/**
 * The API and the worker cannot import each other, so they agree on queue
 * names through `@sema/shared`. This is the test that keeps the agreement
 * honest: a rename on one side that is not mirrored on the other would
 * otherwise produce jobs that enqueue perfectly and are never consumed —
 * silently, in production.
 */
describe("queue names agree across the two apps", () => {
  it("uses the same queue for inbound work as the API produces to", () => {
    expect(JOB_QUEUES.inbound).toBe(QUEUE_NAMES.inbound);
  });

  it("uses the same queue for outbound delivery", () => {
    expect(JOB_QUEUES.outbox).toBe(QUEUE_NAMES.outbox);
  });

  it("names every job the webhook and outbox can enqueue", () => {
    expect(Object.values(JOB_NAMES).sort()).toEqual([
      "inbound.process",
      "inbound.status",
      "outbox.send",
    ]);
  });
});
