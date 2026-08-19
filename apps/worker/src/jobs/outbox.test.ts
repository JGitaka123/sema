import { WhatsAppError, type Channel, type OutboundMessage, type SendResult } from "@sema/channels";
import type { TenantClient, WithTenant } from "@sema/db";
import { AppError, type E164, type PrefixedId } from "@sema/shared";
import { describe, expect, it } from "vitest";

import type { ClinicSender } from "../channel.js";
import {
  MAX_ATTEMPTS,
  chooseDelivery,
  deliverOutbox,
  type OutboxPayload,
} from "./outbox.js";

const CLINIC = "cli_01J00000000000000000000000" as PrefixedId<"clinic">;
const TO = "+254712000001" as E164;

const text = (): OutboundMessage => ({ kind: "text", to: TO, body: "Your appointment is booked." });

const fallback = {
  templateName: "staff_followup",
  language: "en",
  bodyParameters: ["Amina"],
};

// ── The window rule, as a pure function ──────────────────────────────────────

describe("chooseDelivery — the 24-hour window (COMPLIANCE.md §3)", () => {
  const now = new Date("2026-08-19T12:00:00Z");
  const open = new Date("2026-08-19T18:00:00Z");
  const closed = new Date("2026-08-19T06:00:00Z");

  it("sends free-form text inside the window", () => {
    const choice = chooseDelivery({ message: text() }, open, now);
    expect(choice).toMatchObject({ kind: "as_is" });
  });

  it("swaps to the approved template once the window has closed", () => {
    const choice = chooseDelivery({ message: text(), fallbackTemplate: fallback }, closed, now);
    expect(choice.kind).toBe("template");
    if (choice.kind !== "template") throw new Error("unreachable");
    expect(choice.reason).toBe("window_closed");
    expect(choice.message).toMatchObject({
      kind: "template",
      to: TO,
      templateName: "staff_followup",
    });
  });

  it("blocks free-form outside the window when nothing is approved to send", () => {
    expect(chooseDelivery({ message: text() }, closed, now)).toEqual({
      kind: "blocked",
      reason: "window_closed_no_template",
    });
  });

  it("treats a conversation that never had a patient message as closed", () => {
    // A clinic-initiated first contact: there is no window to be inside of.
    expect(chooseDelivery({ message: text() }, null, now).kind).toBe("blocked");
    expect(chooseDelivery({ message: text() }, undefined, now).kind).toBe("blocked");
  });

  it("lets a template through regardless — that is what templates are for", () => {
    const payload: OutboxPayload = {
      message: { kind: "template", to: TO, templateName: "appt_reminder_24h", language: "sw" },
    };
    expect(chooseDelivery(payload, closed, now).kind).toBe("as_is");
    expect(chooseDelivery(payload, null, now).kind).toBe("as_is");
  });

  it("closes exactly at the boundary, not a millisecond later", () => {
    expect(chooseDelivery({ message: text() }, now, now).kind).toBe("blocked");
    expect(chooseDelivery({ message: text() }, new Date(now.getTime() + 1), now).kind).toBe("as_is");
  });

  it("applies the same rule to interactive and location messages", () => {
    const interactive: OutboundMessage = {
      kind: "interactive",
      to: TO,
      body: "Pick",
      options: [{ id: "a", title: "A" }],
    };
    const location: OutboundMessage = { kind: "location", to: TO, latitude: -1.29, longitude: 36.78 };
    expect(chooseDelivery({ message: interactive }, closed, now).kind).toBe("blocked");
    expect(chooseDelivery({ message: location }, closed, now).kind).toBe("blocked");
  });
});

// ── Delivery, against an in-memory tenant ────────────────────────────────────

interface OutboxState {
  id: string;
  message_id: string;
  payload: OutboxPayload;
  attempts: number;
  status: string;
  last_error: string | null;
  next_attempt_at: Date | null;
}

/**
 * A tiny stand-in for the tenant transaction.
 *
 * It answers the handful of statements `deliverOutbox` issues, so the retry,
 * dead-letter and window behaviour can be tested without Docker. The SQL
 * itself is covered against real Postgres in `test/whatsapp-pipeline.test.ts`
 * — this fake proves the *decisions*, not the queries.
 */
class FakeTenant {
  outbox: OutboxState;
  messageStatus = "queued";
  messageWaId: string | null = null;
  sessionExpiresAt: Date | null;
  sender: ClinicSender | undefined = {
    phoneNumberId: "100000000000002",
    accessToken: "token",
  };
  audit: { action: string; after: unknown }[] = [];

  constructor(payload: OutboxPayload, sessionExpiresAt: Date | null, attempts = 0) {
    this.outbox = {
      id: "out_01",
      message_id: "msg_01",
      payload,
      attempts,
      status: "pending",
      last_error: null,
      next_attempt_at: null,
    };
    this.sessionExpiresAt = sessionExpiresAt;
  }

  readonly withTenant: WithTenant = async (_clinicId, work) => work(this.client());

