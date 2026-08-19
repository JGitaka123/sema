import { fixedClock, type PrefixedId } from "@sema/shared";
import { describe, expect, it } from "vitest";

import {
  assertNoPhi,
  createRecordingDigestDelivery,
  createRecordingLogger,
  loadOwnerWeeklyMetrics,
  loadStaffMorningDigest,
  markNoShows,
  morningDigestWindow,
  runClinicDigests,
  sendDueReminders,
  syncAppointmentReminders,
  weeklyDigestWindow,
} from "../src/reminders/index.js";
import { runDigestSweep, runNoShowSweep, runReminderSend } from "../src/jobs/reminders.js";
import { getHarness, tenantRows, type Harness } from "./support/db.js";
import {
  bookAt,
  createClinic,
  schedulerAt,
  CLOCK_NOW,
  MONDAY_0900,
  type ClinicFixture,
} from "./support/clinic.js";

/**
 * Reminders, no-shows and digests against real Postgres (docs/TESTING.md layer
 * 2, BUILD_PLAN Phase 7: "time-travel tests using fake clock").
 *
 * The unit suites prove the *decisions* — when a reminder is due, whether it may
 * be sent, where a week begins. This one proves the SQL: the `for update skip
 * locked` claims that make a sweep idempotent, the jsonb increment on
 * `patient.flags`, the status transitions, the audit rows, and the fact that a
 * reminder actually lands in `outbox` as a template.
 *
 * Skips cleanly when no Postgres is reachable; CI always has one.
 */

/**
 * Top-level await, so the decision to skip is made during collection — a
 * `beforeAll` would run *after* the describe bodies had already been built, and
 * the whole suite would silently register as skipped. Same shape as
 * `packages/scheduling/test/booking.test.ts`.
 *
 * The harness caches its pool per process and the integration project runs
 * single-threaded, so there is nothing to close here that the process exit does
 * not already handle.
 */
const maybeHarness = await getHarness();
const describeDb = maybeHarness ? describe : describe.skip;
const harness = maybeHarness;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface ReminderRow {
  id: string;
  kind: string;
  status: string;
  due_at: string;
  sent_message_id: string | null;
}

