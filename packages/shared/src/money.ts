import { AppError } from "./errors.js";

/**
 * Money is always integer minor units + a currency code (CLAUDE.md
 * §Conventions: "integers in minor units (`amount_minor`, `currency`). No
 * floats."). KES deposits are the v1 case; the type is currency-generic so the
 * later Western markets do not need a migration of the concept.
 */

export type CurrencyCode = "KES" | "USD" | "EUR" | "GBP" | "UGX" | "TZS" | "RWF";

/** Minor-unit exponent per ISO 4217. UGX/RWF are zero-decimal currencies. */
const EXPONENT: Record<CurrencyCode, number> = {
  KES: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  UGX: 0,
  TZS: 2,
  RWF: 0,
};

export interface Money {
  /** Integer. Negative is allowed (adjustments), fractional is not. */
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

export function currencyExponent(currency: CurrencyCode): number {
  return EXPONENT[currency];
}

/** Construct Money from minor units, rejecting floats up front. */
export function money(amountMinor: number, currency: CurrencyCode): Money {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new AppError("VALIDATION_FAILED", "Amount must be an integer number of minor units.", {
      meta: { currency, received: String(amountMinor) },
    });
  }
  return { amountMinor, currency };
}

/**
 * Build Money from a major-unit amount (what a human types into the inbox:
 * "500" KES). Rounds half-up to the currency's minor unit, then never touches
 * a float again.
 */
export function fromMajor(amountMajor: number, currency: CurrencyCode): Money {
  if (!Number.isFinite(amountMajor)) {
    throw new AppError("VALIDATION_FAILED", "Amount must be a finite number.", {
      meta: { currency },
    });
  }
  const factor = 10 ** EXPONENT[currency];
  return money(Math.round(amountMajor * factor), currency);
}

/** Major-unit number, for display or export only. Never store this. */
export function toMajor(value: Money): number {
  return value.amountMinor / 10 ** EXPONENT[value.currency];
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new AppError("VALIDATION_FAILED", "Cannot combine amounts in different currencies.", {
      meta: { left: a.currency, right: b.currency },
    });
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

/** Multiply by a plain factor (e.g. a 50% deposit), rounding half-up. */
export function multiplyMoney(value: Money, factor: number): Money {
  if (!Number.isFinite(factor)) {
    throw new AppError("VALIDATION_FAILED", "Factor must be a finite number.");
  }
  return money(Math.round(value.amountMinor * factor), value.currency);
}

export function compareMoney(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.amountMinor === b.amountMinor ? 0 : a.amountMinor < b.amountMinor ? -1 : 1;
}

export function isZero(value: Money): boolean {
  return value.amountMinor === 0;
}

/**
 * Patient-facing rendering. KES renders the way Kenyans read it on an M-Pesa
 * prompt ("KES 1,500"), i.e. no trailing ".00" when the amount is whole.
 */
export function formatMoney(value: Money, locale = "en-KE"): string {
  const exponent = EXPONENT[value.currency];
  const major = toMajor(value);
  const whole = value.amountMinor % 10 ** exponent === 0;
  const digits = whole ? 0 : exponent;
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(major);
  return `${value.currency} ${formatted}`;
}
