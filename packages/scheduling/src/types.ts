import type { Clock, Interval, TimeZone } from "@sema/shared";
import type { WithTenantDb } from "@sema/db";

/**
 * Shared vocabulary for the scheduling package.
 *
 * Ids are plain strings here rather than `PrefixedId<…>`: every entry point
 * validates them with `isId()` (see `errors.ts`), so the runtime check is the
 * guarantee and the types stay easy to pass around from Zod-parsed input.
 */

export type ProviderId = string;
export type ServiceId = string;
export type ClinicId = string;

/** Who is asking. Maps to `audit_log.actor` (DATA_MODEL.md). */
export type Actor =
  | { readonly kind: "agent" }
  | { readonly kind: "patient" }
  | { readonly kind: "staff"; readonly staffUserId: string }
  | { readonly kind: "system" };

/** `agent` | `patient` | `staff:<id>` | `system` — the audit_log encoding. */
export function actorToAudit(actor: Actor): string {
  return actor.kind === "staff" ? `staff:${actor.staffUserId}` : actor.kind;
}

/**
 * True when the clinic, not the patient, is driving the change. Drives the
 * cancellation status and means the patient is never penalised for it.
 */
export function isClinicInitiated(actor: Actor): boolean {
  return actor.kind === "staff" || actor.kind === "system";
}

/** How an appointment came to exist (`appointment.source`). */
export const BOOKING_SOURCES = ["agent", "staff", "walk_in"] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];

/** The statuses in which an appointment occupies its provider's calendar. */
export const OCCUPYING_STATUSES = ["booked", "confirmed", "arrived", "pending_deposit"] as const;

/** Statuses a patient or the clinic may still move away from. */
export const CHANGEABLE_STATUSES = ["pending_deposit", "booked", "confirmed"] as const;

/** The scheduling knobs that live on `clinic`. */
export interface ClinicSchedulingSettings {
  readonly timezone: TimeZone;
  readonly bookingWindowDays: number;
  readonly minNoticeMin: number;
  readonly slotGranularityMin: number;
  readonly currency: string;
  readonly cancellationPolicy: unknown;
}

/** The scheduling knobs that live on `service`. */
export interface ServiceSchedulingSettings {
  readonly id: ServiceId;
  readonly durationMin: number;
  readonly bufferMin: number;
  readonly depositMinor: number;
  readonly isActive: boolean;
  readonly patientBookable: boolean;
}

/**
 * A slot offered to a patient.
 *
 * `start`–`end` is what the patient is told. `blockEnd` is `end + buffer_min`,
 * the range actually written to `slot_hold.slot` / `appointment.slot`, and so
 * the range the Postgres exclusion constraints protect. Keeping the buffer
 * *inside* the stored range is what makes the database — not application
 * code — the guarantee that a provider is never double-booked through their
 * turnaround time.
 */
export interface Slot extends Interval {
  readonly providerId: ProviderId;
  readonly locationId: string | null;
  readonly blockEnd: Date;
}

/** The occupancy range of a slot: what goes into `slot`/`appointment.slot`. */
export function slotBlock(slot: Slot): Interval {
  return { start: slot.start, end: slot.blockEnd };
}

/** A period a provider is not available: appointment, hold or time off. */
export interface BusyInterval extends Interval {
  /** `null` means clinic-wide (a closure or public holiday). */
  readonly providerId: ProviderId | null;
  readonly kind: "appointment" | "hold" | "time_off";
}

/** Everything the package needs from the outside world. */
export interface SchedulingDeps {
  readonly withTenantDb: WithTenantDb;
  readonly clock: Clock;
}
