/**
 * Deterministic safety lexicon — the belt to the classifier's braces.
 *
 * SAFETY.md §8: "Guardrails are code. … The emergency lexicon is
 * deterministic." CONVERSATION_ENGINE.md §2: the lexicon is matched **before**
 * the model, and "regex hit → emergency regardless of model". This module is
 * therefore the one part of the pipeline that cannot be talked out of an
 * escalation by a prompt injection, a model outage or a bad sample.
 *
 * ## Two severities, not one
 *
 * CONVERSATION_ENGINE.md §2 lists "suicidal" among the emergency lexicon
 * terms, while SAFETY.md §4 requires self-harm *ideation* to get the distress
 * script (warmth + Kenya Red Cross 1199 / Befrienders), not "go to the nearest
 * emergency department". Sending an emergency-room script to someone
 * expressing hopelessness is the wrong clinical response, so terms carry a
 * `severity`:
 *
 *   - `emergency` — physical emergency, or self-harm that has been **acted on**
 *     (overdose taken, cutting done). Emergency script + escalate(emergency).
 *   - `distress`  — self-harm or suicidal **ideation**. Distress script +
 *     escalate(distress).
 *
 * Both short-circuit before the model and both stop the agent, so the property
 * that matters — "an at-risk message never reaches the booking agent" — holds
 * either way. This is a deliberate reading of the two docs, recorded here so a
 * reviewer can overrule it in one place.
 *
 * ## Adding a term
 *
 * SAFETY.md §3: "Emergency lexicon must be maintained in
 * `engine/src/safety/lexicon.{en,sw}.ts`; **adding a term requires an eval
 * case**." Add the phrase(s) to the relevant list, then add at least one case
 * to `evals/datasets/emergency.jsonl` that the new term is needed for, and one
 * near-miss case if the term risks over-firing. `lexicon.test.ts` measures
 * recall and precision over that corpus and fails the build if either slips.
 *
 * ## Matching strategy
 *
 * Patient text arrives as typed WhatsApp messages, Sheng, and voice-note
 * transcripts: lowercase, unpunctuated, misspelled, with stretched vowels.
 * `normalise` + `loosePattern` are built for that, not for clean prose:
 *
 *   - apostrophes are deleted, so "can't" and "cant" are one string;
 *   - all other punctuation and emoji become spaces;
 *   - accents are stripped;
 *   - every letter run collapses to `x+`, so "bleding", "bleeding" and
 *     "bleeeeding" all match one pattern;
 *   - words are joined with `\s*`, so "chest pain", "chest  pain" and
 *     "chestpain" all match.
 *
 * Precision is the thing we trade away: CONVERSATION_ENGINE.md §2 accepts
 * ≥ 60% precision because over-escalation costs a staff glance and
 * under-escalation costs a life.
 */

export type LexiconSeverity = "emergency" | "distress";

export interface LexiconTerm {
  /** Stable id used in logs, audit rows and eval tags. Never patient text. */
  readonly id: string;
  readonly severity: LexiconSeverity;
  readonly pattern: RegExp;
  /** The phrases the pattern was built from — for review, not for matching. */
  readonly phrases: readonly string[];
}

