import { schema, type WithTenantDb } from "@sema/db";
import { formatMoney, money, newId, type CurrencyCode } from "@sema/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";

import { JSON_SCHEMAS, requestDepositSchema } from "./schemas.js";
import {
  defineTool,
  type AnyToolDefinition,
  type DepositRequestInput,
  type DepositRequestResult,
  type DepositRequester,
  type ToolOutcome,
  type ToolRuntime,
} from "./types.js";

/**
 * Deposits — and the seam where Phase 6 plugs M-Pesa in.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  PHASE 6 SEAM. Nothing in this file talks to Safaricom Daraja.
 *
 *  `recordingDepositRequester` writes a `payment_request` row in state
 *  `initiated` and stops. It records *intent* — "the agent asked this patient
 *  for KES 1,500 against this appointment" — so the booking flow, the inbox
 *  and the evals are all complete today, and so Phase 6 has a row to attach a
 *  `checkout_request_id` to rather than a schema change to make.
 *
 *  Phase 6 replaces this implementation with a Daraja one (BUILD_PLAN.md
 *  Phase 6: "`packages/payments` interface + Daraja adapter … Wire
 *  `request_deposit` tool + `pending_deposit` → `confirmed` transitions").
 *  The tool, its audit trail and its Zod schema do not change.
 *
 *  ADR-003 / hard rule 5 hold either way: funds settle into the clinic's own
 *  Paybill. Sema never holds, refunds or reconciles a patient's money.
 * ══════════════════════════════════════════════════════════════════════════
 */

/**
 * Statuses in which a request is still live, i.e. asking again would be a
 * duplicate. `initiated` is where the stub leaves a row; `pushed` is where
 * Phase 6 will move it once Daraja has accepted the STK request.
 */
const LIVE_REQUEST_STATUSES = ["initiated", "pushed"] as const;

export interface RecordingDepositRequesterDeps {
  readonly withTenantDb: WithTenantDb;
  readonly now?: () => Date;
}

/**
 * The stub. Idempotent per appointment, which is the property Phase 6 has to
 * keep: a patient must never receive two STK pushes because the agent called
 * the tool twice.
 */
export function recordingDepositRequester(
  deps: RecordingDepositRequesterDeps,
): DepositRequester {
  const clock = deps.now ?? ((): Date => new Date());

  return {
    async request(input: DepositRequestInput): Promise<DepositRequestResult> {
      if (input.amountMinor <= 0) {
        return { status: "not_required", paymentRequestId: null, simulated: true };
      }

      return deps.withTenantDb(input.clinicId, async (db) => {
        const existing = await db
          .select({ id: schema.paymentRequest.id })
          .from(schema.paymentRequest)
          .where(
            and(
              eq(schema.paymentRequest.clinicId, input.clinicId),
              eq(schema.paymentRequest.appointmentId, input.appointmentId),
              inArray(schema.paymentRequest.status, [...LIVE_REQUEST_STATUSES]),
            ),
          )
          .limit(1);

        const found = existing[0];
        if (found) {
          return {
            status: "already_requested" as const,
            paymentRequestId: found.id,
            simulated: true,
          };
        }

        // The phone is read from the patient row inside the tenant
        // transaction rather than passed in, so a caller cannot direct a
        // payment prompt at a number of its choosing.
        const phoneRows = await db
          .select({ phoneE164: schema.patient.phoneE164 })
          .from(schema.patient)
          .where(
            and(
              eq(schema.patient.clinicId, input.clinicId),
              eq(schema.patient.id, input.patientId),
            ),
          )
          .limit(1);
        const phone = phoneRows[0]?.phoneE164;
        if (phone === undefined) {
          throw new Error("patient not found for deposit request");
        }

        const at = clock();
        const paymentRequestId = newId("paymentRequest");

        await db.insert(schema.paymentRequest).values({
          id: paymentRequestId,
          clinicId: input.clinicId,
          appointmentId: input.appointmentId,
          patientId: input.patientId,
          amountMinor: input.amountMinor,
          currency: input.currency,
          provider: "mpesa_daraja",
          status: "initiated",
          phoneE164: phone,
          initiatedBy: "agent",
          // Phase 6 sets a real Daraja expiry; a pending intent that nobody
          // ever actioned should not look live forever.
          expiresAt: new Date(at.getTime() + 15 * 60_000),
          createdAt: at,
          updatedAt: at,
        });

        // Hard rule 7: payment requests are named explicitly as auditable.
        await db.insert(schema.auditLog).values({
          id: newId("auditLog"),
          clinicId: input.clinicId,
          actor: "agent",
          action: "payment_request.created",
          entity: "payment_request",
          entityId: paymentRequestId,
          after: {
            appointment_id: input.appointmentId,
            amount_minor: input.amountMinor,
            currency: input.currency,
            status: "initiated",
            // Explicit, so an auditor reading Phase 5 rows later can tell that
            // no money movement was ever attempted for them.
            simulated: true,
          },
          reason: "deposit_required",
          at,
          createdAt: at,
          updatedAt: at,
        });

        return { status: "requested" as const, paymentRequestId, simulated: true };
      });
    },
  };
}

