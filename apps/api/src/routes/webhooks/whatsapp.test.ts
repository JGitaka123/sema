import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { signPayload } from "@sema/channels";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import type { QueuedJob, WhatsAppWebhookDeps } from "./whatsapp.js";

/**
 * The webhook, end to end through Fastify, with Postgres and Redis faked.
 *
 * Everything asserted here is a rule from ARCHITECTURE.md §9 or hard rule 6:
 * signature verification over raw bytes, dedup, enqueue, fast ack, and no PHI
 * anywhere in the log stream.
 */

const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "test-verify-token";

const FIXTURES = new URL("../../../../../fixtures/whatsapp/", import.meta.url);

function fixtureBytes(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, FIXTURES)), "utf8");
}

/** Records what the route tried to dedup and enqueue. */
class FakeDeps implements WhatsAppWebhookDeps {
  readonly seen = new Set<string>();
  readonly claimed: string[][] = [];
  readonly enqueued: QueuedJob[] = [];
  claimDelayMs = 0;

  async claim(ids: readonly string[]): Promise<string[]> {
    if (this.claimDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.claimDelayMs));
    }
    const fresh = ids.filter((id) => !this.seen.has(id));
    for (const id of fresh) this.seen.add(id);
    this.claimed.push([...ids]);
    return fresh;
  }

  async enqueue(jobs: readonly QueuedJob[]): Promise<void> {
    this.enqueued.push(...jobs);
  }
}

let app: FastifyInstance;
let deps: FakeDeps;
/** Everything the app logged during a test, as raw JSON lines. */
let logLines: string[];

beforeEach(async () => {
  deps = new FakeDeps();
  logLines = [];

  app = await buildApp({
    config: loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "trace",
      WHATSAPP_APP_SECRET: APP_SECRET,
      WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
    }),
    // The real pino, with the real redaction list and serialisers, writing to
    // us instead of stdout. A mocked logger would prove nothing about hard
    // rule 4 — this is the configuration production actually runs.
    logDestination: {
      write(line: string): void {
        logLines.push(line);
      },
    },
    whatsappDeps: deps,
  });

  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function post(body: string, signature?: string) {
  return app.inject({
    method: "POST",
    url: "/webhooks/whatsapp",
    headers: {
      "content-type": "application/json",
      ...(signature === undefined ? {} : { "x-hub-signature-256": signature }),
    },
    payload: body,
  });
}

function signedPost(body: string) {
  return post(body, signPayload(body, APP_SECRET));
}

