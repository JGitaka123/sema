import { describe, expect, it } from "vitest";

import type { ClinicScriptConfig } from "./replies.js";
import {
  ABUSE_MUTE_MS,
  ABUSE_STRIKE_LIMIT,
  OUT_OF_SCOPE_ESCALATE_AT,
  route,
  type ConversationState,
  type RouterInput,
} from "./router.js";
import type {
  ClassifierCategory,
  ClassifierLanguage,
  ClassifierResult,
  ClassifierSource,
} from "./types.js";

const NOW = new Date("2026-03-02T09:00:00Z");

const CLINIC: ClinicScriptConfig = {
  name: "Afyanex",
  defaultLanguage: "en",
  providerLabel: "Dr Wanjiru",
  clinicPhone: "+254700000000",
  privacyUrl: "afyanex.co.ke/privacy",
  opensAt: "8am",
};

function classification(
  category: ClassifierCategory,
  overrides: Partial<{
    confidence: number;
    language: ClassifierLanguage;
    source: ClassifierSource;
  }> = {},
): ClassifierResult {
  return {
    output: {
      category,
      language: overrides.language ?? "en",
      intent: "other",
      urgency: category === "normal" ? "none" : "high",
      confidence: overrides.confidence ?? 0.9,
    },
    source: overrides.source ?? "model",
    lexiconTerms: [],
    latencyMs: 120,
    promptVersion: "classifier.v1",
    model: "test",
  };
}

function conversation(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    mode: "agent",
    abusiveStrikes: 0,
    outOfScopeStreak: 0,
    isFirstContact: false,
    ...overrides,
  };
}

function input(
  category: ClassifierCategory,
  conv: Partial<ConversationState> = {},
  clinic: ClinicScriptConfig = CLINIC,
): RouterInput {
  return {
    classification: classification(category),
    clinic,
    conversation: conversation(conv),
    now: NOW,
  };
}

