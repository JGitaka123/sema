import { describe, expect, it } from "vitest";

import { loadEmergencyCases, type EvalCase } from "../../evals/dataset.js";
import { containsSymptomWord, matchSafetyLexicon, normalise } from "./index.js";
import { ALL_TERMS } from "./index.js";

/**
 * The deterministic half of the safety net, measured **without an API key**.
 *
 * `pnpm test:evals` needs credentials and therefore cannot run in CI today.
 * This test runs the same corpus through the regex lexicon alone on every
 * `pnpm test`, so a change that quietly breaks emergency detection fails the
 * build now rather than at go-live.
 *
 * It is not a substitute for the model-backed eval: the lexicon is layer one
 * of two, and the cases it misses are exactly the paraphrases layer two exists
 * for ("everything went black and I woke up on the floor"). The thresholds
 * below reflect that division of labour and are justified where they are set.
 */

const cases = loadEmergencyCases();
const emergencyCases = cases.filter((c) => c.expect === "emergency");
const distressCases = cases.filter((c) => c.expect === "distress");
const benignCases = cases.filter((c) => c.expect === "normal" || c.expect === "out_of_scope");

/**
 * Emergency recall the *lexicon alone* must hold.
 *
 * Not 1.0, and deliberately so. Cases tagged `paraphrase` describe an
 * emergency without using any emergency word — "he has not opened his eyes
 * since the fall this morning" — and the only regex that catches those is one
 * broad enough to fire on half the booking requests too. Buying the last few
 * points of lexicon recall with precision would flood the inbox and train
 * staff to dismiss the alert, which costs more safety than it buys. Those
 * cases are the model layer's job, and `pnpm test:evals` gates them at 1.0.
 *
 * The number is set just under the measured value: it is a regression alarm,
 * not a target to code toward.
 */
const LEXICON_EMERGENCY_RECALL_FLOOR = 0.88;

/** Same reasoning; ideation is more formulaic than trauma, so the floor is higher. */
const LEXICON_DISTRESS_RECALL_FLOOR = 0.85;

/**
 * CONVERSATION_ENGINE.md §2: "precision >= 60% is acceptable (over-escalation
 * is fine)". Measured over the benign half of the corpus, which is stuffed
 * with deliberate near-misses ("do you do chest x rays", "kupima damu",
 * "what is your ambulance number").
 */
const LEXICON_PRECISION_FLOOR = 0.6;

function recall(
  subset: readonly EvalCase[],
  accept: (severity: string | null) => boolean,
): {
  hits: EvalCase[];
  misses: EvalCase[];
  rate: number;
} {
  const hits: EvalCase[] = [];
  const misses: EvalCase[] = [];
  for (const c of subset) {
    if (accept(matchSafetyLexicon(c.text).severity)) hits.push(c);
    else misses.push(c);
  }
  return { hits, misses, rate: subset.length === 0 ? 1 : hits.length / subset.length };
}

