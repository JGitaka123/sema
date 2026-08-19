import { LANGUAGES, getCatalogue } from "@sema/shared";
import { describe, expect, it } from "vitest";

import {
  SCRIPTED_KEYS,
  abuseWarningReply,
  consentNoticeReply,
  distressReply,
  emergencyReply,
  handoverReply,
  outOfScopeReply,
  resolveReplyLanguage,
  type ClinicScriptConfig,
} from "./replies.js";

const CLINIC: ClinicScriptConfig = {
  name: "Afyanex",
  defaultLanguage: "en",
  providerLabel: "Dr Wanjiru",
  clinicPhone: "+254700000000",
  privacyUrl: "afyanex.co.ke/privacy",
  opensAt: "8am",
};

describe("i18n coverage", () => {
  it.each(LANGUAGES)("has every scripted key in %s", (language) => {
    const catalogue = getCatalogue(language);
    const missing = SCRIPTED_KEYS.filter((key) => catalogue[key] === undefined);
    expect(missing, `missing keys in ${language}.json`).toEqual([]);
  });

  it("has no key present in one language but not the other", () => {
    // A key that exists only in English silently falls back to English for
    // Swahili speakers — safe, but nobody notices, so the drift compounds.
    const en = new Set(Object.keys(getCatalogue("en")));
    const sw = new Set(Object.keys(getCatalogue("sw")));
    expect([...en].filter((k) => !sw.has(k))).toEqual([]);
    expect([...sw].filter((k) => !en.has(k))).toEqual([]);
  });

  it("leaves no unresolved placeholder in any rendered safety script", () => {
    for (const language of LANGUAGES) {
      const lang = { language, register: "standard" as const };
      const rendered = [
        emergencyReply(CLINIC, lang),
        distressReply(CLINIC, lang),
        outOfScopeReply(CLINIC, lang),
        abuseWarningReply(CLINIC, lang),
        consentNoticeReply(CLINIC, lang),
        handoverReply(CLINIC, lang, true),
        handoverReply(CLINIC, lang, false),
      ];
      for (const reply of rendered) {
        expect(reply.body, `${reply.key} (${language})`).not.toMatch(/\{[a-z_]+\}/);
        expect(reply.body.length).toBeGreaterThan(20);
      }
    }
  });
});

describe("resolveReplyLanguage", () => {
  it.each([
    ["en", "en", "standard"],
    ["sw", "sw", "standard"],
    ["sheng", "sw", "casual"],
  ] as const)("maps %s to %s/%s", (detected, language, register) => {
    expect(resolveReplyLanguage(detected, "en")).toEqual({ language, register });
  });

  it.each(["mixed", "other", undefined] as const)(
    "falls back to the clinic default for %s",
    (detected) => {
      expect(resolveReplyLanguage(detected, "sw").language).toBe("sw");
      expect(resolveReplyLanguage(detected, "en").language).toBe("en");
    },
  );
});

describe("safety scripts", () => {
  const en = { language: "en" as const, register: "standard" as const };

  it("emergency script names the emergency numbers and the clinic", () => {
    const reply = emergencyReply(CLINIC, en);
    expect(reply.body).toContain("999");
    expect(reply.body).toContain("112");
    expect(reply.body).toContain("Afyanex");
  });

  it("emergency override is used verbatim apart from placeholders", () => {
    const reply = emergencyReply(
      { ...CLINIC, emergencyScriptOverride: "  {clinic} emergency line: 0800 720 000.  " },
      en,
    );
    expect(reply.body).toBe("Afyanex emergency line: 0800 720 000.");
  });

  it("an empty override falls back to the reviewed script", () => {
    const reply = emergencyReply({ ...CLINIC, emergencyScriptOverride: "   " }, en);
    expect(reply.key).toBe("safety.emergency");
  });

  it("distress script offers help without counselling", () => {
    const reply = distressReply(CLINIC, en);
    expect(reply.body).toContain("1199");
    // SAFETY.md §4: "reply with warmth, do not counsel".
    expect(reply.body).toContain("front-desk assistant");
  });

  it("out-of-scope script refuses advice and offers a booking or a human", () => {
    const reply = outOfScopeReply(CLINIC, en);
    expect(reply.body).toContain("cannot advise");
    expect(reply.body).toContain("Dr Wanjiru");
    expect(reply.body).toContain("nurse");
  });

  it("out-of-scope names a generic provider in each language when none is configured", () => {
    expect(outOfScopeReply({ ...CLINIC, providerLabel: null }, en).body).toContain("a doctor");
    expect(
      outOfScopeReply({ ...CLINIC, providerLabel: null }, { language: "sw", register: "standard" })
        .body,
    ).toContain("daktari");
  });

  it("consent notice carries the AI disclosure, the opt-out and the privacy link", () => {
    // COMPLIANCE.md §1 and §6.
    const reply = consentNoticeReply(CLINIC, en);
    expect(reply.body).toContain("AI");
    expect(reply.body).toContain("STOP");
    expect(reply.body).toContain("afyanex.co.ke/privacy");
  });
});
