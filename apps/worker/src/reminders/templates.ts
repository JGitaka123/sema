import type { OutboundTemplate } from "@sema/channels";
import {
  formatAppointmentTime,
  formatInTz,
  toLanguage,
  type E164,
  type TimeZone,
} from "@sema/shared";

import type { ReminderKind } from "./config.js";

/**
 * The approved WhatsApp templates a reminder goes out on.
 *
 * COMPLIANCE.md §3: proactive messages live outside the 24-hour customer
 * service window essentially by definition — a reminder is sent because the
 * patient has *not* written to us — so a reminder is always a template, never
 * free-form text with a fallback. `chooseDelivery` in `jobs/outbox.ts` passes a
 * template through untouched for exactly this reason.
 *
 * Names are the ones Sema registers per WABA during onboarding
 * (INTEGRATIONS.md §1). Renaming one here without re-submitting it to Meta
 * makes every reminder fail with a Meta template error.
 */
export const REMINDER_TEMPLATES: Readonly<Record<ReminderKind, string>> = {
  pre_24h: "appt_reminder_24h",
  pre_2h: "appt_reminder_2h",
  no_show_rebook: "rebook_after_no_show",
};

export interface ReminderTemplateContext {
  readonly to: E164;
  /** Preferred name, then full name. Never a phone number. */
  readonly patientName: string | null;
  readonly serviceName: string;
  readonly providerName: string;
  readonly locationName: string | null;
  readonly start: Date;
  readonly timezone: TimeZone;
  /** Patient's language, falling back to the clinic default. */
  readonly language: string;
}

/** What we call a patient whose name we never learned. */
const ANONYMOUS = "there";

function greeting(name: string | null): string {
  const trimmed = name?.trim();
  if (!trimmed) return ANONYMOUS;
  // First token only: WhatsApp template parameters may not contain newlines,
  // and "Wanjiru" reads better than "Wanjiru Mwangi" in a one-line reminder.
  return trimmed.split(/\s+/)[0] ?? ANONYMOUS;
}

/**
 * Positional body parameters, in the order the registered template declares
 * them. Changing an order here silently changes what patients read, so the
 * order is asserted in `templates.test.ts`.
 *
 *   appt_reminder_24h   {{1}} name  {{2}} service  {{3}} provider  {{4}} when   {{5}} location
 *   appt_reminder_2h    {{1}} name  {{2}} service  {{3}} provider  {{4}} time
 *   rebook_after_no_show {{1}} name {{2}} service  {{3}} when
 */
export function reminderTemplateParameters(
  kind: ReminderKind,
  context: ReminderTemplateContext,
): string[] {
  const name = greeting(context.patientName);
  const when = formatAppointmentTime(context.start, context.timezone);

  switch (kind) {
    case "pre_24h":
      return [
        name,
        context.serviceName,
        context.providerName,
        when,
        context.locationName ?? "our clinic",
      ];
    case "pre_2h":
      return [
        name,
        context.serviceName,
        context.providerName,
        formatInTz(context.start, context.timezone, "h:mm a"),
      ];
    case "no_show_rebook":
      return [name, context.serviceName, when];
  }
}

/** Build the outbound template message for a due reminder. */
export function reminderTemplate(
  kind: ReminderKind,
  context: ReminderTemplateContext,
): OutboundTemplate {
  return {
    kind: "template",
    to: context.to,
    templateName: REMINDER_TEMPLATES[kind],
    // Only `en`/`sw` templates are registered; Sheng is a register the agent
    // writes in, never a template locale (packages/shared/src/i18n.ts).
    language: toLanguage(context.language),
    bodyParameters: reminderTemplateParameters(kind, context),
  };
}
