import type { Channel, InboundJobData } from "@sema/channels";
import { claimWebhooks, resolveClinicByPhoneNumberId } from "@sema/db";
import type { E164 } from "@sema/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { processInboundMessage, processStatusUpdate } from "../src/jobs/inbound.js";
import { deliverOutbox, enqueueOutbound } from "../src/jobs/outbox.js";
import { createTenant, getHarness, tenantRows, type Harness, type TenantFixture } from "./support/db.js";

/**
 * The inbound → outbox pipeline against real Postgres (docs/TESTING.md layer 2).
 *
 * The unit suites prove the *decisions*; this one proves the SQL — the upserts,
 * the partial unique index, the `on conflict do nothing` dedup, the RLS
 * policies and the guarded outbox transition. Those are exactly the things a
 * fake client cannot tell you the truth about.
 *
 * Skips cleanly when no Postgres is reachable; CI always has one.
 */

let harness: Harness | undefined;

beforeAll(async () => {
  harness = await getHarness();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

const describeDb = (): typeof describe | typeof describe.skip =>
  harness ? describe : describe.skip;

function inbound(tenant: TenantFixture, overrides: Partial<InboundJobData> = {}): InboundJobData {
  return {
    phoneNumberId: tenant.phoneNumberId,
    waMessageId: `wamid.${Math.random().toString(36).slice(2)}`,
    fromWaId: tenant.patientPhone.slice(1),
    profileName: "Test Patient",
    sentAt: new Date("2026-08-19T12:00:00Z").toISOString(),
    kind: "text",
    body: "Naomba appointment",
    rawType: "text",
    ...overrides,
  };
}

// The suite is defined unconditionally so vitest reports it as skipped rather
// than as an empty file.
describe("whatsapp pipeline (Postgres)", () => {
  const suite = (): void => {
    const h = (): Harness => {
      if (!harness) throw new Error("no harness");
      return harness;
    };
    const deps = (): Parameters<typeof processStatusUpdate>[1] => ({
      executor: h().pool,
      withTenant: h().withTenant,
    });

    describe("routing", () => {
      it("resolves a clinic from its phone_number_id without a tenant context", async () => {
        const tenant = await createTenant(h(), "route");
        // The whole point: no `app.current_clinic` is set here, and RLS is
        // forced on clinic_whatsapp. Only the SECURITY DEFINER function
        // makes this answerable.
        expect(await resolveClinicByPhoneNumberId(h().pool, tenant.phoneNumberId)).toBe(
          tenant.clinicId,
        );
      });

      it("returns nothing for an unknown sender", async () => {
        expect(await resolveClinicByPhoneNumberId(h().pool, "pnid-nobody")).toBeUndefined();
      });

      it("stops resolving once the number is deactivated", async () => {
        const tenant = await createTenant(h(), "deactivate");
        await h().raw((c) =>
          c.query(`update clinic_whatsapp set is_active = false where clinic_id = $1`, [
            tenant.clinicId,
          ]),
        );
        expect(await resolveClinicByPhoneNumberId(h().pool, tenant.phoneNumberId)).toBeUndefined();
      });

      it("keeps the sender itself behind RLS", async () => {
        const a = await createTenant(h(), "rls-a");
        const b = await createTenant(h(), "rls-b");
        const rows = await tenantRows(h(), a.clinicId, `select id from clinic_whatsapp`);
        // A's tenant context sees exactly one row: its own.
        expect(rows).toHaveLength(1);
        const other = await tenantRows(h(), b.clinicId, `select id from clinic_whatsapp`);
        expect(other).toHaveLength(1);
        expect(other[0]).not.toEqual(rows[0]);
      });
    });

    describe("webhook dedup", () => {
      it("claims an id once, however many times it is delivered", async () => {
        const id = `wamid.${Math.random().toString(36).slice(2)}`;
        expect(await claimWebhooks(h().pool, "whatsapp", [id])).toEqual([id]);
        expect(await claimWebhooks(h().pool, "whatsapp", [id])).toEqual([]);
      });

      it("claims a batch, returning only the new ones", async () => {
        const seen = `wamid.seen.${Math.random().toString(36).slice(2)}`;
        const fresh = `wamid.fresh.${Math.random().toString(36).slice(2)}`;
        await claimWebhooks(h().pool, "whatsapp", [seen]);
        expect(await claimWebhooks(h().pool, "whatsapp", [seen, fresh])).toEqual([fresh]);
      });

      it("de-duplicates within a single batch", async () => {
        const id = `wamid.${Math.random().toString(36).slice(2)}`;
        expect(await claimWebhooks(h().pool, "whatsapp", [id, id, id])).toEqual([id]);
      });
    });

    describe("inbound.process", () => {
      it("creates patient, conversation and message on first contact", async () => {
        const tenant = await createTenant(h(), "first");
        const outcome = await processInboundMessage(inbound(tenant), deps());

        expect(outcome.status).toBe("processed");
        if (outcome.status !== "processed") return;

        const [patient] = await tenantRows<{ phone_e164: string; full_name: string | null }>(
          h(),
          tenant.clinicId,
          `select phone_e164, full_name from patient where id = $1`,
          [outcome.result.patientId],
        );
        // Normalised on ingest, always (CLAUDE.md §Conventions).
        expect(patient?.phone_e164).toBe(tenant.patientPhone);
        expect(patient?.full_name).toBe("Test Patient");

        const [message] = await tenantRows<{ direction: string; status: string; body: string }>(
          h(),
          tenant.clinicId,
          `select direction, status, body from message where id = $1`,
          [outcome.result.messageId],
        );
        expect(message).toMatchObject({ direction: "in", status: "received" });
      });

      it("reuses the open conversation on the next message", async () => {
        const tenant = await createTenant(h(), "reuse");
        const first = await processInboundMessage(inbound(tenant), deps());
        const second = await processInboundMessage(inbound(tenant), deps());

        expect(first.status).toBe("processed");
        expect(second.status).toBe("processed");
        if (first.status !== "processed" || second.status !== "processed") return;

        // One open conversation per patient per clinic (DATA_MODEL.md).
        expect(second.result.conversationId).toBe(first.result.conversationId);
        expect(second.result.patientId).toBe(first.result.patientId);
      });

      it("does not overwrite a name staff typed with a WhatsApp profile name", async () => {
        const tenant = await createTenant(h(), "name");
        await processInboundMessage(inbound(tenant), deps());
        await h().withTenant(tenant.clinicId, (c) =>
          c.query(`update patient set full_name = 'Amina W. Njeri' where clinic_id = $1`, [
            tenant.clinicId,
          ]),
        );
        await processInboundMessage(inbound(tenant, { profileName: "amii 💅" }), deps());

        const [patient] = await tenantRows<{ full_name: string }>(
          h(),
          tenant.clinicId,
          `select full_name from patient where clinic_id = $1`,
          [tenant.clinicId],
        );
        expect(patient?.full_name).toBe("Amina W. Njeri");
      });

      it("rejects a redelivered wa_message_id via the partial unique index", async () => {
        const tenant = await createTenant(h(), "replay");
        const data = inbound(tenant);

        expect((await processInboundMessage(data, deps())).status).toBe("processed");
        expect((await processInboundMessage(data, deps())).status).toBe("duplicate");

        const messages = await tenantRows(
          h(),
          tenant.clinicId,
          `select id from message where wa_message_id = $1`,
          [data.waMessageId],
        );
        expect(messages).toHaveLength(1);
      });

      it("moves the 24-hour window to the patient's message + 24h", async () => {
        const tenant = await createTenant(h(), "window");
        const sentAt = new Date("2026-08-19T12:00:00Z");
        const outcome = await processInboundMessage(
          inbound(tenant, { sentAt: sentAt.toISOString() }),
          deps(),
        );
        if (outcome.status !== "processed") throw new Error("expected processed");

        const [conversation] = await tenantRows<{
          last_patient_message_at: Date;
          session_expires_at: Date;
          unread_for_staff: number;
        }>(
          h(),
          tenant.clinicId,
          `select last_patient_message_at, session_expires_at, unread_for_staff
           from conversation where id = $1`,
          [outcome.result.conversationId],
        );

        expect(conversation?.last_patient_message_at.toISOString()).toBe(sentAt.toISOString());
        expect(conversation?.session_expires_at.getTime()).toBe(
          sentAt.getTime() + 24 * 60 * 60 * 1000,
        );
        expect(conversation?.unread_for_staff).toBe(1);
      });

      it("records an attachment for media, and nothing else", async () => {
        const tenant = await createTenant(h(), "media");
        const outcome = await processInboundMessage(
          inbound(tenant, {
            kind: "audio",
            rawType: "audio",
            body: undefined,
            media: { mediaId: "media-1", mime: "audio/ogg", voice: true },
          }),
          deps(),
        );
        if (outcome.status !== "processed") throw new Error("expected processed");

        const [attachment] = await tenantRows<{ storage_key: string; mime: string }>(
          h(),
          tenant.clinicId,
          `select storage_key, mime from attachment where message_id = $1`,
          [outcome.result.messageId],
        );
        expect(attachment?.mime).toBe("audio/ogg");
        expect(attachment?.storage_key).toContain("media-1");
      });

      it("audits every inbound message without copying its body", async () => {
        const tenant = await createTenant(h(), "audit");
        const outcome = await processInboundMessage(
          inbound(tenant, { body: "a very private symptom" }),
          deps(),
        );
        if (outcome.status !== "processed") throw new Error("expected processed");

        const [entry] = await tenantRows<{ action: string; after: unknown }>(
          h(),
          tenant.clinicId,
          `select action, after from audit_log where entity_id = $1`,
          [outcome.result.messageId],
        );
        expect(entry?.action).toBe("message.received");
        // Hard rule 4 + 7: audited, but never a second copy of the body.
        expect(JSON.stringify(entry?.after)).not.toContain("private symptom");
      });

      it("keeps two clinics' patients apart even on the same number", async () => {
        const a = await createTenant(h(), "iso-a");
        const b = await createTenant(h(), "iso-b");
        // Same human, two clinics: two patient rows, by design (patients.ts).
        const phone = a.patientPhone;
        await processInboundMessage(inbound(a, { fromWaId: phone.slice(1) }), deps());
        await processInboundMessage(
          inbound({ ...b, patientPhone: phone }, { fromWaId: phone.slice(1) }),
          deps(),
        );

        const aRows = await tenantRows(h(), a.clinicId, `select id from patient`);
        const bRows = await tenantRows(h(), b.clinicId, `select id from patient`);
        expect(aRows).toHaveLength(1);
        expect(bRows).toHaveLength(1);
        expect(aRows[0]).not.toEqual(bRows[0]);
      });
    });

    describe("outbox", () => {
      const queue = async (
        tenant: TenantFixture,
        conversationId: string,
        fallbackTemplate?: { templateName: string; language: string },
      ): Promise<{ messageId: string; outboxId: string }> =>
        h().withTenant(tenant.clinicId, (client) =>
          enqueueOutbound(client, {
            clinicId: tenant.clinicId,
            conversationId,
            message: {
              kind: "text",
              to: tenant.patientPhone as E164,
              body: "Your appointment is confirmed.",
            },
            ...(fallbackTemplate === undefined ? {} : { fallbackTemplate }),
            sentBy: "agent",
          }),
        );

      const conversationFor = async (label: string): Promise<[TenantFixture, string]> => {
        const tenant = await createTenant(h(), label);
        const outcome = await processInboundMessage(inbound(tenant), deps());
        if (outcome.status !== "processed") throw new Error("expected processed");
        return [tenant, outcome.result.conversationId];
      };

      it("writes the message and the outbox row in one transaction", async () => {
        const [tenant, conversationId] = await conversationFor("enqueue");
        const { messageId, outboxId } = await queue(tenant, conversationId);

        const [message] = await tenantRows<{ direction: string; status: string }>(
          h(),
          tenant.clinicId,
          `select direction, status from message where id = $1`,
          [messageId],
        );
        expect(message).toMatchObject({ direction: "out", status: "queued" });

        const [row] = await tenantRows<{ status: string; message_id: string }>(
          h(),
          tenant.clinicId,
          `select status, message_id from outbox where id = $1`,
          [outboxId],
        );
        expect(row).toMatchObject({ status: "pending", message_id: messageId });
      });

      it("sends inside the window and records the wamid", async () => {
        const [tenant, conversationId] = await conversationFor("send");
        const { messageId, outboxId } = await queue(tenant, conversationId);

        const outcome = await deliverOutbox(
          { clinicId: tenant.clinicId, outboxId, attempt: 0 },
          {
            withTenant: h().withTenant,
            channelFactory: () => stubChannel("wamid.OUT1"),
            // Inside the 24h window opened by the inbound message above.
            now: () => new Date("2026-08-19T13:00:00Z"),
          },
        );

        expect(outcome).toMatchObject({ status: "sent", usedTemplate: false });

        const [message] = await tenantRows<{ status: string; wa_message_id: string }>(
          h(),
          tenant.clinicId,
          `select status, wa_message_id from message where id = $1`,
          [messageId],
        );
        expect(message).toMatchObject({ status: "sent", wa_message_id: "wamid.OUT1" });
      });

      it("cannot deliver the same row twice, even from two callers at once", async () => {
        const [tenant, conversationId] = await conversationFor("once");
        const { outboxId } = await queue(tenant, conversationId);

        let sends = 0;
        const deliver = (): Promise<unknown> =>
          deliverOutbox(
            { clinicId: tenant.clinicId, outboxId, attempt: 0 },
            {
              withTenant: h().withTenant,
              channelFactory: () => {
                sends += 1;
                return stubChannel("wamid.ONCE");
              },
              now: () => new Date("2026-08-19T13:00:00Z"),
            },
          );

        await Promise.all([deliver(), deliver()]);
        // The `pending → sending` claim is what makes this safe.
        expect(sends).toBe(1);
      });

      it("substitutes a template once the window has closed", async () => {
        const [tenant, conversationId] = await conversationFor("template");
        const { messageId, outboxId } = await queue(tenant, conversationId, {
          templateName: "staff_followup",
          language: "en",
        });

        const outcome = await deliverOutbox(
          { clinicId: tenant.clinicId, outboxId, attempt: 0 },
          {
            withTenant: h().withTenant,
            channelFactory: () => stubChannel("wamid.TPL"),
            // Two days later: the window is long shut.
            now: () => new Date("2026-08-21T13:00:00Z"),
          },
        );

        expect(outcome).toMatchObject({ status: "sent", usedTemplate: true });
        const [message] = await tenantRows<{ kind: string; template_name: string }>(
          h(),
          tenant.clinicId,
          `select kind, template_name from message where id = $1`,
          [messageId],
        );
        expect(message).toMatchObject({ kind: "template", template_name: "staff_followup" });
      });

      it("dead-letters a free-form message outside the window", async () => {
        const [tenant, conversationId] = await conversationFor("blocked");
        const { messageId, outboxId } = await queue(tenant, conversationId);

        const outcome = await deliverOutbox(
          { clinicId: tenant.clinicId, outboxId, attempt: 0 },
          {
            withTenant: h().withTenant,
            channelFactory: () => stubChannel("never"),
            now: () => new Date("2026-08-21T13:00:00Z"),
          },
        );

        expect(outcome).toEqual({ status: "dead", reason: "window_closed_no_template" });

        const [row] = await tenantRows<{ status: string; last_error: string }>(
          h(),
          tenant.clinicId,
          `select status, last_error from outbox where id = $1`,
          [outboxId],
        );
        expect(row).toMatchObject({ status: "dead", last_error: "window_closed_no_template" });

        const [message] = await tenantRows<{ status: string }>(
          h(),
          tenant.clinicId,
          `select status from message where id = $1`,
          [messageId],
        );
        expect(message?.status).toBe("failed");

        const audit = await tenantRows(
          h(),
          tenant.clinicId,
          `select id from audit_log where action = 'outbox.dead_letter' and entity_id = $1`,
          [outboxId],
        );
        expect(audit).toHaveLength(1);
      });
    });

    describe("inbound.status", () => {
      it("moves a message forwards through sent, delivered, read", async () => {
        const tenant = await createTenant(h(), "status");
        const inboundOutcome = await processInboundMessage(inbound(tenant), deps());
        if (inboundOutcome.status !== "processed") throw new Error("expected processed");

        const { messageId, outboxId } = await h().withTenant(tenant.clinicId, (client) =>
          enqueueOutbound(client, {
            clinicId: tenant.clinicId,
            conversationId: inboundOutcome.result.conversationId,
            message: { kind: "text", to: tenant.patientPhone as E164, body: "Confirmed." },
            sentBy: "agent",
          }),
        );
        await deliverOutbox(
          { clinicId: tenant.clinicId, outboxId, attempt: 0 },
          {
            withTenant: h().withTenant,
            channelFactory: () => stubChannel("wamid.STATUS"),
            now: () => new Date("2026-08-19T13:00:00Z"),
          },
        );

        const status = (s: "delivered" | "read" | "sent"): Promise<unknown> =>
          processStatusUpdate(
            {
              phoneNumberId: tenant.phoneNumberId,
              waMessageId: "wamid.STATUS",
              status: s,
              at: new Date("2026-08-19T13:01:00Z").toISOString(),
            },
            deps(),
          );

        expect(await status("delivered")).toEqual({ status: "updated" });
        expect(await status("read")).toEqual({ status: "updated" });
        // A late `sent` must not undo `read`.
        expect(await status("sent")).toEqual({ status: "stale" });

        const [message] = await tenantRows<{ status: string }>(
          h(),
          tenant.clinicId,
          `select status from message where id = $1`,
          [messageId],
        );
        expect(message?.status).toBe("read");
      });

      it("ignores a receipt for a message we never stored", async () => {
        const tenant = await createTenant(h(), "orphan");
        expect(
          await processStatusUpdate(
            {
              phoneNumberId: tenant.phoneNumberId,
              waMessageId: "wamid.NEVER_SEEN",
              status: "delivered",
              at: new Date().toISOString(),
            },
            deps(),
          ),
        ).toEqual({ status: "unknown_message" });
      });
    });
  };

  // `describe.skip` still needs the callback, so the body is built either way.
  describeDb()("cases", suite);
});

/** A channel that always succeeds with a fixed wamid. Never talks to Meta. */
function stubChannel(wamid: string): Channel {
  const result = { externalMessageId: wamid };
  return {
    name: "whatsapp",
    send: () => Promise.resolve(result),
    sendText: () => Promise.resolve(result),
    sendInteractive: () => Promise.resolve(result),
    sendTemplate: () => Promise.resolve(result),
    sendLocation: () => Promise.resolve(result),
    downloadMedia: () => Promise.reject(new Error("not used")),
    markRead: () => Promise.resolve(),
  };
}