  private client(): TenantClient {
    return {
      query: async (sql: string, params: unknown[] = []) => {
        if (/update outbox\s+set status = 'sending'/.test(sql)) {
          if (!["pending", "failed"].includes(this.outbox.status)) return { rows: [] };
          this.outbox.status = "sending";
          this.outbox.attempts += 1;
          return { rows: [{ ...this.outbox }] };
        }
        if (/select c\.session_expires_at/.test(sql)) {
          return { rows: [{ session_expires_at: this.sessionExpiresAt?.toISOString() ?? null }] };
        }
        if (/from clinic_whatsapp/.test(sql)) {
          return {
            rows: this.sender
              ? [
                  {
                    phone_number_id: this.sender.phoneNumberId,
                    access_token_encrypted: this.sender.accessToken,
                    display_phone_number: null,
                  },
                ]
              : [],
          };
        }
        if (/update outbox\s+set status = 'sent'/.test(sql)) {
          this.outbox.status = "sent";
          this.outbox.last_error = null;
          return { rows: [] };
        }
        if (/update outbox\s+set status = \$2/.test(sql)) {
          this.outbox.status = params[1] as string;
          this.outbox.last_error = params[2] as string;
          this.outbox.next_attempt_at = params[3] as Date | null;
          return { rows: [] };
        }
        if (/update message\s+set status = 'sent'/.test(sql)) {
          this.messageStatus = "sent";
          this.messageWaId = params[1] as string;
          return { rows: [] };
        }
        if (/update message set status = 'failed'/.test(sql)) {
          this.messageStatus = "failed";
          return { rows: [] };
        }
        if (/insert into audit_log/.test(sql)) {
          this.audit.push({ action: "outbox.dead_letter", after: params[3] });
          return { rows: [] };
        }
        throw new Error(`unexpected sql: ${sql.slice(0, 60)}`);
      },
    };
  }
}

/** A channel that records what it was asked to send. */
function fakeChannel(behaviour: () => Promise<SendResult>): { channel: Channel; sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  const channel: Channel = {
    name: "whatsapp",
    send: (message) => {
      sent.push(message);
      return behaviour();
    },
    sendText: () => behaviour(),
    sendInteractive: () => behaviour(),
    sendTemplate: () => behaviour(),
    sendLocation: () => behaviour(),
    downloadMedia: () => Promise.reject(new Error("not used")),
    markRead: () => Promise.resolve(),
  };
  return { channel, sent };
}

const future = new Date("2026-08-20T00:00:00Z");
const past = new Date("2026-08-18T00:00:00Z");
const now = (): Date => new Date("2026-08-19T12:00:00Z");

const ok = (): Promise<SendResult> => Promise.resolve({ externalMessageId: "wamid.SENT" });

