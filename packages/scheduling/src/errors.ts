import { AppError, isId, type IdEntity } from "@sema/shared";

/**
 * Typed failures for the scheduling package.
 *
 * CLAUDE.md: "typed `AppError` with `code`; never leak internals to WhatsApp
 * replies". Nothing here ever surfaces a Postgres message — an exclusion
 * constraint violation becomes `SLOT_UNAVAILABLE`, which the agent can turn
 * into "that time has just gone, here are three others".
 */

/** SQLSTATE 23P01 — `exclusion_violation`, raised by the GiST constraints. */
export const EXCLUSION_VIOLATION = "23P01";

export const slotUnavailable = (meta?: Record<string, string | number>): AppError =>
  new AppError("SLOT_UNAVAILABLE", "That time is no longer available.", { meta });

export const holdExpired = (holdId?: string): AppError =>
  new AppError("HOLD_EXPIRED", "That reservation has expired. Please pick a time again.", {
    meta: holdId ? { holdId } : undefined,
  });

export const notBookable = (reason: string, meta?: Record<string, string | number>): AppError =>
  new AppError("VALIDATION_FAILED", reason, { meta });

/**
 * Walk the `cause` chain for a Postgres SQLSTATE.
 *
 * `withTenant` wraps whatever the driver threw in an `AppError`, whose own
 * `code` is a word like `INTERNAL`, so the five-character shape test is what
 * distinguishes a real SQLSTATE from ours.
 */
export function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Run `work`, translating an exclusion-constraint violation into
 * `SLOT_UNAVAILABLE`. Everything else keeps its own typed error.
 *
 * This is the whole concurrency story: two agents racing for one slot both
 * insert, Postgres rejects exactly one, and the loser gets a domain error
 * rather than a driver error.
 */
export async function mapSlotConflict<T>(
  work: () => Promise<T>,
  meta?: Record<string, string | number>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (sqlState(error) === EXCLUSION_VIOLATION) throw slotUnavailable(meta);
    throw AppError.from(error);
  }
}

/** Reject an id of the wrong shape before it reaches SQL or a tenant GUC. */
export function assertId<E extends IdEntity>(entity: E, value: unknown, field: string): string {
  if (!isId(entity, value)) {
    throw new AppError("VALIDATION_FAILED", `${field} is not a valid ${entity} id.`);
  }
  return value;
}

export function assertPositiveInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError("VALIDATION_FAILED", `${field} must be a positive whole number.`);
  }
  return value;
}