describeDb("reminders (Postgres)", () => {
  {
    const h = (): Harness => {
      if (!harness) throw new Error("no harness");
      return harness;
    };

    const deps = (now: Date) => ({ withTenant: h().withTenant, now: () => now });

    const sweepDeps = (now: Date, clinicId: string) => ({
      withTenant: h().withTenant,
      clock: fixedClock(now),
      listClinicIds: async (): Promise<string[]> => [clinicId],
    });

    const reminders = (fixture: ClinicFixture, appointmentId?: string): Promise<ReminderRow[]> =>
      tenantRows<ReminderRow>(
        h(),
        fixture.clinicId,
        appointmentId
          ? `select id, kind::text as kind, status, due_at, sent_message_id
               from reminder where appointment_id = $1 order by due_at`
          : `select id, kind::text as kind, status, due_at, sent_message_id
               from reminder order by due_at`,
        appointmentId ? [appointmentId] : [],
      );

    const sync = (fixture: ClinicFixture, appointmentId: string, now: Date) =>
      h().withTenant(fixture.clinicId, (client) =>
        syncAppointmentReminders(client, { clinicId: fixture.clinicId, appointmentId, now }),
      );

    // ── Lifecycle ────────────────────────────────────────────────────────────

    describe("scheduling on the appointment lifecycle", () => {
      it("creates a 24h and a 2h reminder when an appointment is booked", async () => {
        const fixture = await createClinic(h(), "book");
        const appointmentId = await bookAt(fixture, MONDAY_0900);

        const result = await sync(fixture, appointmentId, CLOCK_NOW);
        expect(result.created).toBe(2);

        const rows = await reminders(fixture, appointmentId);
        expect(rows.map((r) => r.kind)).toEqual(["pre_24h", "pre_2h"]);
        expect(rows.every((r) => r.status === "scheduled")).toBe(true);
        expect(new Date(rows[0]!.due_at).getTime()).toBe(MONDAY_0900.getTime() - 24 * HOUR);
        expect(new Date(rows[1]!.due_at).getTime()).toBe(MONDAY_0900.getTime() - 2 * HOUR);
      });

      it("is idempotent — reconciling twice creates nothing the second time", async () => {
        const fixture = await createClinic(h(), "idem-sync");
        const appointmentId = await bookAt(fixture, MONDAY_0900);

        await sync(fixture, appointmentId, CLOCK_NOW);
        const second = await sync(fixture, appointmentId, CLOCK_NOW);

        expect(second).toMatchObject({ created: 0, rescheduled: 0, cancelled: 0 });
        expect(await reminders(fixture, appointmentId)).toHaveLength(2);
      });

      it("writes an audit row for the scheduling (hard rule 7)", async () => {
        const fixture = await createClinic(h(), "audit-sched");
        const appointmentId = await bookAt(fixture, MONDAY_0900);
        await sync(fixture, appointmentId, CLOCK_NOW);

        const audit = await tenantRows<{ action: string; actor: string; after: unknown }>(
          h(),
          fixture.clinicId,
          `select action, actor, after from audit_log
            where entity_id = $1 and action = 'reminder.scheduled'`,
          [appointmentId],
        );
        expect(audit).toHaveLength(1);
        expect(audit[0]?.actor).toBe("system");
        expect(audit[0]?.after).toMatchObject({ created: 2 });
      });

      it("replaces the reminders when the appointment is rescheduled", async () => {
        const fixture = await createClinic(h(), "resched");
        const appointmentId = await bookAt(fixture, MONDAY_0900);
        await sync(fixture, appointmentId, CLOCK_NOW);

        const later = new Date(MONDAY_0900.getTime() + 2 * HOUR);
        const hold = await fixture.scheduler.holdSlot({
          clinicId: fixture.clinicId,
          providerId: fixture.providerId,
          serviceId: fixture.serviceId,
          patientId: fixture.patientId,
          start: later,
        });
        const moved = await fixture.scheduler.reschedule({
          clinicId: fixture.clinicId,
          appointmentId,
          newHoldId: hold.holdId,
          actor: { kind: "patient" },
        });

        await sync(fixture, appointmentId, CLOCK_NOW);
        await sync(fixture, moved.appointment.id, CLOCK_NOW);

        const old = await reminders(fixture, appointmentId);
        expect(old.map((r) => r.status)).toEqual(["skipped", "skipped"]);

        const fresh = await reminders(fixture, moved.appointment.id);
        expect(fresh.map((r) => r.status)).toEqual(["scheduled", "scheduled"]);
        expect(new Date(fresh[0]!.due_at).getTime()).toBe(later.getTime() - 24 * HOUR);
      });

      it("cancels the reminders when the appointment is cancelled", async () => {
        const fixture = await createClinic(h(), "cancel");
        const appointmentId = await bookAt(fixture, MONDAY_0900);
        await sync(fixture, appointmentId, CLOCK_NOW);

        await fixture.scheduler.cancel({
          clinicId: fixture.clinicId,
          appointmentId,
          actor: { kind: "patient" },
        });

        const result = await sync(fixture, appointmentId, CLOCK_NOW);
        expect(result).toMatchObject({ cancelled: 2, reason: "inactive" });
        expect((await reminders(fixture, appointmentId)).every((r) => r.status === "skipped")).toBe(
          true,
        );
      });

      it("does not resurrect a reminder that has already been sent", async () => {
        const fixture = await createClinic(h(), "no-resurrect");
        const appointmentId = await bookAt(fixture, MONDAY_0900);
        await sync(fixture, appointmentId, CLOCK_NOW);

        const at24h = new Date(MONDAY_0900.getTime() - 24 * HOUR + MINUTE);
        await sendDueReminders(deps(at24h), { clinicId: fixture.clinicId });

        await sync(fixture, appointmentId, at24h);
        const rows = await reminders(fixture, appointmentId);
        expect(rows.filter((r) => r.kind === "pre_24h")).toHaveLength(1);
        expect(rows.find((r) => r.kind === "pre_24h")?.status).toBe("sent");
      });

      it("plans only the 2h reminder for a booking made inside the day", async () => {
        const fixture = await createClinic(h(), "same-day");
        // Monday 08:00 Nairobi: the appointment is one hour and one 2h-offset away.
        const now = new Date(MONDAY_0900.getTime() - 3 * HOUR);
        const scheduler = schedulerAt(h(), now);
        const start = new Date(MONDAY_0900.getTime() + 4 * HOUR);
        const appointmentId = await bookAt(fixture, start, scheduler);

        await sync(fixture, appointmentId, now);
        const rows = await reminders(fixture, appointmentId);
        expect(rows.map((r) => r.kind)).toEqual(["pre_2h"]);
      });

      it("honours a per-service offset override from clinic.flags", async () => {
        const fixture = await createClinic(h(), "svc-cfg");
        await h().raw((c) =>
          c.query(
            `update clinic set flags = jsonb_build_object(
               'reminders', jsonb_build_object(
                 'services', jsonb_build_object($2::text,
                   jsonb_build_object('pre24hMin', 2880, 'pre2hMin', null))))
             where id = $1`,
            [fixture.clinicId, fixture.serviceId],
          ),
        );

        const appointmentId = await bookAt(fixture, MONDAY_0900);
        await sync(fixture, appointmentId, CLOCK_NOW);

        const rows = await reminders(fixture, appointmentId);
        expect(rows.map((r) => r.kind)).toEqual(["pre_24h"]);
        expect(new Date(rows[0]!.due_at).getTime()).toBe(MONDAY_0900.getTime() - 48 * HOUR);
      });
    });

    // ── Sending ──────────────────────────────────────────────────────────────

    describe("the due-reminder sweep", () => {
      const due24h = new Date(MONDAY_0900.getTime() - 24 * HOUR + MINUTE);

      async function booked(label: string): Promise<ClinicFixture & { appointmentId: string }> {
        const fixture = await createClinic(h(), label);
        const appointmentId = await bookAt(fixture, MONDAY_0900);
        await sync(fixture, appointmentId, CLOCK_NOW);
        return { ...fixture, appointmentId };
      }

      it("queues an approved template through the outbox, not the channel", async () => {
        const fixture = await booked("send");
        const report = await sendDueReminders(deps(due24h), { clinicId: fixture.clinicId });
        expect(report).toMatchObject({ sent: 1, skipped: 0 });
        expect(report.outboxIds).toHaveLength(1);

        const outbox = await tenantRows<{
          status: string;
          payload: { message: { kind: string; templateName: string } };
        }>(h(), fixture.clinicId, `select status, payload from outbox`);
        expect(outbox).toHaveLength(1);
        expect(outbox[0]?.status).toBe("pending");
        expect(outbox[0]?.payload.message.kind).toBe("template");
        expect(outbox[0]?.payload.message.templateName).toBe("appt_reminder_24h");

        const messages = await tenantRows<{
          direction: string;
          sent_by: string;
          template_name: string;
          status: string;
        }>(h(), fixture.clinicId, `select direction, sent_by, template_name, status from message`);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          direction: "out",
          sent_by: "system",
          template_name: "appt_reminder_24h",
          status: "queued",
        });
      });

      it("sends exactly once even when the sweep runs twice", async () => {
        const fixture = await booked("idem-send");

        const first = await sendDueReminders(deps(due24h), { clinicId: fixture.clinicId });
        const second = await sendDueReminders(deps(due24h), { clinicId: fixture.clinicId });

        expect(first.sent).toBe(1);
        expect(second.sent).toBe(0);

        const outbox = await tenantRows(h(), fixture.clinicId, `select id from outbox`);
        expect(outbox).toHaveLength(1);

        const rows = await reminders(fixture, fixture.appointmentId);
        expect(rows.find((r) => r.kind === "pre_24h")?.status).toBe("sent");
        expect(rows.find((r) => r.kind === "pre_24h")?.sent_message_id).toBeTruthy();
      });

      it("records the send in audit_log without the message body", async () => {
        const fixture = await booked("audit-send");
        await sendDueReminders(deps(due24h), { clinicId: fixture.clinicId });

        const audit = await tenantRows<{ action: string; after: Record<string, unknown> }>(
          h(),
          fixture.clinicId,
          `select action, after from audit_log where action = 'reminder.sent'`,
        );
        expect(audit).toHaveLength(1);
        expect(audit[0]?.after).toMatchObject({ kind: "pre_24h", template: "appt_reminder_24h" });
        expect(JSON.stringify(audit[0]?.after)).not.toContain(fixture.patientName);
      });

      it("leaves a reminder alone until it is due", async () => {
        const fixture = await booked("early");
        const early = new Date(MONDAY_0900.getTime() - 25 * HOUR);
        expect(await sendDueReminders(deps(early), { clinicId: fixture.clinicId })).toMatchObject({
          sent: 0,
          skipped: 0,
        });
      });

      it("sends both reminders once the second comes due", async () => {
        const fixture = await booked("both");
        await sendDueReminders(deps(due24h), { clinicId: fixture.clinicId });
        const at2h = new Date(MONDAY_0900.getTime() - 2 * HOUR + MINUTE);
        expect(await sendDueReminders(deps(at2h), { clinicId: fixture.clinicId })).toMatchObject({
          sent: 1,
        });
        expect(await tenantRows(h(), fixture.clinicId, `select id from outbox`)).toHaveLength(2);
      });

      it("skips a cancelled appointment without queueing anything", async () => {
        const fixture = await booked("skip-cancelled");
        await fixture.scheduler.cancel({
          clinicId: fixture.clinicId,
          appointmentId: fixture.appointmentId,
          actor: { kind: "staff", staffUserId: fixture.ownerId },
        });

        const report = await sendDueReminders(deps(due24h), { clinicId: fixture.clinicId });
        expect(report).toMatchObject({ sent: 0, skipped: 1 });
        expect(report.skipReasons).toMatchObject({ appointment_inactive: 1 });
        expect(await tenantRows(h(), fixture.clinicId, `select id from outbox`)).toHaveLength(0);
      });

      it("skips a patient who has opted out of service messages", async () => {
        const fixture = await booked("skip-optout");
        await h().raw((c) =>
          c.query(
            `insert into patient_consent (id, clinic_id, patient_id, kind, granted, source)
             values ('pcn_01J0000000000000000OPTOUT', $1, $2, 'service_messages', false, 'stop_keyword')`,
            [fixture.clinicId, fixture.patientId],
          ),
        );

        const report = await sendDueReminders(deps(due24h), { clinicId: fixture.clinicId });
        expect(report.skipReasons).toMatchObject({ opted_out: 1 });
        expect(await tenantRows(h(), fixture.clinicId, `select id from outbox`)).toHaveLength(0);
      });

      it("skips a blocked patient", async () => {
        const fixture = await booked("skip-blocked");
        await h().raw((c) =>
          c.query(`update patient set flags = flags || '{"blocked": true}'::jsonb where id = $1`, [
            fixture.patientId,
          ]),
        );
        const report = await sendDueReminders(deps(due24h), { clinicId: fixture.clinicId });
        expect(report.skipReasons).toMatchObject({ patient_blocked: 1 });
      });

      it("skips a muted conversation", async () => {
        const fixture = await booked("skip-muted");
        await h().raw((c) =>
          c.query(`update conversation set mode = 'muted' where clinic_id = $1`, [
            fixture.clinicId,
          ]),
        );
        const report = await sendDueReminders(deps(due24h), { clinicId: fixture.clinicId });
        expect(report.skipReasons).toMatchObject({ conversation_muted: 1 });
      });

      it("marks a skipped reminder so the sweep never claims it again", async () => {
        const fixture = await booked("skip-terminal");
        await h().raw((c) =>
          c.query(`update patient set flags = flags || '{"blocked": true}'::jsonb where id = $1`, [
            fixture.patientId,
          ]),
        );
        await sendDueReminders(deps(due24h), { clinicId: fixture.clinicId });
        expect(await sendDueReminders(deps(due24h), { clinicId: fixture.clinicId })).toMatchObject({
          sent: 0,
          skipped: 0,
        });
      });

      it("logs no patient phone number or name (hard rule 4)", async () => {
        const fixture = await booked("phi");
        const log = createRecordingLogger();
        await sendDueReminders({ ...deps(due24h), log }, { clinicId: fixture.clinicId });

        expect(log.entries.length).toBeGreaterThan(0);
        assertNoPhi(log.serialised(), {
          phone: fixture.patientPhone,
          name: fixture.patientName,
        });
        expect(log.serialised()).toContain(fixture.appointmentId);
      });

      it("stays inside its tenant", async () => {
        const a = await booked("tenant-a");
        const b = await createClinic(h(), "tenant-b");
        const bookedB = await bookAt(b, MONDAY_0900);
        await sync(b, bookedB, CLOCK_NOW);

        await sendDueReminders(deps(due24h), { clinicId: a.clinicId });

        const bRows = await reminders(b, bookedB);
        expect(bRows.every((r) => r.status === "scheduled")).toBe(true);
      });
    });

    // ── No-show ──────────────────────────────────────────────────────────────

    describe("no-show detection", () => {
      const at31 = new Date(MONDAY_0900.getTime() + 31 * MINUTE);

      async function booked(label: string): Promise<ClinicFixture & { appointmentId: string }> {
        const fixture = await createClinic(h(), label);
        const appointmentId = await bookAt(fixture, MONDAY_0900);
        return { ...fixture, appointmentId };
      }

      const statusOf = async (fixture: ClinicFixture, appointmentId: string): Promise<string> =>
        (
          await tenantRows<{ status: string }>(
            h(),
            fixture.clinicId,
            `select status::text as status from appointment where id = $1`,
            [appointmentId],
          )
        )[0]!.status;

      it("does not fire at 29 minutes", async () => {
        const fixture = await booked("noshow-29");
        const at29 = new Date(MONDAY_0900.getTime() + 29 * MINUTE);
        expect(await markNoShows(deps(at29), { clinicId: fixture.clinicId })).toMatchObject({
          marked: 0,
        });
        expect(await statusOf(fixture, fixture.appointmentId)).toBe("booked");
      });

      it("fires at 31 minutes, bumps the count, audits and queues a nudge", async () => {
        const fixture = await booked("noshow-31");
        const report = await markNoShows(deps(at31), { clinicId: fixture.clinicId });
        expect(report).toMatchObject({ marked: 1, nudged: 1 });

        expect(await statusOf(fixture, fixture.appointmentId)).toBe("no_show");

        const patient = await tenantRows<{ flags: { no_show_count?: number } }>(
          h(),
          fixture.clinicId,
          `select flags from patient where id = $1`,
          [fixture.patientId],
        );
        expect(patient[0]?.flags.no_show_count).toBe(1);

        const audit = await tenantRows<{ before: unknown; after: Record<string, unknown> }>(
          h(),
          fixture.clinicId,
          `select before, after from audit_log where action = 'appointment.no_show' and entity_id = $1`,
          [fixture.appointmentId],
        );
        expect(audit).toHaveLength(1);
        expect(audit[0]?.after).toMatchObject({ status: "no_show", patientNoShowCount: 1 });

        const nudges = (await reminders(fixture, fixture.appointmentId)).filter(
          (r) => r.kind === "no_show_rebook",
        );
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.status).toBe("scheduled");
      });

      it("is idempotent — a second sweep in the same minute marks nothing", async () => {
        const fixture = await booked("noshow-idem");
        await markNoShows(deps(at31), { clinicId: fixture.clinicId });
        expect(await markNoShows(deps(at31), { clinicId: fixture.clinicId })).toMatchObject({
          marked: 0,
          nudged: 0,
        });

        const patient = await tenantRows<{ flags: { no_show_count?: number } }>(
          h(),
          fixture.clinicId,
          `select flags from patient where id = $1`,
          [fixture.patientId],
        );
        expect(patient[0]?.flags.no_show_count).toBe(1);
      });

      it("never fires for a cancelled appointment", async () => {
        const fixture = await booked("noshow-cancelled");
        await fixture.scheduler.cancel({
          clinicId: fixture.clinicId,
          appointmentId: fixture.appointmentId,
          actor: { kind: "patient" },
        });
        expect(await markNoShows(deps(at31), { clinicId: fixture.clinicId })).toMatchObject({
          marked: 0,
        });
      });

      it("never fires for a patient who arrived", async () => {
        const fixture = await booked("noshow-arrived");
        await h().raw((c) =>
          c.query(`update appointment set status = 'arrived', arrived_at = now() where id = $1`, [
            fixture.appointmentId,
          ]),
        );
        expect(await markNoShows(deps(at31), { clinicId: fixture.clinicId })).toMatchObject({
          marked: 0,
        });
      });

      it("ignores an appointment older than the lookback window", async () => {
        const fixture = await booked("noshow-stale");
        const muchLater = new Date(MONDAY_0900.getTime() + 72 * HOUR);
        expect(await markNoShows(deps(muchLater), { clinicId: fixture.clinicId })).toMatchObject({
          marked: 0,
        });
      });

      it("respects a longer grace period configured by the clinic", async () => {
        const fixture = await createClinic(h(), "noshow-cfg", {
          flags: { reminders: { noShowAfterMin: 60 } },
        });
        const appointmentId = await bookAt(fixture, MONDAY_0900);
        expect(await markNoShows(deps(at31), { clinicId: fixture.clinicId })).toMatchObject({
          marked: 0,
        });
        const at61 = new Date(MONDAY_0900.getTime() + 61 * MINUTE);
        expect(await markNoShows(deps(at61), { clinicId: fixture.clinicId })).toMatchObject({
          marked: 1,
        });
        expect(await statusOf(fixture, appointmentId)).toBe("no_show");
      });

      it("does not nudge when the clinic has switched the nudge off", async () => {
        const fixture = await createClinic(h(), "noshow-nonudge", {
          flags: { reminders: { noShowRebook: false } },
        });
        const appointmentId = await bookAt(fixture, MONDAY_0900);
        expect(await markNoShows(deps(at31), { clinicId: fixture.clinicId })).toMatchObject({
          marked: 1,
          nudged: 0,
        });
        expect(await reminders(fixture, appointmentId)).toHaveLength(0);
      });

      it("sends the rebook nudge on the next reminder sweep", async () => {
        const fixture = await booked("noshow-nudge-send");
        await markNoShows(deps(at31), { clinicId: fixture.clinicId });

        const report = await sendDueReminders(deps(at31), { clinicId: fixture.clinicId });
        expect(report.sent).toBe(1);

        const outbox = await tenantRows<{ payload: { message: { templateName: string } } }>(
          h(),
          fixture.clinicId,
          `select payload from outbox`,
        );
        expect(outbox[0]?.payload.message.templateName).toBe("rebook_after_no_show");
      });

      it("does not send the nudge if staff correct the status first", async () => {
        const fixture = await booked("noshow-corrected");
        await markNoShows(deps(at31), { clinicId: fixture.clinicId });
        await h().raw((c) =>
          c.query(`update appointment set status = 'arrived', arrived_at = now() where id = $1`, [
            fixture.appointmentId,
          ]),
        );

        const report = await sendDueReminders(deps(at31), { clinicId: fixture.clinicId });
        expect(report).toMatchObject({ sent: 0, skipped: 1 });
        expect(report.skipReasons).toMatchObject({ appointment_not_no_show: 1 });
      });
    });

    // ── Digests ──────────────────────────────────────────────────────────────

    describe("digests", () => {
      it("lists the day's appointments for staff, in clinic-local time", async () => {
        const fixture = await createClinic(h(), "digest-morning");
        await bookAt(fixture, MONDAY_0900);
        await bookAt(fixture, new Date(MONDAY_0900.getTime() + HOUR));

        const window = morningDigestWindow(MONDAY_0900, "Africa/Nairobi");
        const digest = await h().withTenant(fixture.clinicId, (client) =>
          loadStaffMorningDigest(client, fixture.clinicId, window),
        );

        expect(digest.appointments).toHaveLength(2);
        expect(digest.appointments[0]?.patientName).toBe(fixture.patientName);
        expect(digest.appointments[0]?.providerName).toBe("Dr. Otieno");
      });

      it("excludes an appointment on the next clinic-local day", async () => {
        const fixture = await createClinic(h(), "digest-boundary");
        await bookAt(fixture, MONDAY_0900);
        // Tuesday 09:00 Nairobi — a different clinic-local day.
        await bookAt(fixture, new Date(MONDAY_0900.getTime() + 24 * HOUR));

        const window = morningDigestWindow(MONDAY_0900, "Africa/Nairobi");
        const digest = await h().withTenant(fixture.clinicId, (client) =>
          loadStaffMorningDigest(client, fixture.clinicId, window),
        );
        expect(digest.appointments).toHaveLength(1);
      });

      it("counts bookings, no-shows and after-hours messages for the owner", async () => {
        const fixture = await createClinic(h(), "digest-owner");
        const appointmentId = await bookAt(fixture, MONDAY_0900);
        await markNoShows(deps(new Date(MONDAY_0900.getTime() + 31 * MINUTE)), {
          clinicId: fixture.clinicId,
        });

        // One message inside opening hours, one at 23:00 Nairobi.
        await h().raw(async (c) => {
          await c.query(
            `insert into message (id, clinic_id, conversation_id, direction, kind, body, at)
             values ('msg_01J000000000000000INHRS', $1, $2, 'in', 'text', 'hi', $3)`,
            [fixture.clinicId, fixture.conversationId, MONDAY_0900.toISOString()],
          );
          await c.query(
            `insert into message (id, clinic_id, conversation_id, direction, kind, body, at)
             values ('msg_01J00000000000000AFTHRS', $1, $2, 'in', 'text', 'hi', $3)`,
            [
              fixture.clinicId,
              fixture.conversationId,
              new Date(MONDAY_0900.getTime() + 14 * HOUR).toISOString(),
            ],
          );
        });

        // The Monday after the appointment's week.
        const sendAt = new Date(MONDAY_0900.getTime() + 7 * 24 * HOUR);
        const window = weeklyDigestWindow(sendAt, "Africa/Nairobi", 1);
        const metrics = await h().withTenant(fixture.clinicId, (client) =>
          loadOwnerWeeklyMetrics(client, fixture.clinicId, window, "KES"),
        );

        expect(metrics.outcomes).toBe(1);
        expect(metrics.noShows).toBe(1);
        expect(metrics.noShowRatePct).toBe(100);
        expect(metrics.afterHoursInbound).toBe(1);
        expect(appointmentId).toBeTruthy();
      });

      it("delivers each digest at most once per period", async () => {
        const fixture = await createClinic(h(), "digest-once");
        await bookAt(fixture, MONDAY_0900);

        const delivery = createRecordingDigestDelivery();
        // Monday 07:00 Nairobi — the morning digest hour.
        const at0700 = new Date(MONDAY_0900.getTime() - 2 * HOUR);
        const digestDeps = { withTenant: h().withTenant, now: () => at0700, delivery };

        const first = await runClinicDigests(digestDeps, { clinicId: fixture.clinicId });
        const second = await runClinicDigests(digestDeps, { clinicId: fixture.clinicId });

        expect(first.sent).toEqual(["staff_morning"]);
        expect(second.sent).toEqual([]);
        expect(second.skipped).toEqual(["staff_morning"]);
        expect(delivery.delivered).toHaveLength(1);
        expect(delivery.delivered[0]?.body).toContain("Dr. Otieno");
      });

      it("sends nothing at an hour that is not the configured one", async () => {
        const fixture = await createClinic(h(), "digest-quiet");
        const delivery = createRecordingDigestDelivery();
        // 11:00 Nairobi: neither 07:00 nor the Monday 08:00 owner slot.
        const at1100 = new Date(MONDAY_0900.getTime() + 2 * HOUR);
        const report = await runClinicDigests(
          { withTenant: h().withTenant, now: () => at1100, delivery },
          { clinicId: fixture.clinicId },
        );
        expect(report.sent).toEqual([]);
        expect(delivery.delivered).toHaveLength(0);
      });

      it("queues a WhatsApp template to the owner's number, with no message row", async () => {
        const fixture = await createClinic(h(), "digest-wa");
        await bookAt(fixture, MONDAY_0900);

        const at0700 = new Date(MONDAY_0900.getTime() - 2 * HOUR);
        await runClinicDigests(
          { withTenant: h().withTenant, now: () => at0700 },
          { clinicId: fixture.clinicId },
        );

        const outbox = await tenantRows<{
          message_id: string | null;
          payload: { message: { templateName: string; bodyParameters: string[] } };
        }>(h(), fixture.clinicId, `select message_id, payload from outbox`);

        expect(outbox).toHaveLength(1);
        // A staff notification has no conversation, so no `message` row.
        expect(outbox[0]?.message_id).toBeNull();
        expect(outbox[0]?.payload.message.templateName).toBe("staff_digest");
        for (const param of outbox[0]?.payload.message.bodyParameters ?? []) {
          expect(param).not.toMatch(/[\r\n\t]/);
        }
        expect(await tenantRows(h(), fixture.clinicId, `select id from message`)).toHaveLength(0);
      });

      it("sends the owner digest on the configured weekday and hour", async () => {
        const fixture = await createClinic(h(), "digest-weekly");
        const delivery = createRecordingDigestDelivery();
        // Monday 08:00 Nairobi, one week after the fixture Monday.
        const at0800 = new Date(MONDAY_0900.getTime() + 7 * 24 * HOUR - HOUR);
        const report = await runClinicDigests(
          { withTenant: h().withTenant, now: () => at0800, delivery },
          { clinicId: fixture.clinicId },
        );
        expect(report.sent).toEqual(["owner_weekly"]);
        expect(delivery.delivered[0]?.subject).toContain("weekly summary");
      });
    });

    // ── Sweeps end to end ────────────────────────────────────────────────────

    describe("the scheduled sweeps", () => {
      it("run over the clinics they are given and report totals", async () => {
        const fixture = await createClinic(h(), "sweeps");
        const appointmentId = await bookAt(fixture, MONDAY_0900);
        await sync(fixture, appointmentId, CLOCK_NOW);

        const at24h = new Date(MONDAY_0900.getTime() - 24 * HOUR + MINUTE);
        const send = await runReminderSend({
          ...sweepDeps(at24h, fixture.clinicId),
          // No Redis in this suite; publishing is asserted separately by the
          // outbox tests. What matters here is that it happens after commit.
          publish: async (clinicId: PrefixedId<"clinic">, outboxId: string) => {
            const rows = await tenantRows(h(), clinicId, `select id from outbox where id = $1`, [
              outboxId,
            ]);
            // The row is visible to a fresh transaction, i.e. already committed.
            expect(rows).toHaveLength(1);
          },
        });
        expect(send).toMatchObject({ clinics: 1, sent: 1 });

        const at31 = new Date(MONDAY_0900.getTime() + 31 * MINUTE);
        expect(await runNoShowSweep(sweepDeps(at31, fixture.clinicId))).toMatchObject({
          clinics: 1,
          marked: 1,
        });

        const at0700 = new Date(MONDAY_0900.getTime() - 2 * HOUR);
        expect(await runDigestSweep(sweepDeps(at0700, fixture.clinicId))).toMatchObject({
          clinics: 1,
          digests: 1,
        });
      });
    });
  }
});