describe("router decision table", () => {
  it("emergency: scripted reply, escalate, pin, stop", () => {
    const decision = route(input("emergency"));

    expect(decision.route).toBe("emergency");
    expect(decision.runAgent).toBe(false);
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.key).toBe("safety.emergency");
    expect(decision.replies[0]?.body).toContain("999");
    expect(decision.replies[0]?.body).toContain("Afyanex");
    expect(decision.escalation).toEqual({
      kind: "emergency",
      reason: "safety_emergency",
      pinConversation: true,
      notify: ["inbox", "emergency_contact"],
    });
    expect(decision.conversationUpdates.pinned).toBe(true);
  });

  it("emergency: honours the clinic script override", () => {
    const decision = route(
      input("emergency", {}, { ...CLINIC, emergencyScriptOverride: "Call {clinic} on 0800 now." }),
    );
    expect(decision.replies[0]?.key).toBe("clinic.emergency_script_override");
    expect(decision.replies[0]?.body).toBe("Call Afyanex on 0800 now.");
  });

  it("distress: empathetic reply with the crisis lines, escalate, stop", () => {
    const decision = route(input("distress"));

    expect(decision.route).toBe("distress");
    expect(decision.runAgent).toBe(false);
    expect(decision.replies[0]?.key).toBe("safety.distress");
    expect(decision.replies[0]?.body).toContain("1199");
    expect(decision.replies[0]?.body).toContain("+254 722 178 177");
    expect(decision.escalation?.kind).toBe("distress");
  });

  it("distress: uses the clinic's own counselling line when configured", () => {
    const decision = route(input("distress", {}, { ...CLINIC, befriendersPhone: "+254711999888" }));
    expect(decision.replies[0]?.body).toContain("+254711999888");
    expect(decision.replies[0]?.body).not.toContain("+254 722 178 177");
  });

  it("out_of_scope: redirect only on the first attempt", () => {
    const decision = route(input("out_of_scope"));

    expect(decision.route).toBe("out_of_scope");
    expect(decision.runAgent).toBe(false);
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.key).toBe("safety.out_of_scope");
    expect(decision.replies[0]?.body).toContain("Dr Wanjiru");
    expect(decision.escalation).toBeUndefined();
    expect(decision.conversationUpdates.outOfScopeStreak).toBe(1);
  });

  it("out_of_scope: escalates with a holding message when the patient insists", () => {
    const decision = route(
      input("out_of_scope", { outOfScopeStreak: OUT_OF_SCOPE_ESCALATE_AT - 1 }),
    );

    expect(decision.escalation?.kind).toBe("out_of_scope");
    expect(decision.replies.map((r) => r.key)).toEqual([
      "safety.out_of_scope",
      "handover.in_hours",
    ]);
  });

  it("out_of_scope: uses the out-of-hours holding message when the clinic is closed", () => {
    const decision = route(input("out_of_scope", { outOfScopeStreak: 1, inHours: false }));
    expect(decision.replies[1]?.key).toBe("handover.out_of_hours");
    expect(decision.replies[1]?.body).toContain("8am");
  });

  it.each([1, 2])("abusive: warns on strike %i without escalating", (previousStrikes) => {
    const decision = route(input("abusive", { abusiveStrikes: previousStrikes - 1 }));

    expect(decision.route).toBe("abusive");
    expect(decision.replies[0]?.key).toBe("safety.abuse_warning");
    expect(decision.escalation).toBeUndefined();
    expect(decision.conversationUpdates.abusiveStrikes).toBe(previousStrikes);
    expect(decision.conversationUpdates.mode).toBeUndefined();
  });

  it("abusive: third strike mutes for 24h, escalates and goes silent", () => {
    const decision = route(input("abusive", { abusiveStrikes: ABUSE_STRIKE_LIMIT - 1 }));

    expect(decision.replies).toHaveLength(0);
    expect(decision.escalation?.kind).toBe("abusive");
    expect(decision.conversationUpdates.mode).toBe("muted");
    expect(decision.conversationUpdates.abusiveStrikes).toBe(ABUSE_STRIKE_LIMIT);
    expect(decision.conversationUpdates.mutedUntil?.getTime()).toBe(NOW.getTime() + ABUSE_MUTE_MS);
    expect(ABUSE_MUTE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("spam: silence, no escalation, no strike", () => {
    const decision = route(input("spam"));

    expect(decision.route).toBe("spam");
    expect(decision.replies).toHaveLength(0);
    expect(decision.escalation).toBeUndefined();
    expect(decision.conversationUpdates.abusiveStrikes).toBeUndefined();
  });

  it("normal: hands off to the agent", () => {
    const decision = route(input("normal"));

    expect(decision.route).toBe("agent");
    expect(decision.runAgent).toBe(true);
    expect(decision.replies).toHaveLength(0);
    expect(decision.agentAddendum).toBeUndefined();
    expect(decision.conversationUpdates.outOfScopeStreak).toBe(0);
  });

  it("normal: adds the conservative addendum when confidence is low", () => {
    const decision = route({
      ...input("normal"),
      classification: classification("normal", { confidence: 0.2 }),
    });
    expect(decision.runAgent).toBe(true);
    expect(decision.agentAddendum).toBe("conservative");
    expect(decision.audit.action).toBe("route.agent.low_confidence");
  });

  it("normal: adds the conservative addendum after any classifier fallback", () => {
    const decision = route({
      ...input("normal"),
      classification: classification("normal", { confidence: 0, source: "fallback" }),
    });
    expect(decision.agentAddendum).toBe("conservative");
  });
});

describe("router — takeover and mute", () => {
  it("stays silent while a human has the conversation", () => {
    const decision = route(input("normal", { mode: "human" }));

    expect(decision.route).toBe("silent");
    expect(decision.runAgent).toBe(false);
    expect(decision.replies).toHaveLength(0);
  });

  it("still raises the alarm for an emergency during human takeover", () => {
    const decision = route(input("emergency", { mode: "human" }));

    expect(decision.route).toBe("emergency");
    expect(decision.replies).toHaveLength(0);
    expect(decision.escalation?.kind).toBe("emergency");
    expect(decision.audit.action).toBe("route.emergency.human_mode");
  });

  it("stays silent for ordinary traffic while muted", () => {
    const decision = route(
      input("normal", { mode: "muted", agentMutedUntil: new Date(NOW.getTime() + 60_000) }),
    );
    expect(decision.route).toBe("silent");
    expect(decision.runAgent).toBe(false);
  });

  it("resumes once the mute expires", () => {
    const decision = route(
      input("normal", { mode: "muted", agentMutedUntil: new Date(NOW.getTime() - 60_000) }),
    );
    expect(decision.route).toBe("agent");
  });

  it.each(["emergency", "distress"] as const)(
    "lets a %s through the mute — the mute silences the agent, not the alarm",
    (category) => {
      const decision = route(
        input(category, { mode: "muted", agentMutedUntil: new Date(NOW.getTime() + 60_000) }),
      );
      expect(decision.route).toBe(category);
      expect(decision.replies).toHaveLength(1);
      expect(decision.escalation?.kind).toBe(category);
    },
  );
});

describe("router — first contact AI disclosure", () => {
  it("sends the disclosure before an ordinary agent turn", () => {
    const decision = route(input("normal", { isFirstContact: true }));
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.key).toBe("consent.ai_disclosure");
    expect(decision.replies[0]?.body).toContain("Afyanex");
    expect(decision.replies[0]?.body).toContain("STOP");
    expect(decision.runAgent).toBe(true);
  });

  it("sends the emergency script first and the disclosure after it", () => {
    // Someone describing an emergency must read "call 999" first, not a
    // privacy notice.
    const decision = route(input("emergency", { isFirstContact: true }));
    expect(decision.replies.map((r) => r.key)).toEqual([
      "safety.emergency",
      "consent.ai_disclosure",
    ]);
  });

  it("does not send the disclosure when the agent is staying silent", () => {
    const decision = route(input("spam", { isFirstContact: true }));
    expect(decision.replies).toHaveLength(0);
  });

  it("does not repeat the disclosure after first contact", () => {
    const decision = route(input("normal", { isFirstContact: false }));
    expect(decision.replies).toHaveLength(0);
  });
});

