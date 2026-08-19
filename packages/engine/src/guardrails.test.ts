import { describe, expect, it } from "vitest";

import type { ModelClient } from "./client.js";
import {
  MAX_REPLY_CHARS,
  capLength,
  checkGrounding,
  checkLanguage,
  checkPii,
  checkReply,
  detectAdvicePatterns,
  extractClaims,
  isSlotListing,
  rewriteInstruction,
  stripMarkdown,
} from "./guardrails.js";

/**
 * Guardrail tests (CONVERSATION_ENGINE.md §4, SAFETY.md §8).
 *
 * Every case here runs without an API key. That is the point: SAFETY.md §8
 * says guardrails are code, and code that only proves itself against a live
 * model is not a guarantee, it is a hope.
 */

const CORPUS = [
  "SERVICES:",
  "  svc_1 — GP consultation — 20 min — KES 2,000 — no deposit",
  "  svc_2 — Dental scaling and polishing — 45 min — KES 4,500 — deposit KES 1,500 required to confirm",
  "PROVIDERS:",
  "  prv_1 — Dr. Wanjiru Kamau, MBChB — General practice",
  "WORKING HOURS (clinic time):",
  "  Dr. Wanjiru Kamau: Mon–Fri 8:00am–5:00pm; Sat 9:00am–1:00pm",
  "LOCATIONS:",
  "  Afyanex Clinic — Kilimani",
  "      address: 2nd Floor, Wood Avenue Plaza, Kilimani, Nairobi",
  "      phone: +254709000100",
].join("\n");

const BASE = {
  groundingCorpus: CORPUS,
  patientLanguage: "en" as const,
  allowedPhones: ["+254709000100"],
  patientFirstName: "Achieng",
};