describe("GET /webhooks/whatsapp — Meta's verification handshake", () => {
  it("echoes the challenge as plain text when the token matches", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
    });

    expect(response.statusCode).toBe(200);
    // Meta compares the body byte for byte — a JSON-quoted string fails.
    expect(response.body).toBe("1158201444");
    expect(response.headers["content-type"]).toContain("text/plain");
  });

  it("403s on a wrong token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1",
    });
    expect(response.statusCode).toBe(403);
  });

  it("403s when the mode is not subscribe", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/webhooks/whatsapp?hub.mode=delete&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`,
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("POST /webhooks/whatsapp — signature verification", () => {
  it("accepts a correctly signed delivery", async () => {
    const response = await signedPost(fixtureBytes("inbound-text.json"));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 1, duplicates: 0 });
  });

  it("rejects a missing signature — absence is never valid", async () => {
    const response = await post(fixtureBytes("inbound-text.json"));
    expect(response.statusCode).toBe(401);
    expect(deps.enqueued).toHaveLength(0);
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const body = fixtureBytes("inbound-text.json");
    const response = await post(body, signPayload(body, "attacker-secret"));
    expect(response.statusCode).toBe(401);
    expect(deps.enqueued).toHaveLength(0);
  });

  it("rejects a body altered after signing", async () => {
    const body = fixtureBytes("inbound-text.json");
    const signature = signPayload(body, APP_SECRET);
    const tampered = body.replace("254712000001", "254799999999");
    const response = await post(tampered, signature);
    expect(response.statusCode).toBe(401);
  });

  /**
   * The regression test for the bug this whole design exists to avoid: a
   * handler that verifies against re-serialised JSON instead of the bytes Meta
   * sent. The fixture is pretty-printed, so `JSON.stringify(JSON.parse(body))`
   * is a *different* byte string with the same meaning.
   */
  it("verifies the exact raw bytes, not a re-serialisation of them", async () => {
    const raw = fixtureBytes("inbound-text.json");
    const compact = JSON.stringify(JSON.parse(raw));
    expect(compact).not.toBe(raw);

    // Signed as sent (pretty) → accepted.
    expect((await post(raw, signPayload(raw, APP_SECRET))).statusCode).toBe(200);
    // Signed compact but sent pretty → rejected. Only possible if the raw
    // bytes survived to the verifier.
    expect((await post(raw, signPayload(compact, APP_SECRET))).statusCode).toBe(401);
  });

  it("does not do any queue or database work for a rejected delivery", async () => {
    await post(fixtureBytes("inbound-text.json"), "sha256=deadbeef");
    expect(deps.claimed).toHaveLength(0);
    expect(deps.enqueued).toHaveLength(0);
  });

  it("400s on a signed body that is not JSON, so Meta stops retrying", async () => {
    const response = await signedPost("not json at all");
    expect(response.statusCode).toBe(400);
  });
});

describe("POST /webhooks/whatsapp — dedup and enqueue", () => {
  it("enqueues one inbound job per new message", async () => {
    await signedPost(fixtureBytes("inbound-text.json"));

    expect(deps.enqueued).toHaveLength(1);
    expect(deps.enqueued[0]).toMatchObject({
      name: "inbound.process",
      data: { phoneNumberId: "100000000000002", kind: "text" },
    });
  });

  it("serialises timestamps, which do not survive a trip through Redis", async () => {
    await signedPost(fixtureBytes("inbound-text.json"));
    const data = deps.enqueued[0]?.data as { sentAt: unknown };
    expect(typeof data.sentAt).toBe("string");
    expect(new Date(data.sentAt as string).getTime()).toBe(1787059200 * 1000);
  });

  it("acks 200 and enqueues once on a replay — exactly what Meta does", async () => {
    const body = fixtureBytes("inbound-text.json");

    const first = await signedPost(body);
    const second = await signedPost(body);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ accepted: 1, duplicates: 0 });
    // 200, not 409: anything else and Meta keeps redelivering forever.
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ accepted: 0, duplicates: 1 });
    expect(deps.enqueued).toHaveLength(1);
  });

  it("gives each job a deterministic id, so BullMQ dedups a replay too", async () => {
    await signedPost(fixtureBytes("inbound-text.json"));
    const [job] = deps.enqueued;
    const waMessageId = (job?.data as { waMessageId: string }).waMessageId;

    expect(job?.jobId).toBe(`wa:${waMessageId}`);
    // Derived from the message id, so the same delivery always produces the
    // same job id — no clock, no counter, no randomness.
    expect(job?.jobId.startsWith("wa:wamid.")).toBe(true);
  });

  it("routes a delivery receipt to the status job", async () => {
    await signedPost(fixtureBytes("status-update.json"));
    expect(deps.enqueued[0]).toMatchObject({
      name: "inbound.status",
      data: { status: "delivered" },
    });
  });

  it("keeps the three stages of one message distinct when deduping", async () => {
    const delivered = fixtureBytes("status-update.json");
    const read = delivered.replace('"status": "delivered"', '"status": "read"');

    await signedPost(delivered);
    await signedPost(read);

    // Same wamid, different stage: both must get through.
    expect(deps.enqueued.map((j) => (j.data as { status: string }).status)).toEqual([
      "delivered",
      "read",
    ]);
  });

  it("records the media reference on an inbound voice note", async () => {
    await signedPost(fixtureBytes("inbound-audio.json"));
    expect(deps.enqueued[0]?.data).toMatchObject({
      kind: "audio",
      media: { mediaId: "980000000000001", voice: true },
    });
  });

  it("acks 200 with nothing enqueued for changes it cannot act on", async () => {
    const response = await signedPost(fixtureBytes("malformed.json"));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 0, duplicates: 0 });
    expect(deps.enqueued).toHaveLength(0);
  });

  it("acks 200 on an empty but well-formed body", async () => {
    const response = await signedPost("{}");
    expect(response.statusCode).toBe(200);
  });
});

describe("ack latency budget (hard rule 6)", () => {
  it("does exactly one database round trip, no matter how many messages", async () => {
    const body = fixtureBytes("inbound-text.json");
    await signedPost(body);
    // One claim call for the whole delivery — not one per message.
    expect(deps.claimed).toHaveLength(1);
  });

  it("acks well inside three seconds", async () => {
    // A pessimistic 50ms per database round trip; the point is that the
    // handler adds a bounded, tiny number of them.
    deps.claimDelayMs = 50;
    const started = Date.now();
    const response = await signedPost(fixtureBytes("inbound-text.json"));
    const elapsed = Date.now() - started;

    expect(response.statusCode).toBe(200);
    expect(elapsed).toBeLessThan(3_000);
  });

  it("never resolves a clinic or touches patient data in the handler", () => {
    // The dependency surface *is* the assertion: dedup and enqueue, nothing
    // else. Adding a lookup here means adding a method, which fails this.
    expect(Object.keys(deps).filter((k) => typeof (deps as never)[k] === "function")).toEqual([]);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(deps)).filter(
      (name) => name !== "constructor",
    );
    expect(methods.sort()).toEqual(["claim", "enqueue"]);
  });
});

describe("no PHI in logs (hard rule 4)", () => {
  it("logs counts and reasons, never the message body, name or number", async () => {
    await signedPost(fixtureBytes("inbound-text.json"));
    await signedPost(fixtureBytes("inbound-image.json"));
    await post(fixtureBytes("inbound-text.json"), "sha256=deadbeef");

    const emitted = logLines.join("\n");
    expect(emitted).not.toBe("");

    for (const phi of [
      "Habari, naomba appointment kesho asubuhi",
      "Hii ndio card yangu ya bima",
      "Amina Njeri",
      "Grace Mutiso",
      "254712000001",
      "+254712000001",
    ]) {
      expect(emitted, `leaked: ${phi}`).not.toContain(phi);
    }
  });

  it("never logs the signature header or the app secret", async () => {
    const body = fixtureBytes("inbound-text.json");
    await post(body, signPayload(body, APP_SECRET));
    await post(body, "sha256=deadbeef");

    const emitted = logLines.join("\n");
    expect(emitted).not.toContain(APP_SECRET);
    expect(emitted).not.toContain("deadbeef");
  });
});

describe("OpenAPI", () => {
  it("documents both webhook routes", () => {
    const document = app.swagger() as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(document.paths["/webhooks/whatsapp"] ?? {}).sort()).toEqual(["get", "post"]);
  });
});
