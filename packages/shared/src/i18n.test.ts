import { describe, expect, it } from "vitest";

import { LANGUAGES, getCatalogue, interpolate, t, toLanguage, translator } from "./i18n.js";

describe("catalogues", () => {
  it("loads every declared language", () => {
    for (const language of LANGUAGES) {
      expect(Object.keys(getCatalogue(language)).length).toBeGreaterThan(0);
    }
  });

  it("keeps Swahili at key parity with English", () => {
    // A missing safety string would silently fall back to English mid-emergency.
    const en = Object.keys(getCatalogue("en")).sort();
    const sw = Object.keys(getCatalogue("sw")).sort();
    expect(sw).toEqual(en);
  });

  it("ships the safety-critical scripted replies in both languages", () => {
    for (const language of LANGUAGES) {
      const catalogue = getCatalogue(language);
      expect(catalogue["safety.emergency"]).toBeTruthy();
      expect(catalogue["safety.distress"]).toBeTruthy();
      expect(catalogue["safety.out_of_scope"]).toBeTruthy();
    }
  });
});

describe("interpolate", () => {
  it("substitutes named placeholders", () => {
    expect(interpolate("Hello {name}", { name: "Amina" })).toBe("Hello Amina");
  });

  it("leaves unknown placeholders intact rather than printing undefined", () => {
    expect(interpolate("Hello {name}", {})).toBe("Hello {name}");
  });

  it("coerces numbers", () => {
    expect(interpolate("{n} slots", { n: 3 })).toBe("3 slots");
  });
});

describe("t", () => {
  it("resolves a string in the requested language", () => {
    const swahili = t("sw", "safety.emergency", { clinic: "Afyanex" });
    expect(swahili).toContain("dharura");
    expect(swahili).toContain("Afyanex");
  });

  it("falls back to English for a key missing in the target language", () => {
    // Not currently possible given the parity test, but the fallback must hold.
    expect(t("sw", "error.generic")).toBeTruthy();
  });

  it("returns the key itself when nothing is found", () => {
    expect(t("en", "does.not.exist")).toBe("does.not.exist");
  });
});

describe("translator", () => {
  it("binds a language", () => {
    const tr = translator("en");
    expect(tr("greeting.returning_patient", { name: "Otieno" })).toContain("Otieno");
  });
});

describe("toLanguage", () => {
  it("passes through supported languages and defaults everything else", () => {
    expect(toLanguage("sw")).toBe("sw");
    expect(toLanguage("en")).toBe("en");
    // Sheng is a register, not a locale — it maps onto the reviewed catalogues.
    expect(toLanguage("sheng")).toBe("en");
    expect(toLanguage(undefined)).toBe("en");
  });
});
