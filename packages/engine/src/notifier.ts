import { maskPhone } from "@sema/shared";

import type { NotifyChannel } from "./router.js";
import type { EscalationKind } from "./types.js";

/**
 * Notification seam.
 *
 * SAFETY.md §3 requires an emergency to "push + WhatsApp alert to
 * `clinic.emergency_contact_phone` and on-duty staff", and §6 requires
 * escalations to "surface within 5s in the inbox with sound". Both of those
 * are other phases' code — SSE lives in `apps/api` (Phase 8) and WhatsApp
 * sending lives in `packages/channels` (Phase 3, being built concurrently on
 * another branch) — so this package defines the interface and ships a no-op
 * and a recording implementation, and calls neither of those packages.
 *
 * Phase 5 wires a real `Notifier` in when it assembles the inbound pipeline.
 */

export interface EscalationNotification {
  readonly escalationId: string;
  readonly clinicId: string;
  readonly conversationId: string;
  readonly kind: EscalationKind;
  readonly channels: readonly NotifyChannel[];
  readonly createdAt: Date;
  /**
   * The clinic's alerting number, **masked** (`+254•••••678`).
   *
   * Hard rule 4 — a notification payload ends up in logs and in Sentry
   * breadcrumbs. An implementation that needs the real number looks it up from
   * `clinic.emergency_contact_phone` inside the tenant boundary; it does not
   * receive it here.
   */
  readonly emergencyContactMasked?: string;
}

export interface Notifier {
  notify(notification: EscalationNotification): Promise<void>;
}

/** Used in tests and in any environment where alerting is not configured yet. */
export const noopNotifier: Notifier = {
  async notify(): Promise<void> {
    // Intentionally empty.
  },
};

export interface RecordingNotifier extends Notifier {
  readonly sent: readonly EscalationNotification[];
}

/** A `Notifier` that keeps what it was asked to send, for assertions. */
export function createRecordingNotifier(): RecordingNotifier {
  const sent: EscalationNotification[] = [];
  return {
    sent,
    async notify(notification) {
      sent.push(notification);
    },
  };
}

/** Convenience for building the masked field without reaching for `maskPhone`. */
export function maskEmergencyContact(phone: string | null | undefined): string | undefined {
  return typeof phone === "string" && phone !== "" ? maskPhone(phone) : undefined;
}
