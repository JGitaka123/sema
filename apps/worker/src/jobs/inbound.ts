import type { InboundJobData, StatusJobData } from "@sema/channels";
import {
  resolveClinicByPhoneNumberId,
  type SqlExecutor,
  type TenantClient,
  type WithTenant,
} from "@sema/db";
import { newId, normalisePhone, type PrefixedId } from "@sema/shared";

import { defaultChannelFactory, loadSender, type ChannelFactory } from "../channel.js";
import { row, rows } from "./sql.js";

/**
 * `inbound.process` — persist one patient message (ARCHITECTURE.md §2, step 2).
 *
 * The webhook has already verified the signature and de-duplicated the
 * delivery; this is where the work actually happens:
 *
 *   resolve clinic → upsert patient → open conversation → insert message →
 *   record any attachment → move the 24-hour window → mark read
 *
 * and then **stops**. Classification, routing and the agent are Phase 4 and
 * Phase 5 (docs/BUILD_PLAN.md); `onPersisted` below is the seam they plug
 * into. Nothing here calls a model, and nothing here decides what to say.
 *
 * Everything after the clinic lookup runs inside one `withTenant` transaction,
 * so a half-written conversation cannot survive a crash and RLS applies to
 * every statement.
 */

/** Meta's 24-hour customer service window (COMPLIANCE.md §3). */
export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface InboundDeps {
  /** Pool-level executor for the pre-tenant clinic lookup. */
  executor: SqlExecutor;
  withTenant: WithTenant;
  channelFactory?: ChannelFactory;
  /**
   * Phase 4 hook. Called after everything is persisted and committed, with the
   * ids the engine needs. Today it does nothing — see `docs/BUILD_PLAN.md`
   * Phase 4 (classifier + safety) and Phase 5 (agent).
   */
  onPersisted?: (result: PersistedInbound) => Promise<void>;
}

export interface PersistedInbound {
  clinicId: PrefixedId<"clinic">;
  patientId: string;
  conversationId: string;
  messageId: string;
  /** `agent` | `human` | `muted`. The agent stays silent unless `agent`. */
  conversationMode: string;
  /** True when a human has the conversation (hard rule 3). */
  humanInControl: boolean;
  kind: InboundJobData["kind"];
}

export type InboundOutcome =
  | { status: "processed"; result: PersistedInbound }
  /** The same `wa_message_id` was already stored. Nothing to do. */
  | { status: "duplicate" }
  /** No clinic owns this `phone_number_id`, or the number was disconnected. */
  | { status: "unrouted" }
  /** The `from` was not a phone number we can normalise. */
  | { status: "unusable" };

interface PatientRow {
  id: string;
}
interface ConversationRow {
  id: string;
  mode: string;
}
interface MessageRow {
  id: string;
}

/**
 * Upsert the patient by E.164 (DATA_MODEL: `unique(clinic_id, phone_e164)`).
 *
 * `full_name` is only ever *filled in*, never overwritten: the WhatsApp
 * profile name is whatever the patient set on their phone, and it must not
 * clobber a name front-desk staff typed in from an ID document.
 */
async function upsertPatient(
  client: TenantClient,
  clinicId: string,
  phoneE164: string,
  waId: string,
  profileName: string | undefined,
  at: Date,
): Promise<string> {
  const found = await row<PatientRow>(
    client,
    `insert into patient (id, clinic_id, phone_e164, wa_id, full_name, first_seen_at, last_message_at)
     values ($1, $2, $3, $4, $5, $6, $6)
     on conflict (clinic_id, phone_e164) do update
       set wa_id = excluded.wa_id,
           full_name = coalesce(patient.full_name, excluded.full_name),
           last_message_at = greatest(coalesce(patient.last_message_at, excluded.last_message_at), excluded.last_message_at),
           updated_at = now()
     returning id`,
    [newId("patient"), clinicId, phoneE164, waId, profileName ?? null, at],
  );
  if (!found) throw new Error("patient upsert returned no row");
  return found.id;
}

/**
 * One open conversation per patient per clinic (DATA_MODEL, ARCHITECTURE §2).
 *
 * Not an `on conflict` upsert: "open" is a status, not a unique key — a
 * patient legitimately has many resolved conversations and at most one open
 * one. `for update` serialises two messages arriving together, so a burst does
 * not create two threads.
 */
