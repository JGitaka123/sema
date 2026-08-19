import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { dedupKeys, parseWebhook, type InboundMessageEvent, type StatusEvent } from "./webhook.js";

/**
 * Contract tests against the recorded payloads in `fixtures/whatsapp/`
 * (docs/TESTING.md layer 3). If Meta changes a shape, these fail before
 * anything reaches a patient.
 */
const FIXTURES = new URL("../../../../fixtures/whatsapp/", import.meta.url);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, FIXTURES)), "utf8"));
}

const messages = (body: unknown): InboundMessageEvent[] =>
  parseWebhook(body).events.filter((e): e is InboundMessageEvent => e.type === "message");

const statuses = (body: unknown): StatusEvent[] =>
  parseWebhook(body).events.filter((e): e is StatusEvent => e.type === "status");

describe("inbound text", () => {
  const event = messages(fixture("inbound-text.json"))[0];

  it("flattens the envelope down to one routable event", () => {
    expect(event).toBeDefined();
    expect(event?.phoneNumberId).toBe("100000000000002");
    expect(event?.fromWaId).toBe("254712000001");
    expect(event?.kind).toBe("text");
    expect(event?.body).toBe("Habari, naomba appointment kesho asubuhi");
  });

  it("reads Meta's unix-seconds timestamp as a real instant", () => {
    expect(event?.sentAt.toISOString()).toBe(new Date(1787059200 * 1000).toISOString());
  });

  it("keeps the WhatsApp profile name available for the patient record", () => {
    expect(event?.profileName).toBe("Amina Njeri");
  });
});

describe("inbound audio", () => {
  const event = messages(fixture("inbound-audio.json"))[0];

  it("records the media reference without interpreting the content", () => {
    expect(event?.kind).toBe("audio");
    expect(event?.media).toMatchObject({
      mediaId: "980000000000001",
      mime: "audio/ogg; codecs=opus",
      voice: true,
    });
    // Transcription is Phase 4+; Phase 3 must not invent a body.
    expect(event?.body).toBeUndefined();
  });
});

describe("inbound image", () => {
  const event = messages(fixture("inbound-image.json"))[0];

  it("keeps the caption as the body and the image as an attachment", () => {
    expect(event?.kind).toBe("image");
    expect(event?.body).toBe("Hii ndio card yangu ya bima");
    expect(event?.media?.mediaId).toBe("980000000000002");
  });
});

describe("inbound interactive", () => {
  const event = messages(fixture("inbound-interactive.json"))[0];

  it("surfaces the option id, which is what the engine routes on", () => {
    expect(event?.kind).toBe("interactive");
    expect(event?.replyId).toBe("slot_2026-08-20T09:00:00Z");
    expect(event?.body).toBe("Thu 9:00 AM");
  });

  it("keeps the message it replied to, so a slot pick can be correlated", () => {
    expect(event?.contextWaMessageId).toBe(
      "wamid.HBgMMjU0NzA5MDAwMTAwFQIAERgSN0EwMDAwMDAwMDAwMDBBQgA=",
    );
  });
});

describe("status updates", () => {
  it("maps a delivery receipt onto our message status vocabulary", () => {
    const [event] = statuses(fixture("status-update.json"));
    expect(event).toMatchObject({
      status: "delivered",
      waMessageId: "wamid.HBgMMjU0NzA5MDAwMTAwFQIAERgSN0EwMDAwMDAwMDAwMDBBQgA=",
      phoneNumberId: "100000000000002",
    });
    expect(event?.errorCode).toBeUndefined();
  });

  it("carries Meta's error code on a failure so the outbox can classify it", () => {
    const [event] = statuses(fixture("status-failed.json"));
    expect(event?.status).toBe("failed");
    expect(event?.errorCode).toBe(131026);
  });
});

describe("payloads we cannot act on", () => {
  it("ignores changes rather than throwing — Meta redelivers anything non-200", () => {
    const parsed = parseWebhook(fixture("malformed.json"));
    // One change has no metadata (unroutable); the other is a template status
    // update we do not handle in Phase 3.
    expect(parsed.events).toHaveLength(0);
    expect(parsed.ignored).toBe(2);
  });

  it("survives arbitrary junk", () => {
    for (const body of [null, undefined, 42, "text", [], {}, { entry: "nope" }]) {
      expect(() => parseWebhook(body)).not.toThrow();
    }
    expect(parseWebhook({ entry: [] }).events).toHaveLength(0);
  });

  it("does not choke on fields Meta adds later", () => {
    const body = fixture("inbound-text.json") as Record<string, unknown>;
    const withExtras = { ...body, some_new_top_level_field: { nested: true } };
    expect(messages(withExtras)).toHaveLength(1);
  });

  it("records an unsupported message type as `system` rather than dropping it", () => {
    const events = messages({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "100000000000002" },
                messages: [
                  { id: "wamid.X", from: "254712000001", timestamp: "1787059200", type: "reaction" },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events[0]?.kind).toBe("system");
    expect(events[0]?.rawType).toBe("reaction");
  });
});

describe("dedupKeys", () => {
  it("dedups a message on its wamid, unqualified", () => {
    const events = messages(fixture("inbound-text.json"));
    expect(dedupKeys(events)).toEqual([events[0]?.waMessageId]);
  });

  it("qualifies a status by its stage, so delivered does not swallow read", () => {
    const one = statuses(fixture("status-update.json"));
    const keys = dedupKeys(one);
    expect(keys[0]).toContain(":delivered");
    expect(keys[0]).not.toBe(one[0]?.waMessageId);
  });
});
