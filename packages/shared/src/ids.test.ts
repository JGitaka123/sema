import { describe, expect, it } from "vitest";

import { ID_PREFIXES, idBody, isId, newId, parseId } from "./ids.js";

describe("newId", () => {
  it("prefixes the entity and a 26-char ULID", () => {
    const id = newId("patient");
    expect(id).toMatch(/^pat_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("uses the documented prefixes", () => {
    expect(newId("appointment").startsWith("apt_")).toBe(true);
    expect(newId("conversation").startsWith("conv_")).toBe(true);
    expect(newId("clinic").startsWith("cli_")).toBe(true);
  });

  it("is unique across calls", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId("message")));
    expect(ids.size).toBe(1000);
  });

  it("has a distinct prefix per entity", () => {
    const prefixes = Object.values(ID_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("has no prefix that is itself a prefix of another", () => {
    const prefixes: string[] = Object.values(ID_PREFIXES);
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a === b) continue;
        expect(`${b}_`.startsWith(`${a}_`)).toBe(false);
      }
    }
  });
});

describe("isId", () => {
  it("accepts a matching id", () => {
    expect(isId("patient", newId("patient"))).toBe(true);
  });

  it("rejects an id of the wrong entity", () => {
    expect(isId("patient", newId("appointment"))).toBe(false);
  });

  it("rejects a bare ULID with no prefix", () => {
    expect(isId("patient", idBody(newId("patient")))).toBe(false);
  });

  it("rejects malformed bodies and non-strings", () => {
    expect(isId("patient", "pat_not-a-ulid")).toBe(false);
    expect(isId("patient", "pat_")).toBe(false);
    // I, L, O and U are excluded from Crockford base32.
    expect(isId("patient", "pat_IIIIIIIIIIIIIIIIIIIIIIIIII")).toBe(false);
    expect(isId("patient", 42)).toBe(false);
    expect(isId("patient", null)).toBe(false);
  });

  it("does not let a prefix that is a substring of another match", () => {
    // "pay" vs "pyr" — payment vs paymentRequest must not collide.
    expect(isId("payment", newId("paymentRequest"))).toBe(false);
    expect(isId("paymentRequest", newId("payment"))).toBe(false);
  });
});

describe("parseId", () => {
  it("returns the id when valid and undefined otherwise", () => {
    const id = newId("appointment");
    expect(parseId("appointment", id)).toBe(id);
    expect(parseId("appointment", "nope")).toBeUndefined();
  });
});

describe("idBody", () => {
  it("strips the prefix", () => {
    const id = newId("patient");
    expect(idBody(id)).toBe(id.slice("pat_".length));
  });

  it("is a no-op for unprefixed values", () => {
    expect(idBody("abc")).toBe("abc");
  });
});
