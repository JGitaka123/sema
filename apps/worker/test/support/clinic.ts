import { createWithTenantDb, type TenantPool } from "@sema/db";
import { createScheduler, type Scheduler } from "@sema/scheduling";
import { fixedClock, newId, type PrefixedId } from "@sema/shared";

import type { Harness } from "./db.js";

/**
 * A clinic that can actually be booked, for the Phase 7 suites.
 *
 * Built on the worker's own harness (`./db.ts`) rather than importing
 * `packages/scheduling`'s fixture: that one hangs off `packages/db`'s harness
 * and its unprivileged probe role, which exists to prove RLS. These tests are
 * about reminder behaviour, and reaching across two packages' test directories
 * to get a provider row would be a sign the seam is in the wrong place.
 */

/** Saturday 2030-01-05, 15:00 Africa/Nairobi. Two days before the fixture slot. */
export const CLOCK_NOW = new Date("2030-01-05T12:00:00Z");
/** Monday 2030-01-07, 09:00 Africa/Nairobi. */
export const MONDAY_0900 = new Date("2030-01-07T06:00:00Z");

export interface ClinicFixture {
  clinicId: PrefixedId<"clinic">;
  locationId: PrefixedId<"location">;
  providerId: PrefixedId<"provider">;
  serviceId: PrefixedId<"service">;
  patientId: PrefixedId<"patient">;
  conversationId: PrefixedId<"conversation">;
  ownerId: PrefixedId<"user">;
  patientPhone: string;
  patientName: string;
  scheduler: Scheduler;
}

export interface CreateClinicOptions {
  /** Overrides `clinic.flags`, where the reminder/digest config lives. */
  flags?: Record<string, unknown>;
  /** The moment the scheduler believes it is. */
  now?: Date;
  timezone?: string;
}

export async function createClinic(
  harness: Harness,
  label: string,
  options: CreateClinicOptions = {},
): Promise<ClinicFixture> {
  const suffix = String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  const fixture = {
    clinicId: newId("clinic"),
    locationId: newId("location"),
    providerId: newId("provider"),
    serviceId: newId("service"),
    patientId: newId("patient"),
    conversationId: newId("conversation"),
    ownerId: newId("user"),
    patientPhone: `+2547${suffix}`,
    // A distinctive, obviously-fake name: the PHI assertions grep for it.
    patientName: `Wanjiru ${label}`,
  };

  await harness.raw(async (client) => {
    await client.query("begin");
    try {
      await client.query(
        `insert into clinic (id, name, slug, timezone, currency, flags, cancellation_policy)
         values ($1, $2, $3, $4, 'KES', $5::jsonb,
                 '{"free_reschedule_hours":24,"forfeit_hours":2}'::jsonb)`,
        [
          fixture.clinicId,
          `Test ${label}`,
          `test-${label}-${fixture.clinicId.slice(-8)}`,
          options.timezone ?? "Africa/Nairobi",
          JSON.stringify(options.flags ?? {}),
        ],
      );
      await client.query(
        `insert into clinic_whatsapp
           (id, clinic_id, waba_id, phone_number_id, display_phone_number, access_token_encrypted)
         values ($1, $2, $3, $4, '+254700000000', 'placeholder-token')`,
        [newId("clinicWhatsapp"), fixture.clinicId, `waba-${suffix}`, `pnid-${label}-${suffix}`],
      );
      await client.query(`insert into location (id, clinic_id, name) values ($1, $2, $3)`, [
        fixture.locationId,
        fixture.clinicId,
        `${label} Westlands`,
      ]);
      await client.query(
        `insert into staff_user (id, clinic_id, email, name, role, phone)
         values ($1, $2, $3, 'Dr. Owner', 'owner', $4)`,
        [fixture.ownerId, fixture.clinicId, `owner-${suffix}@example.test`, `+2547${suffix}`],
      );
      await client.query(
        `insert into provider (id, clinic_id, display_name) values ($1, $2, 'Dr. Otieno')`,
        [fixture.providerId, fixture.clinicId],
      );
      await client.query(
        `insert into service (id, clinic_id, name, duration_min, buffer_min, price_minor, deposit_minor)
         values ($1, $2, 'Consultation', 20, 0, 200000, 0)`,
        [fixture.serviceId, fixture.clinicId],
      );
      await client.query(
        `insert into provider_service (clinic_id, provider_id, service_id) values ($1, $2, $3)`,
        [fixture.clinicId, fixture.providerId, fixture.serviceId],
      );
      // Monday–Saturday, 09:00–17:00 clinic-local.
      for (let weekday = 1; weekday <= 6; weekday += 1) {
        await client.query(
          `insert into availability_rule
             (id, clinic_id, provider_id, location_id, weekday, start_local, end_local)
           values ($1, $2, $3, $4, $5, '09:00', '17:00')`,
          [
            newId("availabilityRule"),
            fixture.clinicId,
            fixture.providerId,
            fixture.locationId,
            weekday,
          ],
        );
      }
      await client.query(
        `insert into patient (id, clinic_id, phone_e164, wa_id, full_name, language)
         values ($1, $2, $3, $4, $5, 'en')`,
        [
          fixture.patientId,
          fixture.clinicId,
          fixture.patientPhone,
          fixture.patientPhone.slice(1),
          fixture.patientName,
        ],
      );
      await client.query(
        `insert into conversation (id, clinic_id, patient_id, last_message_at)
         values ($1, $2, $3, now())`,
        [fixture.conversationId, fixture.clinicId, fixture.patientId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });

  return {
    ...fixture,
    scheduler: schedulerAt(harness, options.now ?? CLOCK_NOW),
  };
}

/** The scheduler, seen from a chosen moment. Time travel for booking policy. */
export function schedulerAt(harness: Harness, now: Date): Scheduler {
  return createScheduler({
    withTenantDb: createWithTenantDb(harness.pool as unknown as TenantPool),
    clock: fixedClock(now),
  });
}

/** Book `start` for the fixture patient, going through hold → book. */
export async function bookAt(
  fixture: ClinicFixture,
  start: Date,
  scheduler: Scheduler = fixture.scheduler,
): Promise<string> {
  const hold = await scheduler.holdSlot({
    clinicId: fixture.clinicId,
    providerId: fixture.providerId,
    serviceId: fixture.serviceId,
    patientId: fixture.patientId,
    conversationId: fixture.conversationId,
    start,
  });
  const booked = await scheduler.book({
    clinicId: fixture.clinicId,
    holdId: hold.holdId,
    patientId: fixture.patientId,
    source: "agent",
  });
  return booked.appointment.id;
}
