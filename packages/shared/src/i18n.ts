import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Patient-facing string catalogue.
 *
 * CLAUDE.md: "patient-facing strings in `shared/i18n/{en,sw}.json`; agent may
 * reply in English, Swahili or Sheng matching the patient."
 *
 * Sheng is deliberately NOT a locale: it is a register the agent writes in at
 * generation time. Scripted, safety-critical replies (emergency, distress,
 * refusals) only ever ship in `en` and `sw`, because those are the ones a
 * clinician has reviewed. Never let the model paraphrase them.
 */

export const LANGUAGES = ["en", "sw"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "en";

export type Catalogue = Record<string, string>;

/**
 * `../i18n` resolves to `packages/shared/i18n` from both `src/` (dev, vitest)
 * and `dist/` (built), because tsc emits a flat dist.
 */
function loadCatalogue(language: Language): Catalogue {
  const path = fileURLToPath(new URL(`../i18n/${language}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Catalogue;
}

const catalogues = new Map<Language, Catalogue>();

export function getCatalogue(language: Language): Catalogue {
  let catalogue = catalogues.get(language);
  if (!catalogue) {
    catalogue = loadCatalogue(language);
    catalogues.set(language, catalogue);
  }
  return catalogue;
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

/** Coerce anything (a classifier label, a stored preference) to a Language. */
export function toLanguage(value: unknown): Language {
  return isLanguage(value) ? value : DEFAULT_LANGUAGE;
}

export type TranslationVars = Record<string, string | number>;

const PLACEHOLDER_RE = /\{(\w+)\}/g;

export function interpolate(template: string, vars: TranslationVars = {}): string {
  return template.replace(PLACEHOLDER_RE, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Look up `key` in `language`, falling back to English, then to the key itself
 * so a missing string is loud in review but never crashes a patient reply.
 */
export function t(language: Language, key: string, vars: TranslationVars = {}): string {
  const template = getCatalogue(language)[key] ?? getCatalogue(DEFAULT_LANGUAGE)[key] ?? key;
  return interpolate(template, vars);
}

/** Bind a language once, e.g. per conversation. */
export function translator(language: Language): (key: string, vars?: TranslationVars) => string {
  return (key, vars) => t(language, key, vars);
}

/** Every key present in the English catalogue — the source of truth. */
export function translationKeys(): string[] {
  return Object.keys(getCatalogue(DEFAULT_LANGUAGE));
}
