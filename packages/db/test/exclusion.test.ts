import { newId } from "@sema/shared";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createTenant,
  getHarness,
  slot,
  type Harness,
  type TenantFixture,
} from "./support/postgres.js";

/**
 * The constraints that make double-booking impossible (ARCHITECTURE.md §4).
 *
 * These are database guarantees on purpose: the booking path has at least two
 * concurrent writers (an agent turn and a staff member in the inbox), and
 * "check then insert" in application code loses that race. Phase 2 builds
 * `holdSlot`/`book` on top of what is asserted here.
 */

const maybeHarness = await getHarness();
const describeDb = maybeHarness ? describe : describe.skip;
const h = maybeHarness as Harness;

/** Postgres SQLSTATEs we assert on, rather than matching message text. */
const EXCLUSION_VIOLATION = "23P01";
const UNIQUE_VIOLATION = "23505";

/**
 * `withTenant` wraps failures in an AppError, so the driver error — and its
 * SQLSTATE — is one or more `cause` links down. AppError's own `code` is a word
 * like INTERNAL, which the 5-character shape test filters out.
 */
function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

async function expectSqlState(work: Promise<unknown>, expected: string): Promise<void> {
  const error = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected SQLSTATE ${expected}, but the statement succeeded`).toBeDefined();
  expect(sqlState(error)).toBe(expected);
}

describeDb("slot_hold overlap", () => {
  let t: TenantFixture;

  beforeAll(async () => {
    t = await createTenant(h, "holds");
  });

  const insertHold = (providerId: string, range: string, minutesToExpiry = 10) =>
    h.asOwner(t.clinicId, (client) =>
      client.query(
        `insert into slot_hold (id, clinic_id, provider_id, service_id, patient_id, slot, expires_at)
         values ($1, $2, $3, $4, $5, $6::tstzrange, now() + ($7 || ' minutes')::interval)`,
        [
          newId("slotHold"),
          t.clinicId,
          providerId,
          t.serviceId,
          t.patientId,
          range,
          minutesToExpiry,
        ],
      ),
    );

  it("rejects a second hold overlapping the same provider's slot", async () => {
    await insertHold(t.providerId, slot(0, 30));
    await expectSqlState(insertHold(t.providerId, slot(15, 45)), EXCLUSION_VIOLATION);
  });

  it("allows a back-to-back hold — ranges are half open", async () => {
    await insertHold(t.providerId, slot(120, 150));
    await expect(insertHold(t.providerId, slot(150, 180))).resolves.toBeDefined();
  });

  it("allows the same slot for a different provider", async () => {
    const other = newId("provider");
    await h.asOwner(t.clinicId, (client) =>
      client.query(
        `insert into provider (id, clinic_id, display_name) values ($1, $2, 'Dr. Two')`,
        [other, t.clinicId],
      ),
    );
    await insertHold(t.providerId, slot(300, 330));
    await expect(insertHold(other, slot(300, 330))).resolves.toBeDefined();
  });
});

describeDb("appointment overlap", () => {
  let t: TenantFixture;

  beforeAll(async () => {
    t = await createTenant(h, "appointments");
  });

  const insertAppointment = (range: string, status: string, providerId?: string) =>
    h.asOwner(t.clinicId, (client) =>
      client.query(
        `insert into appointment (id, clinic_id, patient_id, provider_id, service_id, slot, status)
         values ($1, $2, $3, $4, $5, $6::tstzrange, $7::appointment_status)`,
        [
          newId("appointment"),
          t.clinicId,
          t.patientId,
          providerId ?? t.providerId,
          t.serviceId,
          range,
          status,
        ],
      ),
    );

  it("rejects two booked appointments that overlap for one provider", async () => {
    await insertAppointment(slot(0, 30), "booked");
    await expectSqlState(insertAppointment(slot(20, 50), "confirmed"), EXCLUSION_VIOLATION);
  });

  it("covers every occupying status", async () => {
    await insertAppointment(slot(600, 630), "pending_deposit");
    for (const status of ["booked", "confirmed", "arrived", "pending_deposit"]) {
      await expectSqlState(insertAppointment(slot(610, 640), status), EXCLUSION_VIOLATION);
    }
  });

  it("lets history overlap: cancelled, completed, no-show and rescheduled rows do not block", async () => {
    await insertAppointment(slot(900, 930), "cancelled_by_patient");
    await expect(insertAppointment(slot(900, 930), "no_show")).resolves.toBeDefined();
    await expect(insertAppointment(slot(900, 930), "completed")).resolves.toBeDefined();
    // …and the slot is still bookable afterwards.
    await expect(insertAppointment(slot(900, 930), "booked")).resolves.toBeDefined();
  });

  it("does not constrain a different provider", async () => {
    const other = newId("provider");
    await h.asOwner(t.clinicId, (client) =>
      client.query(
        `insert into provider (id, clinic_id, display_name) values ($1, $2, 'Dr. Other')`,
        [other, t.clinicId],
      ),
    );
    await insertAppointment(slot(1200, 1230), "booked");
    await expect(insertAppointment(slot(1200, 1230), "booked", other)).resolves.toBeDefined();
  });
});

describeDb("inbound message dedup", () => {
  let t: TenantFixture;

  beforeAll(async () => {
    t = await createTenant(h, "dedup");
  });

  const insertMessage = (waMessageId: string | null) =>
    h.asOwner(t.clinicId, (client) =>
      client.query(
        `insert into message (id, clinic_id, conversation_id, direction, kind, body, wa_message_id)
         values ($1, $2, $3, 'in', 'text', 'hi', $4)`,
        [newId("message"), t.clinicId, t.conversationId, waMessageId],
      ),
    );

  it("rejects the same wa_message_id twice in one clinic", async () => {
    await insertMessage("wamid.TEST1");
    await expectSqlState(insertMessage("wamid.TEST1"), UNIQUE_VIOLATION);
  });

  it("allows many outbound messages with no wa_message_id yet", async () => {
    await expect(insertMessage(null)).resolves.toBeDefined();
    await expect(insertMessage(null)).resolves.toBeDefined();
  });
});
