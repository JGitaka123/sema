import { describe, expect, it } from "vitest";

import { AppError } from "./errors.js";
import {
  addMoney,
  compareMoney,
  formatMoney,
  fromMajor,
  isZero,
  money,
  multiplyMoney,
  subtractMoney,
  toMajor,
} from "./money.js";

describe("money", () => {
  it("stores minor units verbatim", () => {
    expect(money(150_000, "KES")).toEqual({ amountMinor: 150_000, currency: "KES" });
  });

  it("allows negative amounts for adjustments", () => {
    expect(money(-500, "KES").amountMinor).toBe(-500);
  });

  it("rejects fractional minor units", () => {
    expect(() => money(10.5, "KES")).toThrowError(AppError);
  });

  it("rejects NaN and Infinity", () => {
    expect(() => money(Number.NaN, "KES")).toThrowError(AppError);
    expect(() => money(Number.POSITIVE_INFINITY, "KES")).toThrowError(AppError);
  });
});

describe("fromMajor / toMajor", () => {
  it("converts KES major to minor units", () => {
    expect(fromMajor(1500, "KES").amountMinor).toBe(150_000);
  });

  it("handles zero-decimal currencies", () => {
    expect(fromMajor(1500, "UGX").amountMinor).toBe(1500);
  });

  it("rounds float input rather than storing it", () => {
    // 0.1 + 0.2 = 0.30000000000000004 — the exact bug integer minor units exist to avoid.
    expect(fromMajor(0.1 + 0.2, "KES").amountMinor).toBe(30);
  });

  it("round-trips", () => {
    expect(toMajor(fromMajor(1234.56, "KES"))).toBeCloseTo(1234.56, 10);
  });
});

describe("arithmetic", () => {
  it("adds and subtracts within a currency", () => {
    const a = fromMajor(1000, "KES");
    const b = fromMajor(500, "KES");
    expect(addMoney(a, b).amountMinor).toBe(150_000);
    expect(subtractMoney(a, b).amountMinor).toBe(50_000);
  });

  it("refuses to mix currencies", () => {
    expect(() => addMoney(fromMajor(10, "KES"), fromMajor(10, "USD"))).toThrowError(AppError);
    expect(() => subtractMoney(fromMajor(10, "KES"), fromMajor(10, "USD"))).toThrowError(AppError);
    expect(() => compareMoney(fromMajor(10, "KES"), fromMajor(10, "USD"))).toThrowError(AppError);
  });

  it("multiplies for a percentage deposit and stays integral", () => {
    // 30% deposit on KES 1,499 consultation.
    const deposit = multiplyMoney(fromMajor(1499, "KES"), 0.3);
    expect(Number.isSafeInteger(deposit.amountMinor)).toBe(true);
    expect(deposit.amountMinor).toBe(44_970);
  });

  it("compares and detects zero", () => {
    expect(compareMoney(fromMajor(1, "KES"), fromMajor(2, "KES"))).toBe(-1);
    expect(compareMoney(fromMajor(2, "KES"), fromMajor(1, "KES"))).toBe(1);
    expect(compareMoney(fromMajor(1, "KES"), fromMajor(1, "KES"))).toBe(0);
    expect(isZero(money(0, "KES"))).toBe(true);
  });
});

describe("formatMoney", () => {
  it("omits decimals for whole amounts, as on an M-Pesa prompt", () => {
    expect(formatMoney(fromMajor(1500, "KES"))).toBe("KES 1,500");
  });

  it("keeps decimals when there are cents", () => {
    expect(formatMoney(fromMajor(1500.5, "KES"))).toBe("KES 1,500.50");
  });

  it("formats zero-decimal currencies without a fraction", () => {
    expect(formatMoney(fromMajor(1500, "UGX"))).toBe("UGX 1,500");
  });
});
