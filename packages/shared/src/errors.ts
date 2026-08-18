/**
 * Typed application errors.
 *
 * CLAUDE.md hard rule: "typed `AppError` with `code`; never leak internals to
 * WhatsApp replies". Every error therefore carries a stable machine `code`, an
 * HTTP status for the API boundary, and an `expose` flag. Only `expose: true`
 * messages may reach a patient or a staff UI; everything else is replaced with
 * a generic message at the boundary.
 */

export const ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "VALIDATION_FAILED",
  "RATE_LIMITED",
  "TENANT_MISSING",
  "TENANT_MISMATCH",
  "SLOT_UNAVAILABLE",
  "HOLD_EXPIRED",
  "PAYMENT_FAILED",
  "CHANNEL_SEND_FAILED",
  "UPSTREAM_UNAVAILABLE",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  TENANT_MISSING: 500,
  TENANT_MISMATCH: 403,
  SLOT_UNAVAILABLE: 409,
  HOLD_EXPIRED: 409,
  PAYMENT_FAILED: 402,
  CHANNEL_SEND_FAILED: 502,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export interface AppErrorOptions {
  /** HTTP status. Defaults to the status mapped from `code`. */
  status?: number;
  /** Safe to show to a user. Defaults to true for 4xx, false for 5xx. */
  expose?: boolean;
  /** Original error, kept for logs only — never serialised to a client. */
  cause?: unknown;
  /**
   * Structured, NON-PHI context for logs (ids, counts, codes).
   * Never put phone numbers, names or message bodies here (hard rule 4).
   */
  meta?: Record<string, string | number | boolean | null>;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly meta: Record<string, string | number | boolean | null> | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.expose = options.expose ?? this.status < 500;
    this.meta = options.meta;
    Error.captureStackTrace?.(this, AppError);
  }

  /** Shape returned over HTTP. Internal messages are swallowed deliberately. */
  toJSON(): { error: { code: ErrorCode; message: string } } {
    return {
      error: {
        code: this.code,
        message: this.expose ? this.message : "Something went wrong.",
      },
    };
  }

  static is(value: unknown): value is AppError {
    return value instanceof AppError;
  }

  /** Wrap anything thrown into an AppError without losing the original. */
  static from(value: unknown, fallback: ErrorCode = "INTERNAL"): AppError {
    if (AppError.is(value)) return value;
    const message = value instanceof Error ? value.message : "Unknown error";
    return new AppError(fallback, message, { cause: value });
  }
}

/** Convenience constructors for the codes used most often. */
export const badRequest = (m: string, o?: AppErrorOptions): AppError =>
  new AppError("BAD_REQUEST", m, o);
export const notFound = (m: string, o?: AppErrorOptions): AppError =>
  new AppError("NOT_FOUND", m, o);
export const forbidden = (m: string, o?: AppErrorOptions): AppError =>
  new AppError("FORBIDDEN", m, o);
export const conflict = (m: string, o?: AppErrorOptions): AppError =>
  new AppError("CONFLICT", m, o);
export const internal = (m: string, o?: AppErrorOptions): AppError =>
  new AppError("INTERNAL", m, o);
