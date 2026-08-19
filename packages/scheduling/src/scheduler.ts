import { systemClock, type Clock } from "@sema/shared";

import { book, cancel, reschedule } from "./booking.js";
import { expireHolds, holdSlot } from "./holds.js";
import { searchSlots } from "./search.js";
import type { SchedulingDeps } from "./types.js";

/**
 * The package's public surface, bound to a set of dependencies.
 *
 * Everything takes `SchedulingDeps` explicitly rather than reaching for a
 * module-level pool: integration tests bind the harness's `withTenantDb`, and
 * unit tests of the policy and slot maths need no database at all. The default
 * binding below is the one the API and workers use.
 */

export interface Scheduler {
  searchSlots: (input: Parameters<typeof searchSlots>[1]) => ReturnType<typeof searchSlots>;
  holdSlot: (input: Parameters<typeof holdSlot>[1]) => ReturnType<typeof holdSlot>;
  book: (input: Parameters<typeof book>[1]) => ReturnType<typeof book>;
  reschedule: (input: Parameters<typeof reschedule>[1]) => ReturnType<typeof reschedule>;
  cancel: (input: Parameters<typeof cancel>[1]) => ReturnType<typeof cancel>;
  expireHolds: (input: Parameters<typeof expireHolds>[1]) => ReturnType<typeof expireHolds>;
}

export function createScheduler(deps: SchedulingDeps): Scheduler {
  return {
    searchSlots: (input) => searchSlots(deps, input),
    holdSlot: (input) => holdSlot(deps, input),
    book: (input) => book(deps, input),
    reschedule: (input) => reschedule(deps, input),
    cancel: (input) => cancel(deps, input),
    expireHolds: (input) => expireHolds(deps, input),
  };
}

/**
 * A scheduler on the process-wide pool from `@sema/db`.
 *
 * Lazily created: importing this module must not open a socket, so a build or
 * a `--help` never needs `DATABASE_URL`.
 */
let cached: Scheduler | undefined;

export async function defaultScheduler(clock: Clock = systemClock): Promise<Scheduler> {
  if (!cached) {
    const { withTenantDb } = await import("@sema/db");
    cached = createScheduler({ withTenantDb, clock });
  }
  return cached;
}

/** Test seam: drop the cached default scheduler. */
export function resetDefaultScheduler(): void {
  cached = undefined;
}
