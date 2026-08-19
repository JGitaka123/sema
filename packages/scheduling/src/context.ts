import type { TenantDb } from "@sema/db";
import { AppError } from "@sema/shared";

import { expandAvailability, type AvailabilityWindow } from "./availability.js";
import { notBookable } from "./errors.js";
import {
  loadAvailabilityRules,
  loadBusy,
  loadClinicSettings,
  loadProviderIds,
  loadService,
} from "./repository.js";
import { generateSlots, type SlotGenerationConfig } from "./slots.js";
import type {
  BusyInterval,
  ClinicSchedulingSettings,
  ProviderId,
  ServiceSchedulingSettings,
  Slot,
} from "./types.js";

/**
 * The read side shared by `searchSlots` and `holdSlot`.
 *
 * `holdSlot` re-runs exactly the same generation for the requested day and
 * requires an exact match, so a caller — the agent especially — cannot invent
 * a time that slot search would never have offered. One code path, one set of
 * rules.
 */

export interface SchedulingContext {
  readonly clinic: ClinicSchedulingSettings;
  readonly service: ServiceSchedulingSettings;
  readonly providerIds: readonly ProviderId[];
  readonly windows: readonly AvailabilityWindow[];
  readonly busy: readonly BusyInterval[];
  readonly config: SlotGenerationConfig;
}

export interface LoadContextInput {
  clinicId: string;
  serviceId: string;
  providerId?: string | null;
  from: Date;
  to: Date;
  now: Date;
  /** Skip the `patient_bookable` check for staff-driven booking (Phase 8). */
  allowNonPatientBookable?: boolean;
}

export async function loadSchedulingContext(
  db: TenantDb,
  input: LoadContextInput,
): Promise<SchedulingContext> {
  const clinic = await loadClinicSettings(db, input.clinicId);
  const service = await loadService(db, input.clinicId, input.serviceId);

  if (!service.isActive) throw notBookable("That service is not currently offered.");
  if (!service.patientBookable && !input.allowNonPatientBookable) {
    throw notBookable("That service cannot be booked without speaking to the clinic.");
  }
  if (service.durationMin <= 0) {
    throw new AppError("VALIDATION_FAILED", "Service duration is not configured.");
  }

  const providerIds = await loadProviderIds(
    db,
    input.clinicId,
    input.serviceId,
    input.providerId ?? null,
  );

  const windows =
    providerIds.length === 0
      ? []
      : expandAvailability(await loadAvailabilityRules(db, input.clinicId, providerIds), {
          timezone: clinic.timezone,
          from: input.from,
          to: input.to,
        });

  const busy = await loadBusy(db, input.clinicId, providerIds, input.from, input.to);

  return {
    clinic,
    service,
    providerIds,
    windows,
    busy,
    config: {
      timezone: clinic.timezone,
      from: input.from,
      to: input.to,
      now: input.now,
      durationMin: service.durationMin,
      bufferMin: service.bufferMin,
      granularityMin: clinic.slotGranularityMin,
      minNoticeMin: clinic.minNoticeMin,
      bookingWindowDays: clinic.bookingWindowDays,
    },
  };
}

export function slotsFrom(context: SchedulingContext): Slot[] {
  return generateSlots({ windows: context.windows, busy: context.busy, config: context.config });
}