function adviceClient(verdict: boolean): ModelClient {
  return {
    async structured() {
      return {
        text: JSON.stringify({ gives_medical_advice: verdict }),
        stopReason: "end_turn",
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
}

// ── 1. Clinical advice ───────────────────────────────────────────────────────

describe("clinical advice detector (deterministic)", () => {
  const advice: readonly [string, string][] = [
    ["diagnosis", "From what you describe, you probably have an infection."],
    ["dosage", "Take two tablets of paracetamol every six hours until you can come in."],
    ["dosage numeric", "Start on 500mg twice a day and see how you feel."],
    ["reassurance", "That is perfectly normal after a filling, nothing to worry about."],
    ["wait", "It can wait until next month, no need to see a doctor urgently."],
    ["self care", "Rinse with warm salt water three times a day."],
    ["severity", "That sounds serious, you should be seen today."],
    ["interpretation", "Your results show a mild anaemia."],
    ["sounds like", "That sounds like a sinus problem to me."],
    ["likelihood", "It is probably just stress."],
    ["medication advice", "You should stop taking the antibiotics before your visit."],
    ["impersonation", "As a doctor I would say this is fine."],
    ["outcome promise", "The dentist will definitely be able to remove it in one visit."],
  ];

  for (const [label, text] of advice) {
    it(`flags ${label}`, () => {
      expect(detectAdvicePatterns(text).length).toBeGreaterThan(0);
    });
  }

  const allowed: readonly [string, string][] = [
    ["a refusal", "I can't advise on symptoms, but I can book you in with a doctor today."],
    ["a booking", "You have an appointment on Thursday at 9:00am with Dr. Wanjiru Kamau."],
    ["a price", "A GP consultation is KES 2,000."],
    [
      "clinic prep instructions",
      "For a fasting test, do not eat for 8 hours before. Water is fine.",
    ],
    ["a reschedule offer", "That's fine to reschedule — free of charge up to 24 hours before."],
    ["hours", "We're open Mon–Fri 8:00am–5:00pm."],
  ];

  for (const [label, text] of allowed) {
    it(`allows ${label}`, () => {
      expect(detectAdvicePatterns(text)).toEqual([]);
    });
  }
});

describe("clinical advice detector (fast model)", () => {
  it("fails the reply when the model says it is advice, even with no regex hit", async () => {
    const result = await checkReply(
      { ...BASE, reply: "That feeling in the evening is quite typical after a cleaning." },
      { client: adviceClient(true) },
    );
    expect(result.failed).toBe(true);
    expect(result.violations.map((v) => v.check)).toContain("clinical_advice");
  });

  it("does not call the model when the regex already caught it", async () => {
    let calls = 0;
    const client: ModelClient = {
      async structured() {
        calls += 1;
        return { text: "{}", stopReason: "end_turn", inputTokens: 1, outputTokens: 1 };
      },
    };
    const result = await checkReply(
      { ...BASE, reply: "You probably have an infection." },
      { client },
    );
    expect(result.failed).toBe(true);
    expect(calls).toBe(0);
  });

  it("lets a clean reply through when the model call fails", async () => {
    const client: ModelClient = {
      async structured() {
        throw new Error("network down");
      },
    };
    // A thrown non-ModelCallError propagates; a malformed answer must not
    // block. Malformed is the realistic failure and the one we must survive.
    const lenient: ModelClient = {
      async structured() {
        return { text: "not json", stopReason: "end_turn", inputTokens: 1, outputTokens: 1 };
      },
    };
    const result = await checkReply(
      { ...BASE, reply: "You're booked for Thursday at 9:00am." },
      { client: lenient },
    );
    expect(result.failed).toBe(false);
    expect(client).toBeDefined();
  });
});

// ── 2. Grounding ─────────────────────────────────────────────────────────────

describe("fact grounding", () => {
  it("passes a price that is in the corpus", () => {
    expect(checkGrounding("A GP consultation is KES 2,000.", CORPUS)).toEqual([]);
  });

  it("fails a price that is not", () => {
    const violations = checkGrounding("A GP consultation is KES 3,500.", CORPUS);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.check).toBe("grounding");
    expect(violations[0]?.severity).toBe("fail");
  });

  it("fails an invented deposit", () => {
    expect(checkGrounding("The deposit is KES 2,500.", CORPUS)).toHaveLength(1);
  });

  it("passes a time inside the clinic's hours, written differently", () => {
    expect(checkGrounding("We open at 8am.", CORPUS)).toEqual([]);
    expect(checkGrounding("We close at 5:00pm.", CORPUS)).toEqual([]);
  });

  it("fails an invented opening hour", () => {
    expect(checkGrounding("We're open until 9:00pm on Fridays.", CORPUS)).toHaveLength(1);
  });

  it("passes a clinician who exists", () => {
    expect(checkGrounding("Dr. Wanjiru Kamau can see you.", CORPUS)).toEqual([]);
  });

  it("fails an invented clinician", () => {
    const violations = checkGrounding("Dr. Kimani has a slot.", CORPUS);
    expect(violations.some((v) => v.detail.includes("clinician"))).toBe(true);
  });

  it("fails an invented address", () => {
    expect(checkGrounding("We're on Ngong Road, third floor.", CORPUS)).toHaveLength(1);
  });

  it("passes the real address", () => {
    expect(
      checkGrounding("We're at 2nd Floor, Wood Avenue Plaza, Kilimani.", CORPUS),
    ).toEqual([]);
  });

  it("extracts each kind of claim", () => {
    const claims = extractClaims(
      "Dr. Wanjiru Kamau at 9:30am, KES 2,000, at Wood Avenue Plaza.",
    );
    expect(claims.map((c) => c.kind).sort()).toEqual(["address", "amount", "clinician", "time"]);
  });

  it("grounds a slot the tools returned this turn but the knowledge does not mention", () => {
    const corpus = `${CORPUS}\nThu 21 Aug, 11:15 AM`;
    expect(checkGrounding("I can offer Thursday at 11:15am.", corpus)).toEqual([]);
    expect(checkGrounding("I can offer Thursday at 11:45am.", corpus)).toHaveLength(1);
  });
});

// ── 3. PII ───────────────────────────────────────────────────────────────────

describe("PII leak check", () => {
  it("allows the clinic's own number", () => {
    expect(checkPii("Call us on +254709000100.", ["+254709000100"], "Achieng", CORPUS)).toEqual([]);
  });

  it("fails another number", () => {
    const violations = checkPii(
      "You can reach her on +254712000009.",
      ["+254709000100"],
      "Achieng",
      CORPUS,
    );
    expect(violations).toHaveLength(1);
    // The leaked number must not be repeated into the violation detail.
    expect(violations[0]?.detail).not.toContain("254712000009");
  });

  it("allows emergency short codes", () => {
    expect(checkPii("Call 999 or 112 right now.", [], "Achieng", CORPUS)).toEqual([]);
  });

  it("fails a clinician nobody has heard of", () => {
    const violations = checkPii("Dr. Mwangi will see you.", [], "Achieng", CORPUS);
    expect(violations.some((v) => v.check === "pii")).toBe(true);
  });
});

// ── 4. Language ──────────────────────────────────────────────────────────────

describe("language check", () => {
  it("warns rather than fails on a mismatch", () => {
    const violations = checkLanguage("Karibu, tutakuona kesho asubuhi saa tatu.", "en");
    for (const violation of violations) expect(violation.severity).toBe("warn");
  });

  it("says nothing when the patient wrote in a mix", () => {
    expect(checkLanguage("Sawa, see you Thursday.", "mixed")).toEqual([]);
  });
});

// ── 5. Format ────────────────────────────────────────────────────────────────

describe("format repair", () => {
  it("strips markdown WhatsApp would render literally", () => {
    expect(stripMarkdown("**Thursday** at _9am_ with `Dr Kamau`")).toBe(
      "Thursday at 9am with Dr Kamau",
    );
    expect(stripMarkdown("## Slots\n- 9am\n- 10am")).toBe("Slots\n- 9am\n- 10am");
    expect(stripMarkdown("See [our map](https://maps.example/x)")).toBe("See our map");
  });

  it("caps a long reply on a sentence boundary", () => {
    const long = `${"We can see you on Thursday. ".repeat(40)}`;
    const capped = capLength(long, MAX_REPLY_CHARS);
    expect(capped.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    expect(capped.endsWith(".")).toBe(true);
  });

  it("gives a slot listing the larger budget", () => {
    expect(isSlotListing("Thursday 9:00am or Friday 2:00pm?")).toBe(true);
    expect(isSlotListing("You're booked for Thursday at 9:00am.")).toBe(false);
  });

  it("trims silently — a long reply is a warning, not a rewrite", async () => {
    const result = await checkReply({
      ...BASE,
      reply: "We can see you soon. ".repeat(60),
    });
    expect(result.failed).toBe(false);
    expect(result.warnings.some((w) => w.check === "format")).toBe(true);
  });
});

// ── The whole post-check ─────────────────────────────────────────────────────

describe("checkReply", () => {
  it("passes a clean administrative reply", async () => {
    const result = await checkReply({
      ...BASE,
      reply: "Thanks Achieng. A GP consultation is KES 2,000 — shall I look for a time?",
    });
    expect(result.failed).toBe(false);
    expect(result.violations).toEqual([]);
  });

  it("strips markdown before grounding, so formatting cannot break a valid price", async () => {
    const result = await checkReply({ ...BASE, reply: "It's **KES 2,000**." });
    expect(result.failed).toBe(false);
    expect(result.text).toBe("It's KES 2,000.");
  });

  it("collects every failure so the rewrite can name them all", async () => {
    const result = await checkReply({
      ...BASE,
      reply: "You probably have an infection. Dr. Kimani charges KES 9,000.",
    });
    const checks = new Set(result.violations.map((v) => v.check));
    expect(checks.has("clinical_advice")).toBe(true);
    expect(checks.has("grounding")).toBe(true);
    expect(result.failed).toBe(true);
  });
});

describe("rewriteInstruction", () => {
  it("names the failures and only the failures", () => {
    const instruction = rewriteInstruction([
      { check: "grounding", detail: "ungrounded amount", severity: "fail" },
      { check: "language", detail: "reads as sw", severity: "warn" },
    ]);
    expect(instruction).toContain("grounding: ungrounded amount");
    expect(instruction).not.toContain("reads as sw");
    expect(instruction).toContain("has not reached the patient");
  });
});
