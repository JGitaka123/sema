import { maskPhone } from "@sema/shared";

/**
 * How a digest reaches the people it is for.
 *
 * Two routes, and they are deliberately different in maturity:
 *
 *  - **WhatsApp**, for staff who have a number on file. It goes through the
 *    outbox like everything else (`enqueueStaffNotification` in
 *    `jobs/outbox.ts`), so it inherits retry, backoff and dead-lettering, and
 *    it is not this module's concern.
 *  - **Email**, which SPEC §4.8 asks for ("Weekly WhatsApp/email digest to
 *    owner") and which Sema has no transport for yet. This file is the seam:
 *    an interface, a no-op implementation and a recording one. Phase 10 drops
 *    a real transport in without touching a job.
 *
 * The recipient carries a **masked** phone (`+254••••••678`), following
 * `packages/engine/src/notifier.ts`: a delivery payload is the sort of object
 * that ends up in a log line or a Sentry breadcrumb, and hard rule 4 does not
 * make an exception for staff numbers. An implementation that needs the real
 * number looks it up inside the tenant boundary.
 */

export type DigestKind = "owner_weekly" | "staff_morning";

export interface DigestRecipient {
  readonly staffUserId: string;
  readonly name: string;
  /** `owner` | `admin` | `staff` | `provider`. Never a patient. */
  readonly role: string;
  readonly email: string;
  readonly phoneMasked?: string;
}

export interface DigestMessage {
  readonly clinicId: string;
  readonly clinicName: string;
  readonly kind: DigestKind;
  /** The window's `periodKey` — also the idempotency key in `audit_log`. */
  readonly periodKey: string;
  readonly subject: string;
  readonly body: string;
  readonly recipients: readonly DigestRecipient[];
}

export interface DigestDelivery {
  deliver(message: DigestMessage): Promise<void>;
}

/**
 * The default. Digests still reach staff over WhatsApp; this drops the email
 * copy on the floor until there is a transport, rather than pretending to send.
 */
export const noopDigestDelivery: DigestDelivery = {
  async deliver(): Promise<void> {
    // Intentionally empty. See the module comment.
  },
};

export interface RecordingDigestDelivery extends DigestDelivery {
  readonly delivered: readonly DigestMessage[];
}

export function createRecordingDigestDelivery(): RecordingDigestDelivery {
  const delivered: DigestMessage[] = [];
  return {
    delivered,
    async deliver(message) {
      delivered.push(message);
    },
  };
}

/** Build a recipient with its phone already masked. */
export function digestRecipient(input: {
  staffUserId: string;
  name: string;
  role: string;
  email: string;
  phone?: string | null;
}): DigestRecipient {
  return {
    staffUserId: input.staffUserId,
    name: input.name,
    role: input.role,
    email: input.email,
    ...(input.phone ? { phoneMasked: maskPhone(input.phone) } : {}),
  };
}
