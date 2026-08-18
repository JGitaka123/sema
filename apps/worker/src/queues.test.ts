import { AppError } from "@sema/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ALL_QUEUE_NAMES,
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
  getConnection,
  isConnected,
  jobKey,
  queuePrefix,
} from "./queues.js";

const originalRedisUrl = process.env["REDIS_URL"];
const originalPrefix = process.env["QUEUE_PREFIX"];

beforeEach(() => {
  delete process.env["REDIS_URL"];
  delete process.env["QUEUE_PREFIX"];
});

afterEach(() => {
  if (originalRedisUrl === undefined) delete process.env["REDIS_URL"];
  else process.env["REDIS_URL"] = originalRedisUrl;
  if (originalPrefix === undefined) delete process.env["QUEUE_PREFIX"];
  else process.env["QUEUE_PREFIX"] = originalPrefix;
});

describe("module import", () => {
  it("does not connect to Redis at import time", () => {
    // The whole point of the lazy wiring: this test file imported the module
    // with no REDIS_URL set and no Redis running, and got here.
    expect(isConnected()).toBe(false);
  });
});

describe("getConnection", () => {
  it("fails loudly when REDIS_URL is missing, rather than at first job", () => {
    const error = (() => {
      try {
        getConnection();
        return undefined;
      } catch (e) {
        return e as AppError;
      }
    })();

    expect(AppError.is(error)).toBe(true);
    expect(error?.code).toBe("INTERNAL");
    // Config problems are ours, not the caller's — nothing is exposed.
    expect(error?.expose).toBe(false);
    expect(isConnected()).toBe(false);
  });
});

describe("queue names", () => {
  it("covers every pipeline the architecture describes", () => {
    expect(ALL_QUEUE_NAMES).toEqual(
      expect.arrayContaining(["inbound", "outbox", "reminders", "payments", "system"]),
    );
  });

  it("has no duplicates", () => {
    expect(new Set(ALL_QUEUE_NAMES).size).toBe(ALL_QUEUE_NAMES.length);
  });

  it("exposes the same set through the map and the array", () => {
    expect([...ALL_QUEUE_NAMES].sort()).toEqual(Object.values(QUEUE_NAMES).sort());
  });
});

describe("queuePrefix", () => {
  it("defaults to sema", () => {
    expect(queuePrefix()).toBe("sema");
  });

  it("is overridable so environments can share one Redis", () => {
    process.env["QUEUE_PREFIX"] = "sema-staging";
    expect(queuePrefix()).toBe("sema-staging");
  });
});

describe("DEFAULT_JOB_OPTIONS", () => {
  it("retries five times with exponential backoff, as the architecture requires", () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(5);
    expect(DEFAULT_JOB_OPTIONS.backoff).toMatchObject({ type: "exponential" });
  });

  it("keeps failed jobs so dead letters can be surfaced in the inbox", () => {
    expect(DEFAULT_JOB_OPTIONS.removeOnFail).not.toBe(true);
  });
});

describe("jobKey", () => {
  it("is deterministic for the same logical work", () => {
    expect(jobKey("inbound", "wamid.ABC")).toBe(jobKey("inbound", "wamid.ABC"));
  });

  it("joins parts with a colon", () => {
    expect(jobKey("outbox", "msg_01J", 3)).toBe("outbox:msg_01J:3");
  });

  it("distinguishes different work", () => {
    expect(jobKey("inbound", "wamid.ABC")).not.toBe(jobKey("inbound", "wamid.DEF"));
  });

  it("neutralises colons inside a part so one part cannot fake two", () => {
    // Without escaping, ("a:b","c") and ("a","b:c") would collide.
    expect(jobKey("a:b", "c")).not.toBe(jobKey("a", "b:c"));
  });

  it("trims whitespace so a stray space does not create a second job", () => {
    expect(jobKey(" inbound ", "wamid.ABC")).toBe("inbound:wamid.ABC");
  });

  it("rejects empty input", () => {
    expect(() => jobKey()).toThrowError(AppError);
    expect(() => jobKey("inbound", "")).toThrowError(AppError);
    expect(() => jobKey("inbound", "   ")).toThrowError(AppError);
  });
});
