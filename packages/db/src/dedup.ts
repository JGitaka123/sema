import type { SqlExecutor } from "./sql-executor.js";

/**
 * Inbound webhook de-duplication (CLAUDE.md §Idempotency).
 *
 * Meta retries a webhook until it gets a 2xx, and it re-delivers on its own
 * schedule besides — so the same `wa_message_id` will arrive more than once in
 * normal operation, not just when something is broken. Daraja does the same
 * with `CheckoutRequestID`.
 *
 * `insert … on conflict do nothing` makes the *database* the arbiter rather
 * than a read-then-write in the handler, which would race two concurrent
 * deliveries of the same message straight past each other.
 *
 * `webhook_dedup` has no `clinic_id` and therefore no RLS: the handler must
 * dedup before it knows which clinic the payload belongs to, and vendor
 * message ids are opaque strings, not patient data. See the comment on the
 * table in `schema/ops.ts`.
 */

export type WebhookSource = "whatsapp" | "daraja";

/**
 * Claim an external webhook id. `true` means this caller is the first to see
 * it and owns processing it; `false` means it is a replay and must be dropped
 * (still acking 200 — a retry that gets a 5xx just comes back again).
 */
export async function claimWebhook(
  executor: SqlExecutor,
  source: WebhookSource,
  externalId: string,
): Promise<boolean> {
  const result = await executor.query(
    `insert into webhook_dedup (source, external_id)
     values ($1, $2)
     on conflict (source, external_id) do nothing`,
    [source, externalId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Claim several ids in one round trip, returning only the ones newly claimed.
 *
 * One webhook delivery can carry several messages; doing this per id would be
 * several round trips inside the < 3s ack budget (hard rule 6).
 */
export async function claimWebhooks(
  executor: SqlExecutor,
  source: WebhookSource,
  externalIds: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(externalIds)];
  if (unique.length === 0) return [];

  const result = await executor.query<{ external_id: string }>(
    `insert into webhook_dedup (source, external_id)
     select $1, id from unnest($2::text[]) as id
     on conflict (source, external_id) do nothing
     returning external_id`,
    [source, unique],
  );
  return result.rows.map((row) => row.external_id);
}
