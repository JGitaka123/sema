import { describe, expect, it } from "vitest";

import {
  CONSERVATIVE_ADDENDUM,
  firstNameOf,
  renderAgentPrompt,
  renderClinicFacts,
  renderHistory,
  renderPatientCard,
  summariseHours,
} from "./context.js";
import { renderToolGuidance } from "./tools/index.js";
import { testContext } from "./testing.js";

/**
 * Context rendering.
 *
 * Two things are being defended here. The first is COMPLIANCE.md §2 — what
 * leaves the tenant boundary — and it is tested by feeding the builder a
 * patient stuffed with identifying data and asserting none of it survives. The
 * second is the grounding contract: whatever the guardrail checks against is
 * the same text the model was given, so a fact must appear in the block in the
 * form the agent would write it.
 */

function guidance(): string {
  return renderToolGuidance();
}

describe("firstNameOf", () => {
  it("prefers the name staff recorded as preferred", () => {
    expect(firstNameOf("Achie", "Achieng Odhiambo")).toBe("Achie");
  });

  it("falls back to the first token of the full name — never the surname", () => {
    expect(firstNameOf(null, "Achieng Odhiambo")).toBe("Achieng");
    expect(firstNameOf("", "Grace Njeri Kamau")).toBe("Grace");
  });

  it("returns null when there is nothing to use", () => {
    expect(firstNameOf(null, null)).toBeNull();
    expect(firstNameOf("  ", "  ")).toBeNull();
  });
});

describe("summariseHours", () => {
  it("collapses a run of identical weekdays", () => {
    expect(
      summariseHours([
        { weekday: 1, startLocal: "08:00:00", endLocal: "17:00:00" },
        { weekday: 2, startLocal: "08:00:00", endLocal: "17:00:00" },
        { weekday: 3, startLocal: "08:00:00", endLocal: "17:00:00" },
        { weekday: 4, startLocal: "08:00:00", endLocal: "17:00:00" },
        { weekday: 5, startLocal: "08:00:00", endLocal: "17:00:00" },
        { weekday: 6, startLocal: "09:00:00", endLocal: "13:00:00" },
      ]),
    ).toBe("Mon–Fri 8:00am–5:00pm; Sat 9:00am–1:00pm");
  });

  it("does not merge non-adjacent days", () => {
    expect(
      summariseHours([
        { weekday: 1, startLocal: "09:00:00", endLocal: "16:00:00" },
        { weekday: 3, startLocal: "09:00:00", endLocal: "16:00:00" },
      ]),
    ).toBe("Mon 9:00am–4:00pm; Wed 9:00am–4:00pm");
  });

  it("says so when a provider has no hours", () => {
    expect(summariseHours([])).toBe("no hours set");
  });
});

describe("renderClinicFacts", () => {
  const facts = renderClinicFacts(testContext());

  it("carries every service with its id, price and deposit", () => {
    expect(facts).toContain("svc_00000000000000000000000001 — GP consultation");
    expect(facts).toContain("KES 2,000");
    expect(facts).toContain("deposit KES 1,500 required to confirm");
    expect(facts).toContain("no deposit");
  });

  it("carries providers and which services they actually offer", () => {
    expect(facts).toContain("Dr. Wanjiru Kamau, MBChB — General practice");
    expect(facts).toContain("offers services: svc_00000000000000000000000001");
  });

  it("carries the policy the tools will enforce", () => {
    expect(facts).toContain("up to 24 hours before");
    expect(facts).toContain("Inside 2 hours the deposit is not refunded");
    expect(facts).toContain("The tools enforce this");
  });

  it("carries the clinic's own knowledge verbatim", () => {
    expect(facts).toContain(
      "Monday to Friday 8:00am–5:00pm. Saturday 9:00am–1:00pm. Closed on Sundays.",
    );
  });

  it("says plainly when a section is empty rather than leaving a gap", () => {
    const empty = renderClinicFacts(testContext({ knowledge: [], providers: [], locations: [] }));
    expect(empty).toContain("(none written yet)");
    expect(empty).toContain("(none configured)");
  });
});

