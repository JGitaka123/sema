/**
 * `@sema/scheduling` — availability, slot search, holds and booking rules.
 *
 * ARCHITECTURE.md §4 is the specification; `README.md` in this package records
 * the two decisions the spec left open (what the stored range covers, and
 * where the buffer lives).
 *
 * Everything is tenant-scoped: every function takes a `clinicId` and every
 * statement runs inside `withTenantDb`, so RLS is in force. No function here
 * reads across tenants.
 */

export * from "./availability.js";
export * from "./booking.js";
export {
  addDaysToKey,
  dateKeyInTz,
  endOfKey,
  instantAt,
  startOfKey,
  weekdayOfKey,
  type DateKey,
} from "./calendar.js";
export * from "./errors.js";
export * from "./holds.js";
export * from "./policy.js";
export * from "./ranking.js";
export * from "./scheduler.js";
export * from "./search.js";
export { alignToGrid, bookingHorizon, generateSlots, type SlotGenerationConfig } from "./slots.js";
export type { AppointmentRow, AuditEntry, HoldRow } from "./repository.js";
export * from "./types.js";
