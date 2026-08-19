import { AppError, type E164 } from "@sema/shared";
import { describe, expect, it } from "vitest";

import type { InteractiveOption } from "../types.js";
import {
  WHATSAPP_LIMITS,
  buildInteractivePayload,
  buildLocationPayload,
  buildMarkReadPayload,
  buildTemplatePayload,
  buildTextPayload,
  type ButtonsPayload,
  type ListPayload,
} from "./payloads.js";

const TO = "+254712000001" as E164;

const options = (count: number): InteractiveOption[] =>
  Array.from({ length: count }, (_, i) => ({ id: `opt_${i}`, title: `Option ${i}` }));

describe("buildTextPayload", () => {
  it("addresses the recipient the way Meta's own webhooks do — no leading +", () => {
    const payload = buildTextPayload({ kind: "text", to: TO, body: "Karibu Afyanex" });
    expect(payload.to).toBe("254712000001");
    expect(payload).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      type: "text",
      text: { body: "Karibu Afyanex", preview_url: false },
    });
  });

  it("keeps link previews off unless asked", () => {
    expect(buildTextPayload({ kind: "text", to: TO, body: "hi" }).text.preview_url).toBe(false);
    expect(
      buildTextPayload({ kind: "text", to: TO, body: "hi", previewUrl: true }).text.preview_url,
    ).toBe(true);
  });

  it("trims, because a trailing newline is a wasted line in the chat", () => {
    expect(buildTextPayload({ kind: "text", to: TO, body: "  hi  \n" }).text.body).toBe("hi");
  });

  it("rejects an empty body rather than sending a blank bubble", () => {
    expect(() => buildTextPayload({ kind: "text", to: TO, body: "   " })).toThrow(AppError);
  });

  it("rejects a body over Meta's 4096-character limit", () => {
    const body = "a".repeat(WHATSAPP_LIMITS.textBody + 1);
    expect(() => buildTextPayload({ kind: "text", to: TO, body })).toThrow(AppError);
  });

  it("rejects a recipient that is not E.164", () => {
    expect(() =>
      buildTextPayload({ kind: "text", to: "254712000001" as E164, body: "hi" }),
    ).toThrow(AppError);
  });

  it("never puts the body or the number in the thrown error (hard rule 4)", () => {
    const secret = "b".repeat(WHATSAPP_LIMITS.textBody + 1);
    try {
      buildTextPayload({ kind: "text", to: TO, body: secret });
      expect.unreachable("should have thrown");
    } catch (error) {
      const serialised = JSON.stringify({
        message: (error as AppError).message,
        meta: (error as AppError).meta,
      });
      expect(serialised).not.toContain(secret);
      expect(serialised).not.toContain("254712000001");
    }
  });
});

describe("buildInteractivePayload", () => {
  it("uses reply buttons for three options or fewer", () => {
    for (const count of [1, 2, 3]) {
      const payload = buildInteractivePayload({
        kind: "interactive",
        to: TO,
        body: "Pick a time",
        options: options(count),
      }) as ButtonsPayload;
      expect(payload.interactive.type).toBe("button");
      expect(payload.interactive.action.buttons).toHaveLength(count);
      expect(payload.interactive.action.buttons[0]).toEqual({
        type: "reply",
        reply: { id: "opt_0", title: "Option 0" },
      });
    }
  });

  it("switches to a list at four options, per INTEGRATIONS.md §1", () => {
    const payload = buildInteractivePayload({
      kind: "interactive",
      to: TO,
      body: "Pick a time",
      options: options(4),
    }) as ListPayload;
    expect(payload.interactive.type).toBe("list");
    expect(payload.interactive.action.sections[0]?.rows).toHaveLength(4);
  });

  it("labels the list button, defaulting to something a patient can act on", () => {
    const withDefault = buildInteractivePayload({
      kind: "interactive",
      to: TO,
      body: "Pick",
      options: options(5),
    }) as ListPayload;
    expect(withDefault.interactive.action.button).toBe("Choose");

    const custom = buildInteractivePayload({
      kind: "interactive",
      to: TO,
      body: "Pick",
      options: options(5),
      listButtonText: "See times",
    }) as ListPayload;
    expect(custom.interactive.action.button).toBe("See times");
  });

  it("carries row descriptions when given, and omits the key when not", () => {
    const payload = buildInteractivePayload({
      kind: "interactive",
      to: TO,
      body: "Pick",
      options: [
        ...options(3),
        { id: "opt_3", title: "Option 3", description: "Dr. Wanjiru, Kilimani" },
      ],
    }) as ListPayload;
    const rows = payload.interactive.action.sections[0]?.rows ?? [];
    expect(rows[3]).toMatchObject({ description: "Dr. Wanjiru, Kilimani" });
    expect(rows[0]).not.toHaveProperty("description");
  });

  it("includes header and footer only when supplied", () => {
    const bare = buildInteractivePayload({
      kind: "interactive",
      to: TO,
      body: "Pick",
      options: options(2),
    });
    expect(bare.interactive).not.toHaveProperty("header");
    expect(bare.interactive).not.toHaveProperty("footer");

    const full = buildInteractivePayload({
      kind: "interactive",
      to: TO,
      body: "Pick",
      options: options(2),
      header: "Afyanex",
      footer: "Reply STOP to opt out",
    });
    expect(full.interactive.header).toEqual({ type: "text", text: "Afyanex" });
    expect(full.interactive.footer).toEqual({ text: "Reply STOP to opt out" });
  });

  it("refuses more options than a list can hold", () => {
    expect(() =>
      buildInteractivePayload({
        kind: "interactive",
        to: TO,
        body: "Pick",
        options: options(WHATSAPP_LIMITS.maxListRows + 1),
      }),
    ).toThrow(AppError);
  });

  it("refuses zero options", () => {
    expect(() =>
      buildInteractivePayload({ kind: "interactive", to: TO, body: "Pick", options: [] }),
    ).toThrow(AppError);
  });

  it("refuses duplicate ids — a reply must map to exactly one slot", () => {
    expect(() =>
      buildInteractivePayload({
        kind: "interactive",
        to: TO,
        body: "Pick",
        options: [
          { id: "same", title: "Nine" },
          { id: "same", title: "Ten" },
        ],
      }),
    ).toThrow(AppError);
  });

  it("refuses a button title over 20 characters", () => {
    expect(() =>
      buildInteractivePayload({
        kind: "interactive",
        to: TO,
        body: "Pick",
        options: [{ id: "a", title: "x".repeat(WHATSAPP_LIMITS.buttonTitle + 1) }],
      }),
    ).toThrow(AppError);
  });
});