describe("router — language of the scripted reply", () => {
  it("replies in Swahili to a Swahili message", () => {
    const decision = route({
      ...input("emergency"),
      classification: classification("emergency", { language: "sw" }),
    });
    expect(decision.replies[0]?.language).toBe("sw");
    expect(decision.replies[0]?.body).toContain("dharura");
  });

  it("uses the reviewed Swahili script in a casual register for Sheng", () => {
    const decision = route({
      ...input("emergency"),
      classification: classification("emergency", { language: "sheng" }),
    });
    expect(decision.replies[0]?.language).toBe("sw");
    expect(decision.replies[0]?.register).toBe("casual");
  });

  it.each(["mixed", "other"] as const)("falls back to the clinic default for %s", (language) => {
    const decision = route({
      ...input("emergency"),
      classification: classification("emergency", { language }),
      clinic: { ...CLINIC, defaultLanguage: "sw" },
    });
    expect(decision.replies[0]?.language).toBe("sw");
  });
});

describe("router — audit trail", () => {
  it("records a PHI-free audit entry for every route", () => {
    for (const category of [
      "emergency",
      "distress",
      "abusive",
      "spam",
      "out_of_scope",
      "normal",
    ] as const) {
      const decision = route(input(category));
      expect(decision.audit.action).toMatch(/^route\./);
      expect(decision.audit.meta["category"]).toBe(category);
      expect(decision.audit.meta["prompt_version"]).toBe("classifier.v1");
      for (const value of Object.values(decision.audit.meta)) {
        expect(["string", "number", "boolean", "object"]).toContain(typeof value);
      }
    }
  });

  it("never sets runAgent outside the normal route", () => {
    for (const category of ["emergency", "distress", "abusive", "spam", "out_of_scope"] as const) {
      expect(route(input(category)).runAgent, category).toBe(false);
    }
  });
});
