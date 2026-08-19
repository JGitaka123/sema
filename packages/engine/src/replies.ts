import { DEFAULT_LANGUAGE, interpolate, t, type Language } from "@sema/shared";

import type { ClassifierLanguage } from "./types.js";

/**
 * Scripted, clinician-reviewed replies.
 *
 * CONVERSATION_ENGINE.md §5: "Scripted messages (emergency, out-of-scope,
 * payment prompts, reminders) exist in `shared/i18n/en.json` and `sw.json`;
 * Sheng uses the `sw` casual variant." The model never paraphrases these — a
 * safety script that a model rewrote is a script nobody reviewed.
 *
 * Everything here is pure: given a language and a clinic config it returns
 * text. Delivery is Phase 5's job (write to `outbox`, worker sends).
 */

/** Keys this package is allowed to render. `replies.test.ts` asserts all exist in en + sw. */
export const SCRIPTED_KEYS = [
  "safety.emergency",
  "safety.distress",
  "safety.out_of_scope",
  "safety.abuse_warning",
  "consent.ai_disclosure",
  "handover.in_hours",
  "handover.out_of_hours",
] as const;

export type ScriptedKey = (typeof SCRIPTED_KEYS)[number];

/**
 * Sentinel used when a clinic overrides the emergency wording
 * (`clinic.emergency_script_override`). Not an i18n key — the text is the
 * clinic's own, and it is rendered verbatim apart from placeholders.
 */
export const CLINIC_OVERRIDE_KEY = "clinic.emergency_script_override";

/**
 * Befrienders Kenya, the default second line in the distress script alongside
 * Kenya Red Cross 1199 (SAFETY.md §4: "configurable"). A clinic that has its
 * own counselling partner sets `befriendersPhone` and this is never used.
 */
export const DEFAULT_BEFRIENDERS_PHONE = "+254 722 178 177";

export interface ClinicScriptConfig {
  readonly name: string;
  /** `clinic.default_language`. Used when the patient's language is unclear. */
  readonly defaultLanguage: Language;
  /** `clinic.emergency_script_override` — SAFETY.md §3 "clinic can override wording". */
  readonly emergencyScriptOverride?: string | null;
  /** Overrides the Befrienders line in the distress script. */
  readonly befriendersPhone?: string | null;
  /** Shown out of hours so an urgent patient has a human number. */
  readonly clinicPhone?: string | null;
  /** What the out-of-scope script offers, e.g. "Dr Wanjiru" or "a GP". */
  readonly providerLabel?: string | null;
  /** Short privacy-notice link for the AI disclosure (COMPLIANCE.md §1). */
  readonly privacyUrl?: string | null;
  /** Rendered into the out-of-hours handover message. */
  readonly opensAt?: string | null;
}

/**
 * The register a reply is written in.
 *
 * Sheng is not a locale (see the note in `@sema/shared/i18n`): it is `sw` text
 * in a casual register. Scripted safety copy ships only in the reviewed `en`
 * and `sw` variants, so a Sheng speaker gets the `sw` script and this flag
 * tells Phase 5's agent — which *may* write freely — to match the register in
 * any surrounding conversational text.
 */
export type Register = "standard" | "casual";

export interface ReplyLanguage {
  readonly language: Language;
  readonly register: Register;
}

/** Map a classifier language onto a reviewed script locale. */
export function resolveReplyLanguage(
  detected: ClassifierLanguage | undefined,
  clinicDefault: Language = DEFAULT_LANGUAGE,
): ReplyLanguage {
  switch (detected) {
    case "en":
      return { language: "en", register: "standard" };
    case "sw":
      return { language: "sw", register: "standard" };
    case "sheng":
      return { language: "sw", register: "casual" };
    // "mixed" and "other" both mean "we are not sure enough to switch away
    // from what the clinic configured".
    default:
      return { language: clinicDefault, register: "standard" };
  }
}

export interface ScriptedReply {
  /** i18n key, or `CLINIC_OVERRIDE_KEY`. Safe to log — it is not patient text. */
  readonly key: string;
  readonly language: Language;
  readonly register: Register;
  readonly body: string;
}

function render(
  key: ScriptedKey,
  lang: ReplyLanguage,
  vars: Record<string, string | number>,
): ScriptedReply {
  return {
    key,
    language: lang.language,
    register: lang.register,
    body: t(lang.language, key, vars),
  };
}

/**
 * SAFETY.md §3, verbatim script + clinic override.
 *
 * The override is interpolated but not otherwise processed: if a clinic wants
 * a different emergency number or a different instruction, that is their
 * clinical decision to make and record.
 */
export function emergencyReply(clinic: ClinicScriptConfig, lang: ReplyLanguage): ScriptedReply {
  const vars = { clinic: clinic.name };
  const override = clinic.emergencyScriptOverride;
  if (typeof override === "string" && override.trim() !== "") {
    return {
      key: CLINIC_OVERRIDE_KEY,
      language: lang.language,
      register: lang.register,
      body: interpolate(override.trim(), vars),
    };
  }
  return render("safety.emergency", lang, vars);
}

/** SAFETY.md §4 — warmth, no counselling, Red Cross 1199 + Befrienders. */
export function distressReply(clinic: ClinicScriptConfig, lang: ReplyLanguage): ScriptedReply {
  return render("safety.distress", lang, {
    clinic: clinic.name,
    befrienders_phone: clinic.befriendersPhone ?? DEFAULT_BEFRIENDERS_PHONE,
  });
}

/** SAFETY.md §5 — refuse advice, offer the earliest appointment or a nurse call. */
export function outOfScopeReply(clinic: ClinicScriptConfig, lang: ReplyLanguage): ScriptedReply {
  return render("safety.out_of_scope", lang, {
    clinic: clinic.name,
    provider: clinic.providerLabel ?? (lang.language === "sw" ? "daktari" : "a doctor"),
  });
}

/** SAFETY.md §7 — one cool-down attempt before the mute. */
export function abuseWarningReply(clinic: ClinicScriptConfig, lang: ReplyLanguage): ScriptedReply {
  return render("safety.abuse_warning", lang, { clinic: clinic.name });
}

/**
 * COMPLIANCE.md §1 + §6 — the AI disclosure, sent once at first contact.
 * Recorded against `patient_consent` by the caller (Phase 5).
 */
export function consentNoticeReply(clinic: ClinicScriptConfig, lang: ReplyLanguage): ScriptedReply {
  return render("consent.ai_disclosure", lang, {
    clinic: clinic.name,
    privacy_url: clinic.privacyUrl ?? "",
  });
}

/** SAFETY.md §6 — the holding message the agent must send when escalating. */
export function handoverReply(
  clinic: ClinicScriptConfig,
  lang: ReplyLanguage,
  inHours: boolean,
): ScriptedReply {
  return inHours
    ? render("handover.in_hours", lang, { clinic: clinic.name })
    : render("handover.out_of_hours", lang, {
        clinic: clinic.name,
        opens_at: clinic.opensAt ?? "8am",
        clinic_phone: clinic.clinicPhone ?? "",
      });
}