describe("safety lexicon corpus", () => {
  it("has a corpus large enough to mean something", () => {
    // CONVERSATION_ENGINE.md §9: ">= 200 cases EN/SW/Sheng".
    expect(cases.length).toBeGreaterThanOrEqual(200);
    expect(emergencyCases.length).toBeGreaterThanOrEqual(100);
    expect(distressCases.length).toBeGreaterThanOrEqual(20);
    expect(benignCases.length).toBeGreaterThanOrEqual(50);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it("covers all three languages", () => {
    const langs = new Set(cases.map((c) => c.lang));
    expect(langs).toEqual(new Set(["en", "sw", "sheng"]));
  });

  it("recalls emergencies above the regression floor", () => {
    const { rate, misses } = recall(emergencyCases, (s) => s === "emergency");
    // Reported so a reviewer can see the real number, not just pass/fail.
    console.log(
      `lexicon emergency recall: ${(rate * 100).toFixed(1)}% ` +
        `(${emergencyCases.length - misses.length}/${emergencyCases.length}); ` +
        `missed: ${misses.map((m) => m.id).join(", ") || "none"}`,
    );
    expect(rate).toBeGreaterThanOrEqual(LEXICON_EMERGENCY_RECALL_FLOOR);
  });

  it("never downgrades an emergency case to distress", () => {
    // An emergency answered as distress would send "call Befrienders" to
    // someone who is bleeding out. The severity ordering in matchTerms exists
    // to prevent exactly this.
    for (const c of emergencyCases) {
      const match = matchSafetyLexicon(c.text);
      if (match.severity !== null) {
        expect(match.severity, `${c.id} downgraded`).toBe("emergency");
      }
    }
  });

  it("recalls distress above the regression floor", () => {
    const { rate, misses } = recall(distressCases, (s) => s === "distress" || s === "emergency");
    console.log(
      `lexicon distress recall: ${(rate * 100).toFixed(1)}% ` +
        `(${distressCases.length - misses.length}/${distressCases.length}); ` +
        `missed: ${misses.map((m) => m.id).join(", ") || "none"}`,
    );
    expect(rate).toBeGreaterThanOrEqual(LEXICON_DISTRESS_RECALL_FLOOR);
  });

  it("keeps precision above the documented floor on near-miss traffic", () => {
    const firedOnBenign = benignCases.filter((c) => matchSafetyLexicon(c.text).severity !== null);
    const safetyCases = [...emergencyCases, ...distressCases];
    const firedOnSafety = safetyCases.filter((c) => matchSafetyLexicon(c.text).severity !== null);
    const precision =
      firedOnSafety.length / Math.max(1, firedOnSafety.length + firedOnBenign.length);

    console.log(
      `lexicon precision: ${(precision * 100).toFixed(1)}%; ` +
        `false positives: ${firedOnBenign.map((c) => c.id).join(", ") || "none"}`,
    );
    expect(precision).toBeGreaterThanOrEqual(LEXICON_PRECISION_FLOOR);
  });

  it("reports the terms that fired, never the patient text", () => {
    const match = matchSafetyLexicon("my chest is paining me and I cant breathe");
    expect(match.severity).toBe("emergency");
    expect(match.terms).toContain("chest_pain");
    for (const id of match.terms) {
      expect(id).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe("normalisation", () => {
  it("folds apostrophes away so contractions match one pattern", () => {
    expect(normalise("I can't breathe")).toBe("i cant breathe");
    expect(matchSafetyLexicon("I can't breathe").severity).toBe("emergency");
    expect(matchSafetyLexicon("I cant breathe").severity).toBe("emergency");
    expect(matchSafetyLexicon("I CANNOT BREATHE!!!").severity).toBe("emergency");
  });

  it("tolerates stretched and doubled letters", () => {
    expect(matchSafetyLexicon("bleeeeeding a lot").severity).toBe("emergency");
    expect(matchSafetyLexicon("bleding a lot").severity).toBe("emergency");
  });

  it("tolerates missing spaces and stray punctuation", () => {
    expect(matchSafetyLexicon("chestpain!!!").severity).toBe("emergency");
    expect(matchSafetyLexicon("chest — pain").severity).toBe("emergency");
  });

  it("handles emoji and mixed scripts without throwing", () => {
    expect(() => matchSafetyLexicon("🚑🚑 amezimia 🚑")).not.toThrow();
    expect(matchSafetyLexicon("🚑 amezimia").severity).toBe("emergency");
  });

  it("does not match a term inside an unrelated word", () => {
    // "no air" must not fire inside "Nairobi".
    expect(matchSafetyLexicon("Are you in Nairobi?").severity).toBeNull();
  });

  it("treats an empty message as no match", () => {
    expect(matchSafetyLexicon("").severity).toBeNull();
    expect(matchSafetyLexicon("   ").severity).toBeNull();
  });
});

describe("term catalogue hygiene", () => {
  it("has unique ids", () => {
    const ids = ALL_TERMS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses only snake_case ids, so they are safe to log and tag", () => {
    for (const t of ALL_TERMS) {
      expect(t.id).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("has at least one phrase per term", () => {
    for (const t of ALL_TERMS) {
      expect(t.phrases.length, t.id).toBeGreaterThan(0);
    }
  });
});

describe("containsSymptomWord", () => {
  it("fires on clinical vocabulary in both languages", () => {
    expect(containsSymptomWord("my back hurts a bit")).toBe(true);
    expect(containsSymptomWord("naumwa kichwa kidogo")).toBe(true);
    expect(containsSymptomWord("mtoto ana homa")).toBe(true);
  });

  it("does not fire on ordinary front-desk traffic", () => {
    expect(containsSymptomWord("can I book for tomorrow at 3")).toBe(false);
    expect(containsSymptomWord("mko wapi hasa")).toBe(false);
    expect(containsSymptomWord("do you accept NHIF")).toBe(false);
  });
});
