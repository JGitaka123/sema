import { WhatsAppChannel, type Channel } from "@sema/channels";
import { AppError, type PrefixedId } from "@sema/shared";
import type { TenantClient } from "@sema/db";

/**
 * Building a `Channel` for a clinic.
 *
 * The credentials live on `clinic_whatsapp`, one row per clinic (ADR-001), and
 * are read inside the tenant transaction that is already open — so RLS decides
 * whether this job may see them, exactly as it does for patient rows.
 *
 * The access token is decrypted here and lives only as long as the send. It is
 * never logged, never put in a job payload, never returned by an API route.
 * Envelope decryption itself arrives with the onboarding flow that writes the
 * ciphertext (Phase 9, ARCHITECTURE.md §9); until then the column holds a
 * plaintext token in dev, and `decryptToken` is the single seam where the real
 * implementation lands.
 */

export interface ClinicSender {
  phoneNumberId: string;
  accessToken: string;
  displayPhoneNumber?: string;
}

/**
 * Phase 9 replaces this with envelope decryption (KMS master key → per-tenant
 * DEK → AES-256-GCM). One function, one place to change.
 */
function decryptToken(stored: string): string {
  return stored;
}

/** Read the clinic's connected sender. Returns undefined when not connected. */
export async function loadSender(
  client: TenantClient,
  clinicId: PrefixedId<"clinic">,
): Promise<ClinicSender | undefined> {
  const result = (await client.query(
    `select phone_number_id, access_token_encrypted, display_phone_number
     from clinic_whatsapp
     where clinic_id = $1 and is_active
     limit 1`,
    [clinicId],
  )) as {
    rows: {
      phone_number_id: string;
      access_token_encrypted: string | null;
      display_phone_number: string | null;
    }[];
  };

  const row = result.rows[0];
  if (!row?.access_token_encrypted) return undefined;

  return {
    phoneNumberId: row.phone_number_id,
    accessToken: decryptToken(row.access_token_encrypted),
    ...(row.display_phone_number === null ? {} : { displayPhoneNumber: row.display_phone_number }),
  };
}

/** How a job gets a channel. Injected so jobs are testable without Meta. */
export type ChannelFactory = (sender: ClinicSender) => Channel;

export const defaultChannelFactory: ChannelFactory = (sender) =>
  new WhatsAppChannel({
    phoneNumberId: sender.phoneNumberId,
    accessToken: sender.accessToken,
    graphVersion: process.env["WHATSAPP_GRAPH_VERSION"] ?? "v20.0",
  });

export function requireSender(sender: ClinicSender | undefined): ClinicSender {
  if (!sender) {
    // Not an error the patient caused, and nothing retryable: the clinic has
    // not finished (or has revoked) Embedded Signup.
    throw new AppError("UPSTREAM_UNAVAILABLE", "Clinic has no connected WhatsApp sender.", {
      expose: false,
    });
  }
  return sender;
}
