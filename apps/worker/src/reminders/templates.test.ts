import { describe, expect, it } from "vitest";

import {
  REMINDER_TEMPLATES,
  reminderTemplate,
  reminderTemplateParameters,
  type ReminderTemplateContext,
} from "./templates.js";

/**
 * Template names and parameter order are a contract with Meta, not an
 * implementation detail: the templates are registered per WABA at onboarding
 * (INTEGRATIONS.md §1), and reordering `{{2}}` and `{{3}}` here silently
 * changes what patients read without failing anything at build time.
 */

const context: ReminderTemplateContext = {
  to: "+254712345678",
  patientName: "Wanjiru Mwangi",
  serviceName: "Dental cleaning",
  providerName: "Dr. Otieno",
  locationName: "Afyanex Westlands",
  // Monday 2026-08-17, 09:00 Africa/Nairobi.
  start: new Date("2026-08-17T06:00:00Z"),
  timezone: "Africa/Nairobi",
  language: "en",
};

describe("REMINDER_TEMPLATES", () => {
  it("matches the names registered with Meta (INTEGRATIONS.md §1)", () => {
    expect(REMINDER_TEMPLATES).toEqual({
      pre_24h: "appt_reminder_24h",
      pre_2h: "appt_reminder_2h",
      no_show_rebook: "rebook_after_no_show",
    });
  });
});

describe("reminderTemplateParameters", () => {
  it("renders the 24h reminder in clinic-local time", () => {
    expect(reminderTemplateParameters("pre_24h", context)).toEqual([
      "Wanjiru",
      "Dental cleaning",
      "Dr. Otieno",
      "Mon 17 Aug, 9:00 AM",
      "Afyanex Westlands",
    ]);
  });

  it("renders the 2h reminder as just a time", () => {
    expect(reminderTemplateParameters("pre_2h", context)).toEqual([
      "Wanjiru",
      "Dental cleaning",
      "Dr. Otieno",
      "9:00 AM",
    ]);
  });

  it("renders the rebook nudge with the missed slot", () => {
    expect(reminderTemplateParameters("no_show_rebook", context)).toEqual([
      "Wanjiru",
      "Dental cleaning",
      "Mon 17 Aug, 9:00 AM",
    ]);
  });

  it("uses a first name only — a full name reads wrong in a one-liner", () => {
    expect(reminderTemplateParameters("pre_2h", { ...context, patientName: "Faith" })[0]).toBe(
      "Faith",
    );
  });

  it("falls back gracefully when we never learned a name", () => {
    for (const name of [null, "", "   "]) {
      expect(reminderTemplateParameters("pre_2h", { ...context, patientName: name })[0]).toBe(
        "there",
      );
    }
  });

  it("falls back when the appointment has no location on file", () => {
    expect(reminderTemplateParameters("pre_24h", { ...context, locationName: null })[4]).toBe(
      "our clinic",
    );
  });

  it("never emits a newline or tab — Meta rejects those in a parameter", () => {
    const params = [
      ...reminderTemplateParameters("pre_24h", context),
      ...reminderTemplateParameters("pre_2h", { ...context, patientName: "Ann\nMarie" }),
      ...reminderTemplateParameters("no_show_rebook", context),
    ];
    for (const param of params) expect(param).not.toMatch(/[\r\n\t]/);
  });

  it("renders the same instant differently for a clinic in another timezone", () => {
    const lagos = reminderTemplateParameters("pre_2h", { ...context, timezone: "Africa/Lagos" });
    expect(lagos[3]).toBe("7:00 AM"); // UTC+1
  });
});

describe("reminderTemplate", () => {
  it("is always a template, because the 24h window is closed by definition", () => {
    const message = reminderTemplate("pre_24h", context);
    expect(message.kind).toBe("template");
    expect(message.templateName).toBe("appt_reminder_24h");
    expect(message.to).toBe("+254712345678");
  });

  it("matches the patient's language", () => {
    expect(reminderTemplate("pre_2h", { ...context, language: "sw" }).language).toBe("sw");
  });

  it("falls back to English for a register with no approved template", () => {
    // Sheng is a register the agent writes in, never a template locale.
    expect(reminderTemplate("pre_2h", { ...context, language: "sheng" }).language).toBe("en");
  });
});
