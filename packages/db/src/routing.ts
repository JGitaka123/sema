import { isId, type PrefixedId } from "@sema/shared";

import type { SqlExecutor } from "./sql-executor.js";

/**
 * Inbound WhatsApp routing: `phone_number_id` → clinic.
 *
 * ARCHITECTURE.md §2 step 2. This is the one lookup in the whole system that
 * legitimately runs without a tenant context, because its entire job is to
 * *find* the tenant. It goes through the `sema_resolve_clinic_by_phone_number_id`
 * SECURITY DEFINER function created in `drizzle/0001_whatsapp_channel.sql`,
 * which returns a clinic id and nothing else — see the long comment there for
 * why that is safe and why BYPASSRLS is not.
 *
 * Everything after this point runs inside `withTenant(clinicId, …)`.
 */
export async function resolveClinicByPhoneNumberId(
  executor: SqlExecutor,
  phoneNumberId: string,
): Promise<PrefixedId<"clinic"> | undefined> {
  const trimmed = phoneNumberId.trim();
  if (trimmed === "") return undefined;

  const result = await executor.query<{ clinic_id: string | null }>(
    `select sema_resolve_clinic_by_phone_number_id($1) as clinic_id`,
    [trimmed],
  );

  const clinicId = result.rows[0]?.clinic_id;
  // A malformed value in that column would otherwise reach `withTenant` and
  // set the tenant GUC to nonsense; better to look unrouted.
  return isId("clinic", clinicId) ? clinicId : undefined;
}