const APOSTROPHES = /['‘’ʼ`´]/g;
const COMBINING_MARKS = /[̀-ͯ]/g;
const NON_ALNUM = /[^a-z0-9]+/g;

/**
 * Fold patient text into the shape the patterns are written against.
 *
 * Apostrophes are removed rather than replaced with a space on purpose: the
 * contraction is the common spelling ("cant breathe") and we want one pattern
 * to cover both forms.
 */
export function normalise(input: string): string {
  return input
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(APOSTROPHES, "")
    .replace(NON_ALNUM, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/**
 * Build a typo-tolerant regex source for a single word.
 *
 * Consecutive duplicate letters collapse first ("bleeding" → "bleding"), then
 * every letter is quantified with `+`. The result matches the correct
 * spelling, the doubled-letter typo, the missing-double typo and any amount of
 * vowel stretching — the four things WhatsApp and voice transcripts actually
 * produce — without matching unrelated words.
 */
function looseWord(word: string): string {
  const deduped = word.replace(/(.)\1+/g, "$1");
  return [...deduped].map((ch) => `${ch.replace(REGEX_META, "\\$&")}+`).join("");
}

/** Build a typo- and spacing-tolerant regex source for a whole phrase. */
export function loosePattern(phrase: string): string {
  return normalise(phrase).split(" ").map(looseWord).join("\\s*");
}

/**
 * Compile one term from its phrases.
 *
 * The lookbehind pins each alternative to a word start so "no air" cannot
 * match inside another word, while the end is deliberately unanchored so
 * plurals and inflections ("pains", "bleeds", "anazimia") match the singular.
 */
export function term(
  id: string,
  severity: LexiconSeverity,
  phrases: readonly string[],
): LexiconTerm {
  const alternatives = phrases.map(loosePattern).join("|");
  return {
    id,
    severity,
    phrases,
    pattern: new RegExp(`(?<![a-z0-9])(?:${alternatives})`),
  };
}

export interface LexiconMatch {
  /** The highest severity matched, or `null` when nothing matched. */
  readonly severity: LexiconSeverity | null;
  /** Ids of every term that matched, in catalogue order. PHI-free. */
  readonly terms: readonly string[];
}

const NO_MATCH: LexiconMatch = { severity: null, terms: [] };

/**
 * Match already-normalised text against a term list.
 *
 * `emergency` outranks `distress`: a message that says both "I want to die"
 * and "I took the whole bottle" is an emergency.
 */
export function matchTerms(normalised: string, terms: readonly LexiconTerm[]): LexiconMatch {
  const hits: string[] = [];
  let severity: LexiconSeverity | null = null;

  for (const t of terms) {
    if (!t.pattern.test(normalised)) continue;
    hits.push(t.id);
    if (t.severity === "emergency") severity = "emergency";
    else if (severity === null) severity = "distress";
  }

  return hits.length === 0 ? NO_MATCH : { severity, terms: hits };
}

/**
 * Symptom vocabulary used only by the classifier's timeout fallback.
 *
 * CONVERSATION_ENGINE.md §2: on timeout we treat the message as `normal` with
 * low confidence, "but if the message contains any symptom words, route
 * `out_of_scope` instead" — i.e. when we could not classify, anything that
 * smells clinical gets the "I can't advise on symptoms" refusal rather than an
 * agent turn. Deliberately broad and low-precision: the cost of a false hit is
 * one extra refusal, the cost of a miss is the agent improvising near a
 * symptom.
 */
const SYMPTOM_WORDS = [
  // English
  "pain",
  "painful",
  "paining",
  "hurt",
  "hurts",
  "ache",
  "aching",
  "sick",
  "ill",
  "illness",
  "fever",
  "temperature",
  "cough",
  "coughing",
  "blood",
  "bleeding",
  "rash",
  "swollen",
  "swelling",
  "dizzy",
  "dizziness",
  "nausea",
  "nauseous",
  "vomit",
  "vomiting",
  "diarrhoea",
  "diarrhea",
  "breathe",
  "breathing",
  "breath",
  "chest",
  "stomach",
  "headache",
  "migraine",
  "infection",
  "infected",
  "wound",
  "injury",
  "injured",
  "burn",
  "burning",
  "lump",
  "discharge",
  "cramps",
  "symptom",
  "symptoms",
  "diagnosis",
  "diagnose",
  "medication",
  "medicine",
  "dosage",
  "dose",
  "tablets",
  "pills",
  "antibiotics",
  "pregnant",
  "pregnancy",
  "period",
  "bp",
  "sugar",
  "diabetes",
  "pressure",
  // Swahili / Sheng
  "maumivu",
  "inauma",
  "kinauma",
  "naumwa",
  "anaumwa",
  "mgonjwa",
  "homa",
  "kikohozi",
  "kukohoa",
  "damu",
  "kizunguzungu",
  "kutapika",
  "anatapika",
  "harisha",
  "kuhara",
  "pumzi",
  "kupumua",
  "kifua",
  "tumbo",
  "kichwa",
  "vidonda",
  "kidonda",
  "uvimbe",
  "dawa",
  "vidonge",
  "mimba",
  "ujauzito",
  "sukari",
  "presha",
  "dalili",
] as const;

const SYMPTOM_PATTERN = new RegExp(`(?<![a-z0-9])(?:${SYMPTOM_WORDS.map(loosePattern).join("|")})`);

/** True when the raw message mentions anything clinical. See SYMPTOM_WORDS. */
export function containsSymptomWord(input: string): boolean {
  return SYMPTOM_PATTERN.test(normalise(input));
}