async function openConversation(
  client: TenantClient,
  clinicId: string,
  patientId: string,
): Promise<ConversationRow> {
  const existing = await row<ConversationRow>(
    client,
    `select id, mode from conversation
     where clinic_id = $1 and patient_id = $2 and status = 'open'
     order by created_at desc
     limit 1
     for update`,
    [clinicId, patientId],
  );
  if (existing) return existing;

  const created = await row<ConversationRow>(
    client,
    `insert into conversation (id, clinic_id, patient_id, mode, status)
     values ($1, $2, $3, 'agent', 'open')
     returning id, mode`,
    [newId("conversation"), clinicId, patientId],
  );
  if (!created) throw new Error("conversation insert returned no row");
  return created;
}

/** Non-text kinds carry no body; keep `meta` small and PHI-free. */
function messageMeta(data: InboundJobData): Record<string, unknown> {
  return {
    wa_type: data.rawType,
    ...(data.replyId === undefined ? {} : { reply_id: data.replyId }),
    ...(data.contextWaMessageId === undefined ? {} : { context_id: data.contextWaMessageId }),
    ...(data.location === undefined ? {} : { location: data.location }),
  };
}

export async function processInboundMessage(
  data: InboundJobData,
  deps: InboundDeps,
): Promise<InboundOutcome> {
  const clinicId = await resolveClinicByPhoneNumberId(deps.executor, data.phoneNumberId);
  if (!clinicId) return { status: "unrouted" };

  // Meta sends `wa_id`: E.164 without the "+". Normalise on ingest, always
  // (CLAUDE.md §Conventions).
  const phoneE164 = (() => {
    try {
      return normalisePhone(`+${data.fromWaId}`);
    } catch {
      return undefined;
    }
  })();
  if (!phoneE164) return { status: "unusable" };

  const sentAt = new Date(data.sentAt);

  const outcome = await deps.withTenant(clinicId, async (client): Promise<InboundOutcome> => {
    const patientId = await upsertPatient(
      client,
      clinicId,
      phoneE164,
      data.fromWaId,
      data.profileName,
      sentAt,
    );
    const conversation = await openConversation(client, clinicId, patientId);

    // The partial unique index on (clinic_id, wa_message_id) is the real
    // idempotency guarantee. `webhook_dedup` stops the common replay; this
    // stops the one that raced it.
    const inserted = await row<MessageRow>(
      client,
      `insert into message
         (id, clinic_id, conversation_id, direction, kind, body, wa_message_id, status, sent_by, meta, at)
       values ($1, $2, $3, 'in', $4, $5, $6, 'received', 'patient', $7::jsonb, $8)
       on conflict (clinic_id, wa_message_id) where wa_message_id is not null do nothing
       returning id`,
      [
        newId("message"),
        clinicId,
        conversation.id,
        data.kind,
        data.body ?? null,
        data.waMessageId,
        JSON.stringify(messageMeta(data)),
        sentAt,
      ],
    );
    if (!inserted) return { status: "duplicate" };

    /**
     * Media: record the pointer, never the content.
     *
     * Real object storage is a later phase (INTEGRATIONS.md §4, Cloudflare
     * R2), so `storage_key` holds the key we *will* write to, derived from the
     * Meta media id. Phase 3 deliberately does not download, transcribe or
     * otherwise interpret what a patient sent.
     */
    if (data.media) {
      await client.query(
        `insert into attachment (id, clinic_id, message_id, storage_key, mime, sha256, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          newId("attachment"),
          clinicId,
          inserted.id,
          `clinic/${clinicId}/media/${data.media.mediaId}`,
          data.media.mime ?? null,
          data.media.sha256 ?? null,
          // 90-day media retention (ARCHITECTURE.md §9).
          new Date(sentAt.getTime() + 90 * 24 * 60 * 60 * 1000),
        ],
      );
    }

    // The 24-hour window moves with the patient's message, not with our clock:
    // Meta measures it from when *they* received it (COMPLIANCE.md §3).
    await client.query(
      `update conversation
         set last_message_at = greatest(coalesce(last_message_at, $2), $2),
             last_patient_message_at = greatest(coalesce(last_patient_message_at, $2), $2),
             session_expires_at = greatest(coalesce(session_expires_at, $3), $3),
             unread_for_staff = unread_for_staff + 1,
             updated_at = now()
       where id = $1`,
      [conversation.id, sentAt, new Date(sentAt.getTime() + SESSION_WINDOW_MS)],
    );

    // Hard rule 7: every message is audited. Ids and kinds only — an audit row
    // must never become a second copy of the message body.
    await client.query(
      `insert into audit_log (id, clinic_id, actor, action, entity, entity_id, after, at)
       values ($1, $2, 'patient', 'message.received', 'message', $3, $4::jsonb, now())`,
      [
        newId("auditLog"),
        clinicId,
        inserted.id,
        JSON.stringify({ kind: data.kind, conversation_id: conversation.id }),
      ],
    );

    return {
      status: "processed",
      result: {
        clinicId,
        patientId,
        conversationId: conversation.id,
        messageId: inserted.id,
        conversationMode: conversation.mode,
        humanInControl: conversation.mode !== "agent",
        kind: data.kind,
      },
    };
  });

  if (outcome.status !== "processed") return outcome;

  // Blue ticks, after the commit and outside the transaction: a slow Graph
  // call must not hold a tenant transaction open, and `markRead` swallows its
  // own failures by design.
  await markRead(clinicId, data.waMessageId, deps);

  /**
   * Phase 4 seam.
   *
   * When `humanInControl` is true the agent must stay silent until handback
   * (hard rule 3) — the inbox still gets the message through the unread count
   * and, once Phase 8 lands, the SSE stream. Otherwise Phase 4 classifies and
   * routes from here. There is deliberately no model call in Phase 3.
   */
  if (deps.onPersisted && !outcome.result.humanInControl) {
    await deps.onPersisted(outcome.result);
  }

  return outcome;
}

/** Best effort — never fails the job (see `WhatsAppChannel.markRead`). */
async function markRead(
  clinicId: PrefixedId<"clinic">,
  waMessageId: string,
  deps: InboundDeps,
): Promise<void> {
  const factory = deps.channelFactory ?? defaultChannelFactory;
  try {
    const sender = await deps.withTenant(clinicId, (client) => loadSender(client, clinicId));
    if (!sender) return;
    await factory(sender).markRead(waMessageId);
  } catch {
    // A read receipt is cosmetic. The message is already stored and the job
    // must not replay over it.
  }
}

/**
 * `inbound.status` — a delivery receipt for a message *we* sent.
 *
 * Statuses only ever move forwards (`sent` → `delivered` → `read`); Meta does
 * not guarantee ordering, and a late `delivered` must not undo a `read`. The
 * rank comparison in SQL is what enforces that.
 */
const STATUS_RANK: Record<StatusJobData["status"], number> = {
  sent: 1,
  delivered: 2,
  read: 3,
  // A failure is terminal and always wins: staff need to see it.
  failed: 4,
};

export type StatusOutcome =
  | { status: "updated" }
  | { status: "stale" }
  | { status: "unknown_message" }
  | { status: "unrouted" };

export async function processStatusUpdate(
  data: StatusJobData,
  deps: Pick<InboundDeps, "executor" | "withTenant">,
): Promise<StatusOutcome> {
  const clinicId = await resolveClinicByPhoneNumberId(deps.executor, data.phoneNumberId);
  if (!clinicId) return { status: "unrouted" };

  return deps.withTenant(clinicId, async (client): Promise<StatusOutcome> => {
    const existing = await row<{ id: string; status: string | null }>(
      client,
      `select id, status from message
       where clinic_id = $1 and wa_message_id = $2 and direction = 'out'
       limit 1`,
      [clinicId, data.waMessageId],
    );
    // We can receive a status for a message we never stored — a staff member
    // replying from the WhatsApp app on their phone, for instance.
    if (!existing) return { status: "unknown_message" };

    const currentRank = STATUS_RANK[existing.status as StatusJobData["status"]] ?? 0;
    if (STATUS_RANK[data.status] <= currentRank) return { status: "stale" };

    await client.query(
      `update message
         set status = $2,
             meta = meta || $3::jsonb,
             updated_at = now()
       where id = $1`,
      [
        existing.id,
        data.status,
        JSON.stringify({
          [`${data.status}_at`]: data.at,
          ...(data.errorCode === undefined ? {} : { error_code: data.errorCode }),
        }),
      ],
    );

    // A failed send is the one status staff must be able to find later.
    if (data.status === "failed") {
      await client.query(
        `insert into audit_log (id, clinic_id, actor, action, entity, entity_id, after, at)
         values ($1, $2, 'system', 'message.failed', 'message', $3, $4::jsonb, now())`,
        [
          newId("auditLog"),
          clinicId,
          existing.id,
          JSON.stringify({ error_code: data.errorCode ?? null }),
        ],
      );
    }

    return { status: "updated" };
  });
}

/** Exported for the integration tests; not part of the job API. */
export const __testing = { upsertPatient, openConversation, rows };
