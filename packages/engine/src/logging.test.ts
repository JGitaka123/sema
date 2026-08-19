import { describe, expect, it } from "vitest";

import { classifierLogFields, routeLogFields } from "./logging.js";
import type { ClinicScriptConfig } from "./replies.js";
import { route } from "./router.js";
import { matchSafetyLexicon } from "./safety/index.js";
import type { ClassifierResult } from "./types.js";

/**
 * Hard rule 4: no PHI in logs, analytics or error tracking.
 *
 * `docs/TESTING.md` §Definition of done requires a "grep test on log output".
 * This is that test for the engine: a realistic message stuffed with a name, a
 * phone number, an address and a symptom goes in, and every log projection is
 * searched for each of them.
 */

const PHI = {
  name: "Grace Wanjiku Mwangi",
  phone: "+254712345678",
  localPhone: "0712345678",
  address: "Flat 4B Kileleshwa",
  symptom: "chest pain",
  body: "Hi, this is Grace Wanjiku Mwangi from Flat 4B Kileleshwa, +254712345678. I have chest pain.",
};

const CLINIC: ClinicScriptConfig = {
  name: "Afyanex",
  defaultLanguage: "en",
  providerLabel: "Dr Wanjiru",
};

function assertNoPhi(serialised: string): void {
  for (const [label, value] of Object.entries(PHI)) {
    if (label === "body") continue;
    expect(serialised.toLowerCase(), `leaked ${label}`).not.toContain(value.toLowerCase());
  }
  expect(serialised).not.toContain(PHI.body);
}

const classification: ClassifierResult = {
  output: {
    category: "emergency",
    language: "en",
    intent: "other",
    urgency: "high",
    confidence: 1,
  },
  source: "lexicon",
  lexiconTerms: matchSafetyLexicon(PHI.body).terms,
  latencyMs: 4,
  promptVersion: "classifier.v1",
  model: null,
};

describe("classifierLogFields", () => {
  it("carries the decision but none of the message", () => {
    const fields = classifierLogFields(classification);

    expect(fields["category"]).toBe("emergency");
    expect(fields["source"]).toBe("lexicon");
    expect(fields["lexicon_terms"]).toContain("chest_pain");
    assertNoPhi(JSON.stringify(fields));
  });

  it("emits only primitives, so a log formatter cannot walk into an object", () => {
    for (const value of Object.values(classifierLogFields(classification))) {
      expect(["string", "number", "boolean"]).toContain(value === null ? "string" : typeof value);
    }
  });
});

describe("routeLogFields", () => {
  it("logs reply keys and counts, never reply bodies", () => {
    const decision = route({
      classification,
      clinic: CLINIC,
      conversation: {
        mode: "agent",
        abusiveStrikes: 0,
        outOfScopeStreak: 0,
        isFirstContact: true,
      },
      now: new Date("2026-03-02T09:00:00Z"),
    });

    const fields = routeLogFields(decision);
    expect(fields["route"]).toBe("emergency");
    expect(fields["reply_count"]).toBe(2);
    expect(fields["reply_keys"]).toBe("safety.emergency,consent.ai_disclosure");
    expect(fields["escalation_kind"]).toBe("emergency");

    const serialised = JSON.stringify(fields);
    assertNoPhi(serialised);
    // Reply bodies name the clinic and quote emergency numbers — inbox
    // content, not log content.
    expect(serialised).not.toContain("999");
    expect(serialised).not.toContain("Afyanex");
  });
});

describe("audit metadata", () => {
  it("is PHI-free for every route", () => {
    for (const category of [
      "emergency",
      "distress",
      "abusive",
      "spam",
      "out_of_scope",
      "normal",
    ] as const) {
      const decision = route({
        classification: { ...classification, output: { ...classification.output, category } },
        clinic: CLINIC,
        conversation: {
          mode: "agent",
          abusiveStrikes: 2,
          outOfScopeStreak: 1,
          isFirstContact: true,
        },
        now: new Date("2026-03-02T09:00:00Z"),
      });
      assertNoPhi(JSON.stringify(decision.audit));
    }
  });
});
