import { describe, expect, it } from "vitest";

import { AppError } from "./errors.js";
import { isE164, maskPhone, normalisePhone, toWaId, tryNormalisePhone } from "./phone.js";

describe("normalisePhone (Kenya)", () => {
  it.each([
    ["0712345678", "+254712345678"],
    ["0112345678", "+254112345678"],
    ["712345678", "+254712345678"],
    ["254712345678", "+254712345678"],
    ["+254712345678", "+254712345678"],
    ["00254712345678", "+254712345678"],
  ])("normalises %s to %s", (input, expected) => {
    expect(normalisePhone(input)).toBe(expected);
  });

  it.each([
    ["+254 712 345 678"],
    ["0712 345 678"],
    ["0712-345-678"],
    ["(0712) 345678"],
    ["  0712345678  "],
    ["+254.712.345.678"],
    // Non-breaking spaces — phone keyboards and copy-paste out of WhatsApp
    // insert these. Written as escapes so the intent survives code review.
    ["+254\u00a0712\u00a0345\u00a0678"],
    ["0712\u00a0345\u00a0678"],
  ])("strips human formatting from %s", (input) => {
    expect(normalisePhone(input)).toBe("+254712345678");
  });

  it("accepts the wa_id form Meta sends on the webhook", () => {
    expect(normalisePhone("254798765432")).toBe("+254798765432");
  });
});

describe("tryNormalisePhone", () => {
  it.each([
    ["too short", "07123456"],
    ["too long", "07123456789"],
    ["landline prefix", "0202345678"],
    ["letters", "0712ABC678"],
    ["empty", ""],
    ["whitespace only", "   "],
    ["plus with no digits", "+"],
    ["kenyan code, invalid subscriber", "+254312345678"],
  ])("rejects %s", (_label, input) => {
    expect(tryNormalisePhone(input)).toBeUndefined();
  });

  it("rejects null and undefined without throwing", () => {
    expect(tryNormalisePhone(null)).toBeUndefined();
    expect(tryNormalisePhone(undefined)).toBeUndefined();
  });

  it("passes through valid non-Kenyan E.164 for multi-region support", () => {
    expect(tryNormalisePhone("+256772123456")).toBe("+256772123456");
    expect(tryNormalisePhone("+14155552671")).toBe("+14155552671");
  });

  it("does not guess a country for a bare foreign national number", () => {
    // Would be a UK number, but with defaultCountry KE it is not valid.
    expect(tryNormalisePhone("02079460958")).toBeUndefined();
  });
});

describe("normalisePhone errors", () => {
  it("throws a typed AppError that does not echo the raw number", () => {
    let thrown: unknown;
    try {
      normalisePhone("0712");
    } catch (error) {
      thrown = error;
    }
    expect(AppError.is(thrown)).toBe(true);
    const error = thrown as AppError;
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.expose).toBe(true);
    // Hard rule 4: personal data must not leak into messages or log meta.
    expect(error.message).not.toContain("0712");
    expect(JSON.stringify(error.meta)).not.toContain("0712");
  });
});

describe("isE164", () => {
  it("accepts normalised numbers and rejects local ones", () => {
    expect(isE164("+254712345678")).toBe(true);
    expect(isE164("0712345678")).toBe(false);
    expect(isE164("+0712345678")).toBe(false);
    expect(isE164(12345)).toBe(false);
  });
});

describe("maskPhone", () => {
  it("keeps only the country code and last three digits", () => {
    expect(maskPhone("+254712345678")).toBe("+254••••••678");
  });

  it("masks unnormalised input too", () => {
    expect(maskPhone("0712345678")).toBe("+254••••••678");
  });

  it("never returns the full number", () => {
    expect(maskPhone("+254712345678")).not.toContain("712345");
  });

  it("handles junk safely", () => {
    expect(maskPhone(null)).toBe("•••");
    expect(maskPhone("")).toBe("•••");
  });
});

describe("toWaId", () => {
  it("drops the leading plus", () => {
    expect(toWaId(normalisePhone("0712345678"))).toBe("254712345678");
  });
});
