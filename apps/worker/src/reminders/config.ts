/**
 * Reminder and digest configuration.
 *
 * SPEC §4.4: "Default: 24h and 2h before … Configurable per clinic and per
 * service." There is no `reminder_config` column in the Phase 1 data model, and
 * adding one would mean a migration on a schema three other phases are also
 * touching. So the knobs live in `clinic.flags` — the jsonb DATA_MODEL.md
 * already designates for per-clinic feature configuration — under a `reminders`
 * key, with a `services` map for per-service overrides:
 *
 * ```json
 * { "reminders": { "enabled": true, "pre24hMin": 1440, "pre2hMin": 120,
 *                  "noShowAfterMin": 30, "noShowRebook": true,
 *                  "services": { "svc_01J…": { "pre2hMin": null } } },
 *   "digests":   { "enabled": true, "morningHour": 7,
 *                  "ownerWeekday": 1, "ownerHour": 8 } }
 * ```
 *
 * Parsing never throws. A clinic that saved a malformed blob still gets its
 * reminders on the defaults; failing closed here would silently stop every
 * appointment reminder in that tenant, which is a worse outcome than ignoring
 * one bad field.
 */

/** The reminder kinds Phase 7 produces. `post_visit`/`recall` are Phase 2. */
export const PRE_VISIT_KINDS = ["pre_24h", "pre_2h"] as const;
export type PreVisitKind = (typeof PRE_VISIT_KINDS)[number];

export const REMINDER_KINDS = [...PRE_VISIT_KINDS, "no_show_rebook"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

export interface ReminderConfig {
  readonly enabled: boolean;
  /** Minutes before the appointment start. `null` disables that reminder. */
  readonly offsetsMin: Readonly<Record<PreVisitKind, number | null>>;
  /** Minutes after slot start with no arrival before we call it a no-show. */
  readonly noShowAfterMin: number;
  readonly noShowEnabled: boolean;
  /** Whether marking a no-show also queues the `rebook_after_no_show` nudge. */
  readonly noShowRebook: boolean;
}

export const DEFAULT_REMINDER_CONFIG: ReminderConfig = {
  enabled: true,
  offsetsMin: { pre_24h: 24 * 60, pre_2h: 2 * 60 },
  noShowAfterMin: 30,
  noShowEnabled: true,
  noShowRebook: true,
};

/**
 * Bounds, so a typo cannot schedule a reminder a decade out or a no-show sweep
 * that fires while the patient is still in the waiting room.
 */
const MAX_OFFSET_MIN = 30 * 24 * 60;
const MAX_NO_SHOW_AFTER_MIN = 24 * 60;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A positive whole number of minutes, or `null` to disable.
 *
 * `undefined` means "not configured here" and is distinct from `null`: an
 * override of `null` switches a reminder off, while a missing key inherits.
 */
function offset(value: unknown, max: number): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === false) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const minutes = Math.round(value);
  if (minutes <= 0 || minutes > max) return undefined;
  return minutes;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function merge(base: ReminderConfig, raw: Record<string, unknown> | undefined): ReminderConfig {
  if (!raw) return base;

  const pre24h = offset(raw["pre24hMin"], MAX_OFFSET_MIN);
  const pre2h = offset(raw["pre2hMin"], MAX_OFFSET_MIN);
  const after = offset(raw["noShowAfterMin"], MAX_NO_SHOW_AFTER_MIN);

  return {
    enabled: bool(raw["enabled"]) ?? base.enabled,
    offsetsMin: {
      pre_24h: pre24h === undefined ? base.offsetsMin.pre_24h : pre24h,
      pre_2h: pre2h === undefined ? base.offsetsMin.pre_2h : pre2h,
    },
    // `noShowAfterMin: null` would mean "never", which `noShowEnabled` already
    // expresses; keep the number and let the flag do the switching.
    noShowAfterMin: typeof after === "number" ? after : base.noShowAfterMin,
    noShowEnabled: bool(raw["noShowEnabled"]) ?? base.noShowEnabled,
    noShowRebook: bool(raw["noShowRebook"]) ?? base.noShowRebook,
  };
}

/**
 * Resolve the config for one appointment: defaults, then the clinic's
 * `flags.reminders`, then `flags.reminders.services[serviceId]`.
 */
export function parseReminderConfig(flags: unknown, serviceId?: string | null): ReminderConfig {
  const reminders = asRecord(asRecord(flags)?.["reminders"]);
  const clinicLevel = merge(DEFAULT_REMINDER_CONFIG, reminders);
  if (!serviceId) return clinicLevel;

  const perService = asRecord(asRecord(reminders?.["services"])?.[serviceId]);
  return merge(clinicLevel, perService);
}

// ── Digests ──────────────────────────────────────────────────────────────────

export interface DigestConfig {
  readonly enabled: boolean;
  /** Clinic-local hour (0–23) at which the staff morning digest goes out. */
  readonly morningHour: number;
  /** Clinic-local weekday for the owner digest. 0 = Sunday … 6 = Saturday. */
  readonly ownerWeekday: number;
  readonly ownerHour: number;
}

export const DEFAULT_DIGEST_CONFIG: DigestConfig = {
  enabled: true,
  morningHour: 7,
  ownerWeekday: 1,
  ownerHour: 8,
};

function hour(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const h = Math.round(value);
  return h >= 0 && h <= 23 ? h : fallback;
}

function weekday(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const d = Math.round(value);
  return d >= 0 && d <= 6 ? d : fallback;
}

export function parseDigestConfig(flags: unknown): DigestConfig {
  const raw = asRecord(asRecord(flags)?.["digests"]);
  if (!raw) return DEFAULT_DIGEST_CONFIG;
  return {
    enabled: bool(raw["enabled"]) ?? DEFAULT_DIGEST_CONFIG.enabled,
    morningHour: hour(raw["morningHour"], DEFAULT_DIGEST_CONFIG.morningHour),
    ownerWeekday: weekday(raw["ownerWeekday"], DEFAULT_DIGEST_CONFIG.ownerWeekday),
    ownerHour: hour(raw["ownerHour"], DEFAULT_DIGEST_CONFIG.ownerHour),
  };
}