describe("renderPatientCard", () => {
  it("uses a first name and says not to use a surname", () => {
    const card = renderPatientCard(testContext());
    expect(card).toContain("First name: Achieng");
    expect(card).toContain("never a surname");
  });

  it("never contains a phone number, a surname or a clinical note", () => {
    const context = testContext({
      patient: { ...testContext().patient, firstName: "Achieng", noShowCount: 2 },
    });
    const card = renderPatientCard(context);
    expect(card).not.toMatch(/\+?254\d{9}/);
    expect(card).not.toContain("Odhiambo");
    expect(card).not.toContain("dob");
  });

  it("tells the agent not to lecture a patient about missed appointments", () => {
    const context = testContext({ patient: { ...testContext().patient, noShowCount: 3 } });
    expect(renderPatientCard(context)).toContain("Do not mention this to the patient");
  });

  it("lists open holds with when they expire", () => {
    const context = testContext({
      openHolds: [
        {
          id: "hld_00000000000000000000000001",
          providerId: "prv_00000000000000000000000001",
          serviceId: "svc_00000000000000000000000001",
          start: new Date("2026-08-21T06:00:00Z"),
          end: new Date("2026-08-21T06:20:00Z"),
          expiresAt: new Date("2026-08-20T07:10:00Z"),
        },
      ],
    });
    const card = renderPatientCard(context);
    expect(card).toContain("hld_00000000000000000000000001");
    expect(card).toContain("expires 10:10 AM");
  });
});

describe("renderAgentPrompt", () => {
  it("fills every placeholder — a leaked {{TOKEN}} would ship to the model", () => {
    const prompt = renderAgentPrompt({ context: testContext(), toolGuidance: guidance() });
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("has all eight documented sections", () => {
    const prompt = renderAgentPrompt({ context: testContext(), toolGuidance: guidance() });
    for (const heading of [
      "# 1. Identity",
      "# 2. Hard limits",
      "# 3. Clinic facts",
      "# 4. Patient",
      "# 5. How to talk",
      "# 6. Tools",
      "# 7. Now",
      "# 8. Output",
    ]) {
      expect(prompt).toContain(heading);
    }
  });

  it("states the grounding rule the guardrail enforces", () => {
    const prompt = renderAgentPrompt({ context: testContext(), toolGuidance: guidance() });
    expect(prompt).toContain("If a fact is not in this block, you do not know it");
    expect(prompt).toContain("escalate` with kind `low_confidence");
  });

  it("mirrors SAFETY.md §1 as ten numbered limits", () => {
    const prompt = renderAgentPrompt({ context: testContext(), toolGuidance: guidance() });
    const section = prompt.slice(prompt.indexOf("# 2."), prompt.indexOf("# 3."));
    expect(section).toMatch(/^10\. /m);
    expect(section).toContain("Never diagnose");
    expect(section).toContain("Never interpret an image");
    expect(section).toContain("Never triage severity");
  });

  it("gives the current time in clinic time and names the weekday", () => {
    const prompt = renderAgentPrompt({ context: testContext(), toolGuidance: guidance() });
    expect(prompt).toContain("Thu 20 Aug 2026, 10:00 AM");
    expect(prompt).toContain("Today is Thursday");
  });

  it("appends the conservative addendum only when asked", () => {
    const plain = renderAgentPrompt({ context: testContext(), toolGuidance: guidance() });
    const careful = renderAgentPrompt({
      context: testContext(),
      toolGuidance: guidance(),
      addendum: "conservative",
    });
    expect(plain).not.toContain(CONSERVATIVE_ADDENDUM);
    expect(careful).toContain(CONSERVATIVE_ADDENDUM);
  });
});

describe("renderHistory", () => {
  const history = [
    { role: "patient" as const, sentBy: null, text: "Nataka kuona daktari", at: new Date() },
    { role: "clinic" as const, sentBy: "agent", text: "Sawa, siku gani?", at: new Date() },
    { role: "clinic" as const, sentBy: "staff:usr_1", text: "Hi, Kelvin here.", at: new Date() },
  ];

  it("labels who said what, distinguishing staff from the agent", () => {
    const rendered = renderHistory(testContext({ history }));
    expect(rendered).toContain("patient: Nataka kuona daktari");
    expect(rendered).toContain("you: Sawa, siku gani?");
    expect(rendered).toContain("clinic staff: Hi, Kelvin here.");
  });

  it("uses the summary in place of older history once truncated (§8)", () => {
    const rendered = renderHistory(
      testContext({ history, historyTruncated: true, summary: "Achieng wants a GP slot." }),
    );
    expect(rendered).toContain("Summary of the conversation so far: Achieng wants a GP slot.");
  });

  it("does not show a summary while the whole thread still fits", () => {
    const rendered = renderHistory(
      testContext({ history, historyTruncated: false, summary: "stale summary" }),
    );
    expect(rendered).not.toContain("stale summary");
  });
});