/** A requester that does nothing, for unit tests that are not about deposits. */
export const noopDepositRequester: DepositRequester = {
  request: async () => ({ status: "not_required", paymentRequestId: null, simulated: true }),
};

/**
 * Ask for a deposit against one appointment.
 *
 * Shared by the tool below and by `book_appointment`, which auto-requests
 * (CONVERSATION_ENGINE.md §3.2).
 */
export async function requestDepositFor(
  runtime: ToolRuntime,
  appointmentId: string,
  amountMinor: number,
): Promise<Record<string, unknown>> {
  const currency = runtime.context.clinic.currency;
  const result = await runtime.deps.depositRequester.request({
    clinicId: runtime.clinicId,
    appointmentId,
    patientId: runtime.patientId,
    amountMinor,
    currency,
  });

  await runtime.audit({
    action: "agent.tool.request_deposit",
    entity: "appointment",
    entityId: appointmentId,
    meta: {
      amount_minor: amountMinor,
      currency,
      status: result.status,
      payment_request_id: result.paymentRequestId,
      simulated: result.simulated,
    },
  });

  return {
    status: result.status,
    amount: formatMoney(money(amountMinor, currency as CurrencyCode)),
  };
}

export const requestDepositTool: AnyToolDefinition = defineTool<
  z.infer<typeof requestDepositSchema>
>({
  name: "request_deposit",
  description:
    "Ask the patient for the deposit on an appointment that is still pending_deposit. book_appointment already does this automatically, so only call it again if the patient asks you to resend the prompt. Never ask for an amount other than the one this tool returns.",
  schema: requestDepositSchema,
  jsonSchema: JSON_SCHEMAS["request_deposit"] ?? {},
  mutating: true,

  async execute(input, runtime): Promise<ToolOutcome> {
    // The amount comes from the appointment row, never from the model: hard
    // rule 5 and SAFETY.md §1.9 both turn on nobody being able to talk the
    // agent into asking for a different number.
    const outstanding = await runtime.deps.withTenantDb(runtime.clinicId, async (db) => {
      const rows = await db
        .select({
          id: schema.appointment.id,
          status: schema.appointment.status,
          required: schema.appointment.depositRequiredMinor,
          paid: schema.appointment.depositPaidMinor,
        })
        .from(schema.appointment)
        .where(
          and(
            eq(schema.appointment.clinicId, runtime.clinicId),
            eq(schema.appointment.id, input.appointment_id),
            // Scoping to this patient is what stops a hallucinated apt_ id
            // from another conversation triggering a payment prompt.
            eq(schema.appointment.patientId, runtime.patientId),
            sql`true`,
          ),
        )
        .limit(1);
      return rows[0];
    });

    if (!outstanding) {
      await runtime.audit({
        action: "agent.tool.request_deposit",
        entity: "appointment",
        entityId: input.appointment_id,
        meta: { status: "not_found" },
      });
      return {
        ok: false,
        result: {
          error: "NOT_FOUND",
          guidance:
            "No such appointment for this patient. Call lookup_appointments and work from the ids it returns.",
        },
      };
    }

    const amountMinor = Math.max(0, outstanding.required - outstanding.paid);
    if (amountMinor === 0) {
      await runtime.audit({
        action: "agent.tool.request_deposit",
        entity: "appointment",
        entityId: outstanding.id,
        meta: { status: "not_required" },
      });
      return {
        ok: true,
        result: {
          status: "not_required",
          guidance: "Nothing is outstanding on this appointment. Do not ask the patient for money.",
        },
      };
    }

    const requested = await requestDepositFor(runtime, outstanding.id, amountMinor);
    const amount = String(requested["amount"]);

    return {
      ok: true,
      result: {
        ...requested,
        guidance: `Tell the patient an M-Pesa prompt for ${amount} is coming to this number, and that the booking is confirmed once it goes through. Do not promise a refund.`,
      },
      facts: [amount],
    };
  },
});
