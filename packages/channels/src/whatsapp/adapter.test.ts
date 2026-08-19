import { AppError, type E164 } from "@sema/shared";
import { describe, expect, it } from "vitest";

import { WhatsAppChannel, type FetchLike, type HttpRequestInit, type HttpResponse } from "./adapter.js";
import { isWhatsAppError, META_ERROR_CODES, type WhatsAppError } from "./errors.js";

const TO = "+254712000001" as E164;
const TOKEN = "EAA-not-a-real-token";

interface Call {
  url: string;
  init: HttpRequestInit | undefined;
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
    arrayBuffer: () => {
      // `Buffer.from(...).buffer` hands back the whole shared 8KB pool, not
      // just these bytes. Copy, the way a real Response body does.
      const bytes = Buffer.from(text, "utf8");
      return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    },
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  };
}

/** A fetch that records calls and replays queued responses in order. */
function fakeFetch(...queued: HttpResponse[]): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...queued];
  const impl = ((url: string, init?: HttpRequestInit) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch to ${url}`);
    return Promise.resolve(next);
  }) as FetchLike & { calls: Call[] };
  impl.calls = calls;
  return impl;
}

const sendOk = () => response(200, { messages: [{ id: "wamid.SENT" }] });

function channel(fetchImpl: FetchLike): WhatsAppChannel {
  return new WhatsAppChannel({
    phoneNumberId: "100000000000002",
    accessToken: TOKEN,
    fetch: fetchImpl,
  });
}

describe("construction", () => {
  it("refuses to exist without a sender or a token", () => {
    expect(() => new WhatsAppChannel({ phoneNumberId: " ", accessToken: TOKEN })).toThrow(AppError);
    expect(
      () => new WhatsAppChannel({ phoneNumberId: "1", accessToken: "  " }),
    ).toThrow(AppError);
  });
});

describe("sending", () => {
  it("posts to /{version}/{phone_number_id}/messages with a bearer token", async () => {
    const fetchImpl = fakeFetch(sendOk());
    await channel(fetchImpl).sendText({ kind: "text", to: TO, body: "Karibu" });

    const [call] = fetchImpl.calls;
    expect(call?.url).toBe("https://graph.facebook.com/v20.0/100000000000002/messages");
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.headers?.["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(call?.init?.headers?.["content-type"]).toBe("application/json");
    expect(JSON.parse(call?.init?.body ?? "{}")).toMatchObject({
      messaging_product: "whatsapp",
      to: "254712000001",
      type: "text",
    });
  });

  it("honours a pinned Graph version", async () => {
    const fetchImpl = fakeFetch(sendOk());
    await new WhatsAppChannel({
      phoneNumberId: "1",
      accessToken: TOKEN,
      graphVersion: "v21.0",
      fetch: fetchImpl,
    }).sendText({ kind: "text", to: TO, body: "hi" });
    expect(fetchImpl.calls[0]?.url).toContain("/v21.0/");
  });

  it("returns the wamid, which is how a delivery receipt finds the message", async () => {
    const result = await channel(fakeFetch(sendOk())).sendText({
      kind: "text",
      to: TO,
      body: "hi",
    });
    expect(result).toEqual({ externalMessageId: "wamid.SENT" });
  });

  it("treats a 200 with no message id as a failure, not a success", async () => {
    await expect(
      channel(fakeFetch(response(200, { messages: [] }))).sendText({
        kind: "text",
        to: TO,
        body: "hi",
      }),
    ).rejects.toThrow(AppError);
  });

  it("dispatches send() on kind", async () => {
    const fetchImpl = fakeFetch(sendOk(), sendOk(), sendOk(), sendOk());
    const wa = channel(fetchImpl);
    await wa.send({ kind: "text", to: TO, body: "hi" });
    await wa.send({ kind: "interactive", to: TO, body: "pick", options: [{ id: "a", title: "A" }] });
    await wa.send({ kind: "template", to: TO, templateName: "appt_reminder_24h", language: "en" });
    await wa.send({ kind: "location", to: TO, latitude: -1.29, longitude: 36.78 });

    expect(fetchImpl.calls.map((c) => JSON.parse(c.init?.body ?? "{}").type)).toEqual([
      "text",
      "interactive",
      "template",
      "location",
    ]);
  });

  it("never puts the token in a thrown error", async () => {
    const fetchImpl = fakeFetch(response(401, { error: { code: 190, message: "bad token" } }));
    const error = await channel(fetchImpl)
      .sendText({ kind: "text", to: TO, body: "hi" })
      .catch((e: unknown) => e as WhatsAppError);
    expect(JSON.stringify({ m: error.message, meta: error.meta })).not.toContain(TOKEN);
  });
});

describe("Meta error mapping (INTEGRATIONS.md §1)", () => {
  const failWith = async (status: number, code: number): Promise<WhatsAppError> => {
    const fetchImpl = fakeFetch(response(status, { error: { code, fbtrace_id: "Atrace" } }));
    return (await channel(fetchImpl)
      .sendText({ kind: "text", to: TO, body: "hi" })
      .catch((e: unknown) => e)) as WhatsAppError;
  };

  it("131047 → needs a template: the 24h window has closed", async () => {
    const error = await failWith(400, META_ERROR_CODES.reEngagementRequired);
    expect(isWhatsAppError(error)).toBe(true);
    expect(error.kind).toBe("needs_template");
    expect(error.needsTemplate).toBe(true);
    expect(error.retryable).toBe(false);
  });

  it("131026 → undeliverable: stop trying", async () => {
    const error = await failWith(400, META_ERROR_CODES.undeliverable);
    expect(error.kind).toBe("undeliverable");
    expect(error.retryable).toBe(false);
    expect(error.needsTemplate).toBe(false);
  });

  it("130429 → rate limited: back off and retry", async () => {
    const error = await failWith(400, META_ERROR_CODES.rateLimit);
    expect(error.kind).toBe("rate_limited");
    expect(error.retryable).toBe(true);
  });

  it("190 → auth: retrying will not help until the number is reconnected", async () => {
    const error = await failWith(401, META_ERROR_CODES.authExpired);
    expect(error.kind).toBe("auth");
    expect(error.retryable).toBe(false);
  });

  it("falls back to the HTTP status when the body has no code", async () => {
    const fetchImpl = fakeFetch(response(503, "<html>bad gateway</html>"));
    const error = (await channel(fetchImpl)
      .sendText({ kind: "text", to: TO, body: "hi" })
      .catch((e: unknown) => e)) as WhatsAppError;
    expect(error.kind).toBe("transient");
    expect(error.retryable).toBe(true);
  });

  it("keeps Meta's trace id, which is the only useful thing in a support ticket", async () => {
    const error = await failWith(400, META_ERROR_CODES.rateLimit);
    expect(error.details.traceId).toBe("Atrace");
    expect(error.details.code).toBe(META_ERROR_CODES.rateLimit);
  });

  it("classifies a transport failure as transient", async () => {
    const fetchImpl = (() => Promise.reject(new Error("ECONNRESET"))) as FetchLike;
    const error = (await channel(fetchImpl)
      .sendText({ kind: "text", to: TO, body: "hi" })
      .catch((e: unknown) => e)) as WhatsAppError;
    expect(error.kind).toBe("transient");
    expect(error.retryable).toBe(true);
  });

  it("never repeats Meta's prose, which can echo the recipient number", async () => {
    const fetchImpl = fakeFetch(
      response(400, {
        error: { code: 131026, message: "Message undeliverable to 254712000001" },
      }),
    );
    const error = (await channel(fetchImpl)
      .sendText({ kind: "text", to: TO, body: "hi" })
      .catch((e: unknown) => e)) as WhatsAppError;
    expect(error.message).not.toContain("254712000001");
  });
});

describe("downloadMedia", () => {
  it("resolves the media url, then fetches it with the bearer token", async () => {
    const fetchImpl = fakeFetch(
      response(200, {
        url: "https://lookaside.fbsbx.com/whatsapp/media/980000000000001",
        mime_type: "audio/ogg; codecs=opus",
        sha256: "abc",
        file_size: 5,
      }),
      response(200, "audio", { "content-type": "audio/ogg" }),
    );

    const media = await channel(fetchImpl).downloadMedia("980000000000001");

    expect(fetchImpl.calls[0]?.url).toBe(
      "https://graph.facebook.com/v20.0/980000000000001",
    );
    expect(fetchImpl.calls[1]?.url).toBe(
      "https://lookaside.fbsbx.com/whatsapp/media/980000000000001",
    );
    // The signed CDN url still requires the token — a plain GET 401s.
    expect(fetchImpl.calls[1]?.init?.headers?.["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(media.mime).toBe("audio/ogg");
    expect(Buffer.from(media.bytes).toString("utf8")).toBe("audio");
    expect(media.sha256).toBe("abc");
  });

  it("refuses media larger than we accept, before downloading it", async () => {
    const fetchImpl = fakeFetch(
      response(200, { url: "https://cdn.example/x", file_size: 100 * 1024 * 1024 }),
    );
    await expect(channel(fetchImpl).downloadMedia("1")).rejects.toThrow(AppError);
    // Only the metadata call happened: we never pulled the bytes.
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it("rejects an empty media id", async () => {
    await expect(channel(fakeFetch()).downloadMedia("  ")).rejects.toThrow(AppError);
  });

  it("fails when Meta returns no url", async () => {
    await expect(channel(fakeFetch(response(200, {}))).downloadMedia("1")).rejects.toThrow(
      AppError,
    );
  });
});

describe("markRead", () => {
  it("marks the message read", async () => {
    const fetchImpl = fakeFetch(response(200, { success: true }));
    await channel(fetchImpl).markRead("wamid.ABC");
    expect(JSON.parse(fetchImpl.calls[0]?.init?.body ?? "{}")).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.ABC",
    });
  });

  it("swallows failures — a blue tick must never replay an inbound message", async () => {
    await expect(
      channel(fakeFetch(response(500, { error: { code: 1 } }))).markRead("wamid.ABC"),
    ).resolves.toBeUndefined();
    await expect(channel(fakeFetch()).markRead("  ")).resolves.toBeUndefined();
  });
});