describe("deliverOutbox", () => {
  it("sends the queued message and records the wamid", async () => {
    const tenant = new FakeTenant({ message: text() }, future);
    const { channel, sent } = fakeChannel(ok);

    const outcome = await deliverOutbox(
      { clinicId: CLINIC, outboxId: "out_01", attempt: 0 },
      { withTenant: tenant.withTenant, channelFactory: () => channel, now },
    );

    expect(outcome).toEqual({
      status: "sent",
      externalMessageId: "wamid.SENT",
      usedTemplate: false,
    });
    expect(sent).toHaveLength(1);
    expect(tenant.outbox.status).toBe("sent");
    expect(tenant.messageStatus).toBe("sent");
    // Without the wamid, the delivery-status webhook can never find this row.
    expect(tenant.messageWaId).toBe("wamid.SENT");
  });

  it("never sends the same row twice", async () => {
    const tenant = new FakeTenant({ message: text() }, future);
    const { channel, sent } = fakeChannel(ok);
    const deps = { withTenant: tenant.withTenant, channelFactory: () => channel, now };

    await deliverOutbox({ clinicId: CLINIC, outboxId: "out_01", attempt: 0 }, deps);
    const second = await deliverOutbox({ clinicId: CLINIC, outboxId: "out_01", attempt: 0 }, deps);

    // The `pending → sending` claim is what makes a duplicate job harmless.
    expect(second).toEqual({ status: "skipped", reason: "not_pending" });
    expect(sent).toHaveLength(1);
  });

  it("substitutes the template when the window has closed", async () => {
    const tenant = new FakeTenant({ message: text(), fallbackTemplate: fallback }, past);
    const { channel, sent } = fakeChannel(ok);

    const outcome = await deliverOutbox(
      { clinicId: CLINIC, outboxId: "out_01", attempt: 0 },
      { withTenant: tenant.withTenant, channelFactory: () => channel, now },
    );

    expect(outcome).toMatchObject({ status: "sent", usedTemplate: true });
    expect(sent[0]).toMatchObject({ kind: "template", templateName: "staff_followup" });
  });

  it("dead-letters immediately when the window is shut and nothing is approved", async () => {
    const tenant = new FakeTenant({ message: text() }, past);
    const { channel, sent } = fakeChannel(ok);

    const outcome = await deliverOutbox(
      { clinicId: CLINIC, outboxId: "out_01", attempt: 0 },
      { withTenant: tenant.withTenant, channelFactory: () => channel, now },
    );

    // Retrying cannot help: the window reopens only when the patient writes.
    expect(outcome).toEqual({ status: "dead", reason: "window_closed_no_template" });
    expect(sent).toHaveLength(0);
    expect(tenant.outbox.status).toBe("dead");
    expect(tenant.messageStatus).toBe("failed");
    expect(tenant.audit).toHaveLength(1);
  });

  it("retries a transient failure, with a growing next_attempt_at", async () => {
    const tenant = new FakeTenant({ message: text() }, future);
    const { channel } = fakeChannel(() =>
      Promise.reject(new WhatsAppError("transient", "Meta is down")),
    );

    await expect(
      deliverOutbox(
        { clinicId: CLINIC, outboxId: "out_01", attempt: 0 },
        { withTenant: tenant.withTenant, channelFactory: () => channel, now },
      ),
      // Rethrown so BullMQ counts the attempt and applies its own backoff.
    ).rejects.toThrow(WhatsAppError);

    expect(tenant.outbox.status).toBe("failed");
    expect(tenant.outbox.last_error).toBe("transient");
    expect(tenant.outbox.next_attempt_at?.getTime()).toBeGreaterThan(now().getTime());
  });

  it("backs off exponentially across attempts", async () => {
    const delays: number[] = [];
    for (const priorAttempts of [0, 1, 2, 3]) {
      const tenant = new FakeTenant({ message: text() }, future, priorAttempts);
      const { channel } = fakeChannel(() =>
        Promise.reject(new WhatsAppError("rate_limited", "slow down")),
      );
      await deliverOutbox(
        { clinicId: CLINIC, outboxId: "out_01", attempt: priorAttempts },
        { withTenant: tenant.withTenant, channelFactory: () => channel, now },
      ).catch(() => undefined);
      delays.push((tenant.outbox.next_attempt_at?.getTime() ?? 0) - now().getTime());
    }

    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000]);
  });

  it("dead-letters once the attempts are exhausted (ARCHITECTURE.md §11)", async () => {
    // Claiming bumps attempts to MAX_ATTEMPTS, which is the last one.
    const tenant = new FakeTenant({ message: text() }, future, MAX_ATTEMPTS - 1);
    const { channel } = fakeChannel(() =>
      Promise.reject(new WhatsAppError("transient", "still down")),
    );

    const outcome = await deliverOutbox(
      { clinicId: CLINIC, outboxId: "out_01", attempt: MAX_ATTEMPTS - 1 },
      { withTenant: tenant.withTenant, channelFactory: () => channel, now },
    );

    expect(outcome).toEqual({ status: "dead", reason: "transient" });
    expect(tenant.outbox.status).toBe("dead");
    expect(tenant.messageStatus).toBe("failed");
    // "dead-letter to inbox alert" — the audit row is how staff find it.
    expect(tenant.audit[0]?.after).toContain("transient");
  });

  it("dead-letters an undeliverable number without burning five attempts", async () => {
    const tenant = new FakeTenant({ message: text() }, future);
    const { channel } = fakeChannel(() =>
      Promise.reject(new WhatsAppError("undeliverable", "131026")),
    );

    const outcome = await deliverOutbox(
      { clinicId: CLINIC, outboxId: "out_01", attempt: 0 },
      { withTenant: tenant.withTenant, channelFactory: () => channel, now },
    );

    expect(outcome).toEqual({ status: "dead", reason: "undeliverable" });
    expect(tenant.outbox.attempts).toBe(1);
  });

  it("dead-letters a payload our own builder rejects — it will never improve", async () => {
    const tenant = new FakeTenant({ message: text() }, future);
    const { channel } = fakeChannel(() =>
      Promise.reject(new AppError("VALIDATION_FAILED", "body too long", { expose: false })),
    );

    const outcome = await deliverOutbox(
      { clinicId: CLINIC, outboxId: "out_01", attempt: 0 },
      { withTenant: tenant.withTenant, channelFactory: () => channel, now },
    );
    expect(outcome).toMatchObject({ status: "dead" });
  });

  it("dead-letters when the clinic has no connected WhatsApp sender", async () => {
    const tenant = new FakeTenant({ message: text() }, future);
    tenant.sender = undefined;
    const { channel, sent } = fakeChannel(ok);

    const outcome = await deliverOutbox(
      { clinicId: CLINIC, outboxId: "out_01", attempt: 0 },
      { withTenant: tenant.withTenant, channelFactory: () => channel, now },
    );

    expect(outcome).toMatchObject({ status: "dead" });
    expect(sent).toHaveLength(0);
  });

  it("skips a row that does not exist", async () => {
    const tenant = new FakeTenant({ message: text() }, future);
    tenant.outbox.status = "sent";
    const { channel } = fakeChannel(ok);

    expect(
      await deliverOutbox(
        { clinicId: CLINIC, outboxId: "out_01", attempt: 0 },
        { withTenant: tenant.withTenant, channelFactory: () => channel, now },
      ),
    ).toEqual({ status: "skipped", reason: "not_pending" });
  });
});