describe("buildTemplatePayload", () => {
  it("builds a bare template with no components", () => {
    const payload = buildTemplatePayload({
      kind: "template",
      to: TO,
      templateName: "appt_reminder_24h",
      language: "sw",
    });
    expect(payload.template).toEqual({ name: "appt_reminder_24h", language: { code: "sw" } });
    expect(payload.template).not.toHaveProperty("components");
  });

  it("orders components header, body, button — the order Meta expects", () => {
    const payload = buildTemplatePayload({
      kind: "template",
      to: TO,
      templateName: "appt_confirmation",
      language: "en",
      headerParameters: ["Afyanex"],
      bodyParameters: ["Amina", "Thursday 9:00 AM"],
      buttonParameters: [{ index: 0, parameters: ["apt_01J"] }],
    });
    expect(payload.template.components?.map((c) => c.type)).toEqual(["header", "body", "button"]);
    expect(payload.template.components?.[1]?.parameters).toEqual([
      { type: "text", text: "Amina" },
      { type: "text", text: "Thursday 9:00 AM" },
    ]);
    expect(payload.template.components?.[2]).toMatchObject({ sub_type: "url", index: "0" });
  });

  it("rejects a template name Meta would reject", () => {
    for (const name of ["Appt Reminder", "appt-reminder", ""]) {
      expect(() =>
        buildTemplatePayload({ kind: "template", to: TO, templateName: name, language: "en" }),
      ).toThrow(AppError);
    }
  });

  it("rejects parameters with newlines, which Meta silently 400s on", () => {
    expect(() =>
      buildTemplatePayload({
        kind: "template",
        to: TO,
        templateName: "appt_confirmation",
        language: "en",
        bodyParameters: ["Thursday\n9:00 AM"],
      }),
    ).toThrow(AppError);
  });
});

describe("buildLocationPayload", () => {
  it("sends the clinic pin with its name and address", () => {
    const payload = buildLocationPayload({
      kind: "location",
      to: TO,
      latitude: -1.2921,
      longitude: 36.7833,
      name: "Afyanex Clinic — Kilimani",
      address: "Wood Avenue Plaza",
    });
    expect(payload.location).toEqual({
      latitude: -1.2921,
      longitude: 36.7833,
      name: "Afyanex Clinic — Kilimani",
      address: "Wood Avenue Plaza",
    });
  });

  it("rejects coordinates outside the globe", () => {
    expect(() =>
      buildLocationPayload({ kind: "location", to: TO, latitude: 91, longitude: 0 }),
    ).toThrow(AppError);
    expect(() =>
      buildLocationPayload({ kind: "location", to: TO, latitude: 0, longitude: -181 }),
    ).toThrow(AppError);
  });
});

describe("buildMarkReadPayload", () => {
  it("marks a specific inbound message read", () => {
    expect(buildMarkReadPayload("wamid.ABC")).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.ABC",
    });
  });

  it("rejects an empty id", () => {
    expect(() => buildMarkReadPayload("  ")).toThrow(AppError);
  });
});
