import { AppError } from "@sema/shared";

import { loadSchedulingContext, slotsFrom } from "./context.js";
import { assertId } from "./errors.js";
import { rankSlots } from "./ranking.js";
import { loadProviderLoad } from "./repository.js";
import type { SchedulingDeps, Slot } from "./types.js";

/**
 * `searchSlots` — ARCHITECTURE.md §4.
 *
 * One tenant transaction, one pass of pure slot maths, one ranking. The whole
 * read happens inside `withTenantDb`, so RLS decides what is visible: a search
 * run for clinic A cannot see clinic B's providers, rules, holds or
 * appointments even if an id were passed by mistake.
 */

export const DEFAULT_SLOT_LIMIT = 20;
export const MAX_SLOT_LIMIT = 200;
/** Slot search never scans more than this, whatever `to` says. */
export const MAX_SEARCH_DAYS = 120;

export interface SearchSlotsInput {
  clinicId: string;
  serviceId: string;
  /** When given, only this provider's slots are returned. */
  providerId?: string | null;
  from: Date;
  to: Date;
  limit?: number;
  /** Staff booking may offer services that are not `patient_bookable`. */
  allowNonPatientBookable?: boolean;
}

export interface SearchSlotsResult {
  readonly slots: Slot[];
  /** How many slots existed before `limit` was applied. */
  readonly total: number;
  readonly timezone: string;
}

export async function searchSlots(
  deps: SchedulingDeps,
  input: SearchSlotsInput,
): Promise<SearchSlotsResult> {
  const clinicId = assertId("clinic", input.clinicId, "clinicId");
  const serviceId = assertId("service", input.serviceId, "serviceId");
  const providerId = input.providerId
    ? assertId("provider", input.providerId, "providerId")
    : undefined;

  const now = deps.clock.now();
  const from = new Date(Math.max(input.from.getTime(), now.getTime()));
  if (input.to <= from) {
    throw new AppError("VALIDATION_FAILED", "The search range must end after it starts.");
  }
  const to = new Date(
    Math.min(input.to.getTime(), from.getTime() + MAX_SEARCH_DAYS * 24 * 3_600_000),
  );

  const limit = Math.min(
    Math.max(1, Math.trunc(input.limit ?? DEFAULT_SLOT_LIMIT)),
    MAX_SLOT_LIMIT,
  );

  return deps.withTenantDb(clinicId, async (db) => {
    const context = await loadSchedulingContext(db, {
      clinicId,
      serviceId,
      providerId,
      from,
      to,
      now,
      allowNonPatientBookable: input.allowNonPatientBookable ?? false,
    });

    const slots = slotsFrom(context);
    if (slots.length === 0) {
      return { slots: [], total: 0, timezone: context.clinic.timezone };
    }

    const loadByProvider = await loadProviderLoad(db, clinicId, context.providerIds, from, to);
    const ranked = rankSlots({ slots, preferredProviderId: providerId, loadByProvider });

    return {
      slots: ranked.slice(0, limit),
      total: ranked.length,
      timezone: context.clinic.timezone,
    };
  });
}
