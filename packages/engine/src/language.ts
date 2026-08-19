import { normalise } from "./safety/lexicon.js";
import type { ClassifierLanguage } from "./types.js";

/**
 * A deliberately tiny language heuristic.
 *
 * The model reports `language` on the happy path. This exists only for the
 * paths where there is no model answer — timeout, malformed output, or a
 * lexicon hit that short-circuits before the call — because a patient in an
 * emergency must still get the emergency script in a language they read, and
 * defaulting everyone to English would be worse than a cheap guess.
 *
 * It is a word-list count, not a classifier: Swahili and Sheng share function
 * words that English does not, and two hits is enough signal for choosing
 * between two scripted messages. Anything else falls back to the clinic
 * default, which the router applies.
 */

/** Common Swahili/Sheng function and clinic words. Not clinical vocabulary. */
const SWAHILI_HINTS = [
  "nataka",
  "naomba",
  "tafadhali",
  "asante",
  "habari",
  "mambo",
  "niaje",
  "sasa",
  "poa",
  "sawa",
  "daktari",
  "dakitari",
  "miadi",
  "hospitali",
  "kliniki",
  "leo",
  "kesho",
  "jana",
  "saa",
  "ninaweza",
  "naweza",
  "siwezi",
  "nina",
  "sina",
  "yangu",
  "wangu",
  "mtoto",
  "mimi",
  "wewe",
  "yeye",
  "kuna",
  "hakuna",
  "sana",
  "gani",
  "nini",
  "wapi",
  "lini",
  "kwa",
  "nini",
  "ndio",
  "hapana",
  "mzee",
  "buda",
  "mse",
  "fom",
  "nifanye",
  "kidogo",
  "sijui",
  "hii",
  "hiyo",
  "tena",
  "yako",
  "kujiua",
] as const;

const HINT_SET = new Set<string>(SWAHILI_HINTS);

/**
 * Share of hint words above which the message reads as Swahili rather than
 * code-mixed. A third is enough for the short messages patients actually send
 * ("nataka kujiua" is two words, one of them a hint) without claiming Swahili
 * for an English sentence that happens to contain "sawa".
 */
const SWAHILI_RATIO = 1 / 3;

/**
 * Guess a language for a message when no model answer is available.
 *
 * Returns `other` when there is no signal at all — the caller then uses the
 * clinic's configured default. Note that `sheng` and `sw` resolve to the same
 * reviewed script (see `resolveReplyLanguage`), so the sw/sheng boundary
 * changes register, not comprehension.
 */
export function guessLanguage(input: string): ClassifierLanguage {
  const words = normalise(input).split(" ").filter(Boolean);
  if (words.length === 0) return "other";

  let hits = 0;
  for (const word of words) {
    if (HINT_SET.has(word)) hits += 1;
  }

  if (hits === 0) return "other";
  if (hits / words.length >= SWAHILI_RATIO) return "sw";
  // A sprinkling of Swahili in an otherwise English sentence is the Sheng shape.
  return "sheng";
}
