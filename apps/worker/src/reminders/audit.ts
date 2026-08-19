import type { TenantClient } from "@sema/db";
import { newId } from "@sema/shared";

/**
 * `audit_log` writes for the automated jobs (CLAUDE.md hard rule 7: "Every AI
 * action is audited … bookings, payment requests, escalations, messages").
 *
 * A no-show marking and a reminder send are both state changes nobody asked for
 * in the moment, which makes them exactly the entries a clinic will want to
 * read back when a patient says "you never told me".
 *
 * `after` carries ids, statuses, kinds and counts. Never a name, a phone
 * number, a message body or a template parameter (hard rule 4) — the actual
 * text of a reminder is reconstructable from the template name and the
 * appointment, and does not need a second copy here.
 */

export type AuditActor = "system" | "agent" | "patient" | `staff:${string}`;

export interface AuditInput {
  readonly clinicId: string;
  readonly actor: AuditActor;
  readonly action: string;
  readonly entity: string;
  readonly entityId: string;
  readonly after?: Record<string, string | number | boolean | null>;
  readonly before?: Record<string, string | number | boolean | null>;
  readonly reason?: string | null;
}

export async function writeAudit(client: TenantClient, input: AuditInput): Promise<void> {
  await client.query(
    `insert into audit_log (id, clinic_id, actor, action, entity, entity_id, before, after, reason, at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, now())`,
    [
      newId("auditLog"),
      input.clinicId,
      input.actor,
      input.action,
      input.entity,
      input.entityId,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.reason ?? null,
    ],
  );
}

/**
 * Whether an audit row already exists for this action and entity.
 *
 * Used by the digest jobs as their idempotency key: "did this clinic already
 * get its Monday digest for the week of 2026-08-10?" is a question `audit_log`
 * can already answer, and answering it there avoids a migration for a marker
 * table that would hold one row a week per clinic.
 */
export async function auditExists(
  client: TenantClient,
  clinicId: string,
  action: string,
  entityId: string,
): Promise<boolean> {
  const result = (await client.query(
    `select 1 from audit_log
      where clinic_id = $1 and action = $2 and entity_id = $3 limit 1`,
    [clinicId, action, entityId],
  )) as { rows?: unknown[] } | undefined;
  return (result?.rows?.length ?? 0) > 0;
}

/**
 * Serialise everyone competing to produce the same digest.
 *
 * `auditExists` + insert is a check-then-act, and two workers whose hourly
 * sweeps overlap would otherwise both pass the check. A transaction-scoped
 * advisory lock closes that window without a schema change; it is released at
 * commit, and a second holder simply waits and then sees the row.
 */
export async function lockDigestKey(
  client: TenantClient,
  clinicId: string,
  key: string,
): Promise<void> {
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `${clinicId}:${key}`,
  ]);
}
