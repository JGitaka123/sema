import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { signPayload, verifyHandshake, verifySignature } from "./signature.js";

const SECRET = "app-secret-not-a-real-one";

describe("verifySignature", () => {
  it("accepts a signature Meta would have produced", () => {
    const body = Buffer.from('{"object":"whatsapp_business_account"}', "utf8");
    expect(verifySignature(body, signPayload(body, SECRET), SECRET)).toEqual({ ok: true });
  });

  it("verifies the RAW bytes, not a re-serialised parse of them", () => {
    // This is the bug this whole module exists to prevent. Meta signs bytes;
    // JSON.parse → JSON.stringify changes key order, spacing and unicode
    // escaping, so a re-serialised body has a different HMAC.
    const raw = Buffer.from(
      '{ "object" : "whatsapp_business_account",\n  "entry": [ { "id": "1" } ] }',
      "utf8",
    );
    const header = signPayload(raw, SECRET);

    expect(verifySignature(raw, header, SECRET)).toEqual({ ok: true });

    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString("utf8"))), "utf8");
    expect(reserialised.equals(raw)).toBe(false);
    expect(verifySignature(reserialised, header, SECRET)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("is byte-exact: one flipped character fails", () => {
    const body = Buffer.from('{"a":1}', "utf8");
    const header = signPayload(body, SECRET);
    expect(verifySignature(Buffer.from('{"a":2}', "utf8"), header, SECRET)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects a signature made with a different secret", () => {
    const body = Buffer.from('{"a":1}', "utf8");
    expect(verifySignature(body, signPayload(body, "someone-elses-secret"), SECRET)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects a missing header — absence is never valid (ARCHITECTURE.md §9)", () => {
    const body = Buffer.from('{"a":1}', "utf8");
    expect(verifySignature(body, undefined, SECRET)).toEqual({
      ok: false,
      reason: "missing_header",
    });
    expect(verifySignature(body, "", SECRET)).toEqual({ ok: false, reason: "missing_header" });
  });

  it("rejects a header without the sha256= prefix", () => {
    const body = Buffer.from('{"a":1}', "utf8");
    const bare = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifySignature(body, bare, SECRET)).toEqual({ ok: false, reason: "malformed_header" });
    expect(verifySignature(body, `sha1=${bare}`, SECRET)).toEqual({
      ok: false,
      reason: "malformed_header",
    });
  });

  it("rejects a truncated or non-hex digest without throwing", () => {
    const body = Buffer.from('{"a":1}', "utf8");
    // timingSafeEqual throws on length mismatch; catching that here rather
    // than in production is the point of the pre-checks.
    expect(verifySignature(body, "sha256=abc", SECRET)).toEqual({
      ok: false,
      reason: "malformed_header",
    });
    expect(verifySignature(body, `sha256=${"z".repeat(64)}`, SECRET)).toEqual({
      ok: false,
      reason: "malformed_header",
    });
  });

  it("fails closed when no app secret is configured", () => {
    const body = Buffer.from('{"a":1}', "utf8");
    expect(verifySignature(body, signPayload(body, SECRET), undefined)).toEqual({
      ok: false,
      reason: "missing_secret",
    });
    expect(verifySignature(body, signPayload(body, ""), "")).toEqual({
      ok: false,
      reason: "missing_secret",
    });
  });

  it("accepts an uppercase digest, since hex case is not meaningful", () => {
    const body = Buffer.from('{"a":1}', "utf8");
    const header = signPayload(body, SECRET).toUpperCase().replace("SHA256=", "sha256=");
    expect(verifySignature(body, header, SECRET)).toEqual({ ok: true });
  });

  it("takes the first value when a header arrives more than once", () => {
    const body = Buffer.from('{"a":1}', "utf8");
    expect(verifySignature(body, [signPayload(body, SECRET), "sha256=junk"], SECRET)).toEqual({
      ok: true,
    });
  });

  it("handles an empty body", () => {
    const body = Buffer.alloc(0);
    expect(verifySignature(body, signPayload(body, SECRET), SECRET)).toEqual({ ok: true });
  });
});

describe("verifyHandshake", () => {
  const TOKEN = "verify-token-abc";

  it("echoes the challenge for a correct subscribe handshake", () => {
    expect(
      verifyHandshake({ mode: "subscribe", token: TOKEN, challenge: "1158201444" }, TOKEN),
    ).toBe("1158201444");
  });

  it("refuses a wrong token", () => {
    expect(
      verifyHandshake({ mode: "subscribe", token: "wrong-token-abc", challenge: "1" }, TOKEN),
    ).toBeUndefined();
  });

  it("refuses a token of a different length without throwing", () => {
    expect(verifyHandshake({ mode: "subscribe", token: "short", challenge: "1" }, TOKEN)).toBe(
      undefined,
    );
  });

  it("refuses a mode other than subscribe", () => {
    expect(
      verifyHandshake({ mode: "unsubscribe", token: TOKEN, challenge: "1" }, TOKEN),
    ).toBeUndefined();
  });

  it("refuses when the challenge is missing", () => {
    expect(verifyHandshake({ mode: "subscribe", token: TOKEN }, TOKEN)).toBeUndefined();
  });

  it("fails closed with no configured token", () => {
    expect(
      verifyHandshake({ mode: "subscribe", token: TOKEN, challenge: "1" }, undefined),
    ).toBeUndefined();
  });
});
