import { EN_TERMS } from "./lexicon.en.js";
import { SW_TERMS } from "./lexicon.sw.js";
import { matchTerms, normalise, type LexiconMatch, type LexiconTerm } from "./lexicon.js";

export * from "./lexicon.js";
export { EN_TERMS } from "./lexicon.en.js";
export { SW_TERMS } from "./lexicon.sw.js";

/**
 * Every term, both catalogues.
 *
 * Both lists run over every message regardless of the detected language: a
 * Sheng sentence ("chest inaniuma na sina hewa") legitimately draws from both,
 * and language detection happens *after* the lexicon, so we could not filter
 * by language even if we wanted to.
 */
export const ALL_TERMS: readonly LexiconTerm[] = [...EN_TERMS, ...SW_TERMS];

/**
 * The deterministic safety check. Runs before the model on every inbound
 * message (CLAUDE.md hard rule 1) and cannot be bypassed or overruled.
 */
export function matchSafetyLexicon(input: string): LexiconMatch {
  return matchTerms(normalise(input), ALL_TERMS);
}
