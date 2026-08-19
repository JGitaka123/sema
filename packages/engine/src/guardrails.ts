import { z } from "zod";

import { ModelCallError, type ModelClient } from "./client.js";
import { guessLanguage } from "./language.js";
import { GUARDRAIL_MAX_TOKENS, GUARDRAIL_TIMEOUT_MS, MODELS } from "./models.js";
import { guardrailSystemPrompt } from "./prompts/index.js";
import type { ClassifierLanguage } from "./types.js";

/**
 * Post-check guardrails (CONVERSATION_ENGINE.md §4, SAFETY.md §8).
 *
 * "Guardrails are code. Post-check runs on every reply. Emergency lexicon is
 * deterministic. Policies live in tools. Prompts are defence in depth, not the
 * only defence."
 *
 * Five checks run on every agent reply, in this order:
 *
 *   1. clinical advice — regex, then a fast-model yes/no
 *   2. fact grounding  — every price, time, clinician and address must appear
 *                        in the knowledge or in this turn's tool results
 *   3. PII leak        — no phone number and no name outside this turn's scope
 *   4. language        — soft warning only
 *   5. length / format — markdown stripped, length capped (a repair, not a fail)
 *
 * A failure gets one rewrite with the violation named. A second failure gets
 * the generic safe reply and `escalate(agent_error)`. The rewrite is a courtesy
 * to the patient's experience; the escalation is the actual safety property,
 * and it does not depend on the model cooperating.
 */

export type GuardrailCheck = "clinical_advice" | "grounding" | "pii" | "language" | "format";

export interface GuardrailViolation {
  readonly check: GuardrailCheck;
  /**
   * Fed back to the model on the rewrite, and written to the audit row.
   * PHI-free: it names the *kind* of problem and the offending token only when
   * that token is a number or a title, never a sentence of patient text.
   */
  readonly detail: string;
  readonly severity: "fail" | "warn";
}

export interface GuardrailResult {
  /** The repaired text: markdown stripped and length capped, always. */
  readonly text: string;
  readonly violations: readonly GuardrailViolation[];
  readonly failed: boolean;
  readonly warnings: readonly GuardrailViolation[];
}

export interface GuardrailInput {
  readonly reply: string;
  /**
   * Everything the agent was entitled to say this turn: the rendered clinic
   * facts plus every `facts` array and tool result from this turn's calls.
   */
  readonly groundingCorpus: string;
  /** The classifier's reading of the patient's language. */
  readonly patientLanguage: ClassifierLanguage;
  /** Numbers the agent may print: the clinic's own, never a patient's. */
  readonly allowedPhones?: readonly string[];
  /** The patient's own first name, which is allowed to appear. */
  readonly patientFirstName?: string | null;
}

export interface GuardrailDeps {
  /** Omit to run the deterministic checks only (unit tests, no key). */
  readonly client?: ModelClient;
  readonly signal?: AbortSignal;
}

/** §3.1 output rules: "≤ 600 chars unless listing slots". */
export const MAX_REPLY_CHARS = 600;
export const MAX_REPLY_CHARS_LISTING = 1000;

// ── 5. Format ────────────────────────────────────────────────────────────────

/**
 * Strip markdown.
 *
 * WhatsApp does not render it, so `**Tuesday**` reaches the patient with the
 * asterisks in it. The model is told not to emit markdown; this is what happens
 * when it does anyway. It is a repair rather than a failure — rewriting a whole
 * reply because of a stray asterisk would trade a cosmetic problem for a
 * latency one.
 */
export function stripMarkdown(text: string): string {
  return (
    text
      // Fenced and inline code.
      .replace(/```[a-z]*\n?/gi, "")
      .replace(/`([^`]*)`/g, "$1")
      // Links and images: keep the label, drop the URL.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Headings and blockquotes at line start.
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      // Bullets: turn into a plain dash so a list still reads as a list.
      .replace(/^\s{0,3}[*+]\s+/gm, "- ")
      // Emphasis. Done after bullets so a leading "* " is not eaten as italics.
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
      .replace(/(^|\s)_([^_\n]+)_/g, "$1$2")
      // Horizontal rules.
      .replace(/^\s{0,3}([-*_])\1{2,}\s*$/gm, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** A reply that lists times gets the larger budget (§3.1). */
export function isSlotListing(text: string): boolean {
  return (text.match(TIME_RE) ?? []).length >= 2;
}

/** Cap length on a sentence boundary where possible — a chopped word reads as a bug. */
export function capLength(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const lastStop = Math.max(head.lastIndexOf("."), head.lastIndexOf("?"), head.lastIndexOf("\n"));
  return (lastStop > limit * 0.6 ? head.slice(0, lastStop + 1) : head).trim();
}

// ── 1. Clinical advice ───────────────────────────────────────────────────────

/**
 * Deterministic advice patterns.
 *
 * These fire *before* any model call, so a model outage cannot disable the
 * check. They are deliberately narrow: each one matches a construction that has
 * no administrative reading, which is why "you have an appointment" does not
 * trip `you have`, and why the refusal phrasing the agent is told to use
 * ("I can't advise on symptoms") is not itself a hit.
 */
export const ADVICE_PATTERNS: readonly { readonly id: string; readonly re: RegExp }[] = [
  { id: "diagnosis_named", re: /\b(?:you|it|this|that)\s+(?:probably |likely |may |might |could )?(?:have|has|is|are)\s+(?:an?\s+)?(?:infection|allergy|allergic reaction|migraine|ulcer|malaria|typhoid|pneumonia|uti|urinary tract infection|abscess|cavity|gingivitis|anaemia|anemia|diabetes|hypertension|covid|flu|virus|bacterial|viral)\b/i },
  { id: "sounds_like", re: /\b(?:sounds?|looks?|seems?)\s+like\s+(?:it(?:'s| is)\s+)?(?:an?|your|the)\b(?!\s+(?:booking|appointment|time|slot|deposit|payment)\b)/i },
  { id: "likelihood", re: /\b(?:most likely|probably just|it(?:'s| is) probably|chances are|in my opinion it)\b/i },
  { id: "dosage", re: /\b\d+\s?(?:mg|ml|mcg|g)\b|\b(?:take|swallow|apply|use)\s+(?:one|two|three|\d+)\s+(?:tablet|tablets|capsule|capsules|spoon|spoons|drops?|puffs?)\b/i },
  { id: "medication_advice", re: /\b(?:you (?:should|can|could|may)|I(?:'d| would) (?:recommend|suggest|advise))\s+(?:take|taking|start|starting|stop|stopping|switch|continue|avoid taking|try)\b/i },
  { id: "otc_suggestion", re: /\b(?:paracetamol|panadol|ibuprofen|brufen|amoxicillin|antibiotics?|painkillers?|antihistamines?|antacids?)\b/i },
  { id: "reassurance", re: /\b(?:nothing to worry about|no cause for (?:alarm|concern)|(?:that(?:'s| is)|it(?:'s| is)) (?:perfectly )?(?:normal|harmless|common|fine)\b(?!\s+(?:to (?:ask|reschedule|cancel|change)|for us|with us))|you(?:'ll| will) be fine|it will (?:pass|clear up|go away)|not serious)\b/i },
  { id: "wait_advice", re: /\b(?:you can wait|no (?:need|rush) to (?:come|be seen|see)|it can wait|doesn(?:'t|t) need (?:urgent|immediate) (?:attention|care)|no need to see a doctor)\b/i },
  { id: "self_care", re: /\b(?:rinse with (?:warm )?salt|gargle|apply (?:ice|a cold compress|heat)|drink (?:plenty of |more )?(?:fluids|water) (?:and|to)|get some rest and|elevate the|keep it (?:dry|clean and)|put (?:ice|a warm compress))\b/i },
  { id: "severity_judgement", re: /\b(?:that|this|it)(?:'s| is| sounds| looks| seems)?\s+(?:really |quite |very |not |probably )?(?:urgent|serious|an emergency|severe|mild|worrying|concerning|dangerous)\b/i },
  { id: "interpretation", re: /\b(?:your (?:results?|scan|x-?ray|report|photo|picture)\s+(?:shows?|suggests?|indicates?|means?)|from (?:the|your) (?:photo|picture|image)\s+I)\b/i },
  { id: "clinical_outcome", re: /\bthe (?:doctor|dentist|nurse|clinician) will (?:definitely|certainly|be able to (?:cure|fix|remove it))\b/i },
  { id: "impersonation", re: /\bas (?:a|your) (?:doctor|nurse|dentist|clinician|medical professional)\b/i },
];

export function detectAdvicePatterns(text: string): readonly string[] {
  return ADVICE_PATTERNS.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.id);
}

const adviceVerdictSchema = z.object({ gives_medical_advice: z.boolean() }).strict();

const ADVICE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { gives_medical_advice: { type: "boolean" } },
  required: ["gives_medical_advice"],
  additionalProperties: false,
};

/**
 * The model half of check 1.
 *
 * Fails **closed on a positive only**: a timeout or a malformed answer leaves
 * the regex verdict standing rather than blocking a correct reply. The
 * asymmetry is deliberate — the deterministic layer is the guarantee, and a
 * flaky network must not be able to turn every booking confirmation into an
 * escalation.
 */
export async function modelSaysAdvice(
  text: string,
  deps: GuardrailDeps,
): Promise<boolean | undefined> {
  if (!deps.client) return undefined;
  try {
    const response = await deps.client.structured({
      model: MODELS.classifier,
      system: guardrailSystemPrompt(),
      messages: [{ role: "user", content: `Message under review:\n${text}` }],
      jsonSchema: ADVICE_JSON_SCHEMA,
      maxTokens: GUARDRAIL_MAX_TOKENS,
      timeoutMs: GUARDRAIL_TIMEOUT_MS,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
    const parsed = adviceVerdictSchema.safeParse(JSON.parse(response.text) as unknown);
    return parsed.success ? parsed.data.gives_medical_advice : undefined;
  } catch (error) {
    if (error instanceof ModelCallError || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

// ── 2. Fact grounding ────────────────────────────────────────────────────────

/** "KES 1,500", "1500 shillings", "1,500/-" — the ways a price gets written. */
const MONEY_RE = /\b(?:KES|Ksh|KSh|sh|shs)\.?\s?([\d][\d,.]*)|\b([\d][\d,.]*)\s?(?:shillings?|bob)\b/gi;
/** "9:30am", "9 am", "14:00". Bare "9" is not a time — too many false hits. */
const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s?([ap]\.?m\.?)\b|\b(\d{1,2}):(\d{2})\b/gi;
/** "Dr Otieno", "Dr. Samuel Otieno", "Daktari Wanjiru". */
const CLINICIAN_RE = /\b(?:Dr\.?|Doctor|Daktari|Nurse|Sister)\s+([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)?)/gu;
/** A line that reads like a street address. */
const ADDRESS_RE = /\b\d*\s*[A-Z][\p{L}'-]+\s+(?:Road|Rd|Street|St|Avenue|Ave|Lane|Plaza|Towers?|Court|Close|Drive|Highway|Way)\b/gu;

/** Normalise for comparison: case, punctuation and thousands separators away. */
function normalise(value: string): string {
  return value
    .toLowerCase()
    // `\s` already covers the non-breaking space WhatsApp inserts.
    .replace(/[\s,.]/g, "")
    .replace(/[–—]/g, "-");
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

interface Claim {
  readonly kind: "amount" | "time" | "clinician" | "address";
  readonly text: string;
  /** The comparable form. */
  readonly key: string;
}

/**
 * Pull the checkable factual claims out of a reply.
 *
 * Only four kinds, exactly as CONVERSATION_ENGINE.md §4.2 lists them: "any KES
 * amount, time range, doctor name, or address". The check is deliberately not a
 * general-purpose fact checker — a narrow check that always runs beats a broad
 * one that has to be tuned down until it never fires.
 */
export function extractClaims(reply: string): readonly Claim[] {
  const claims: Claim[] = [];

  for (const match of reply.matchAll(MONEY_RE)) {
    const amount = match[1] ?? match[2];
    if (amount === undefined) continue;
    claims.push({ kind: "amount", text: match[0], key: digitsOf(amount) });
  }

  for (const match of reply.matchAll(TIME_RE)) {
    const hour = match[1] ?? match[4];
    const minute = match[2] ?? match[5] ?? "00";
    if (hour === undefined) continue;
    const meridiem = (match[3] ?? "").replace(/\./g, "").toLowerCase();
    claims.push({
      kind: "time",
      text: match[0],
      key: `${Number(hour)}:${minute.padStart(2, "0")}${meridiem}`,
    });
  }

  for (const match of reply.matchAll(CLINICIAN_RE)) {
    const name = match[1];
    if (name === undefined) continue;
    claims.push({ kind: "clinician", text: match[0], key: normalise(name) });
  }

  for (const match of reply.matchAll(ADDRESS_RE)) {
    claims.push({ kind: "address", text: match[0], key: normalise(match[0]) });
  }

  return claims;
}

/**
 * Every form a time could take in the corpus, so "2:00pm" grounds against
 * "14:00" and against "2 PM". A clinic writes its hours one way and the agent
 * quotes them another, and neither is wrong.
 */
function timeVariants(key: string): readonly string[] {
  const match = /^(\d{1,2}):(\d{2})(am|pm)?$/.exec(key);
  if (!match) return [key];
  const hour = Number(match[1]);
  const minute = match[2] ?? "00";
  const meridiem = match[3];

  const hours24 =
    meridiem === "pm" ? [hour === 12 ? 12 : hour + 12] : meridiem === "am" ? [hour === 12 ? 0 : hour] : [hour, hour + 12, hour - 12];

  const variants = new Set<string>();
  for (const h24 of hours24) {
    if (h24 < 0 || h24 > 23) continue;
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const suffix = h24 < 12 ? "am" : "pm";
    variants.add(normalise(`${h24}:${minute}`));
    variants.add(normalise(`${String(h24).padStart(2, "0")}:${minute}`));
    variants.add(normalise(`${h12}:${minute}${suffix}`));
    variants.add(normalise(`${h12}${suffix}`));
    if (minute === "00") variants.add(normalise(`${h12}.00${suffix}`));
  }
  return [...variants];
}

export function checkGrounding(reply: string, corpus: string): readonly GuardrailViolation[] {
  const haystack = normalise(corpus);
  const digitsHaystack = digitsOf(corpus);
  const violations: GuardrailViolation[] = [];

  for (const claim of extractClaims(reply)) {
    const grounded =
      claim.kind === "amount"
        ? digitsHaystack.includes(claim.key)
        : claim.kind === "time"
          ? timeVariants(claim.key).some((variant) => haystack.includes(variant))
          : haystack.includes(claim.key);

    if (!grounded) {
      violations.push({
        check: "grounding",
        // The claim text is the agent's own invention, not patient data, so
        // naming it is what makes the rewrite prompt and the audit row useful.
        detail: `ungrounded ${claim.kind}: "${claim.text.trim()}" does not appear in the clinic information or in this turn's tool results`,
        severity: "fail",
      });
    }
  }

  return violations;
}

// ── 3. PII ───────────────────────────────────────────────────────────────────

const PHONE_LIKE = /(?:\+?\d[\d\s-]{6,}\d)/g;

/**
 * Emergency and short codes the agent may print: 999, 112, the Red Cross line
 * 1199. These come from the reviewed safety scripts, not from patient data.
 */
const SHORT_CODE_MAX_DIGITS = 5;

export function checkPii(
  reply: string,
  allowedPhones: readonly string[],
  patientFirstName: string | null | undefined,
  corpus: string,
): readonly GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  const allowed = new Set(allowedPhones.map(digitsOf).filter((value) => value !== ""));
  const corpusDigits = digitsOf(corpus);

  for (const match of reply.match(PHONE_LIKE) ?? []) {
    const digits = digitsOf(match);
    if (digits.length <= SHORT_CODE_MAX_DIGITS) continue;
    const known =
      allowed.has(digits) ||
      [...allowed].some((value) => value.endsWith(digits) || digits.endsWith(value)) ||
      corpusDigits.includes(digits);
    if (!known) {
      // The number itself is never repeated into the violation: it may be
      // another patient's, which is the whole reason this check exists.
      violations.push({
        check: "pii",
        detail: `the reply contains a ${digits.length}-digit phone number that is not the clinic's own`,
        severity: "fail",
      });
    }
  }

  // A person's name in the reply must be someone this turn actually knows
  // about: the patient themselves, or a name from the clinic facts / tool
  // results. Anything else is either invented or someone else's (SAFETY.md
  // §1.6).
  const haystack = normalise(corpus);
  const own = patientFirstName == null ? "" : normalise(patientFirstName);
  for (const match of reply.matchAll(CLINICIAN_RE)) {
    const name = match[1];
    if (name === undefined) continue;
    const key = normalise(name);
    if (key === own || haystack.includes(key)) continue;
    violations.push({
      check: "pii",
      detail: `the reply names "${match[0].trim()}", who is not in the clinic information or in this turn's results`,
      severity: "fail",
    });
  }

  return violations;
}

// ── 4. Language ──────────────────────────────────────────────────────────────

/**
 * Soft by design (§4.4: "soft warn").
 *
 * Language detection on two sentences of Sheng is a coin flip, and blocking a
 * correct reply because a heuristic disagreed about register would be a worse
 * failure than the mismatch. The warning is logged so a real drift shows up in
 * aggregate.
 */
export function checkLanguage(
  reply: string,
  patientLanguage: ClassifierLanguage,
): readonly GuardrailViolation[] {
  if (patientLanguage === "mixed" || patientLanguage === "other") return [];
  const replyLanguage = guessLanguage(reply);
  if (replyLanguage === "mixed" || replyLanguage === "other") return [];
  // Sheng is Swahili in a casual register; either reading is a match.
  const same =
    replyLanguage === patientLanguage ||
    (patientLanguage === "sheng" && replyLanguage === "sw") ||
    (patientLanguage === "sw" && replyLanguage === "sheng");
  return same
    ? []
    : [
        {
          check: "language",
          detail: `patient wrote ${patientLanguage}, reply reads as ${replyLanguage}`,
          severity: "warn",
        },
      ];
}

// ── The post-check ───────────────────────────────────────────────────────────

export async function checkReply(
  input: GuardrailInput,
  deps: GuardrailDeps = {},
): Promise<GuardrailResult> {
  // Format first: the later checks should see what the patient would see, not
  // what the model emitted. An asterisk in the middle of a price would
  // otherwise break the grounding match on a reply that was actually correct.
  const stripped = stripMarkdown(input.reply);
  const limit = isSlotListing(stripped) ? MAX_REPLY_CHARS_LISTING : MAX_REPLY_CHARS;
  const text = capLength(stripped, limit);

  const violations: GuardrailViolation[] = [];

  const advicePatterns = detectAdvicePatterns(text);
  if (advicePatterns.length > 0) {
    violations.push({
      check: "clinical_advice",
      detail: `reads as clinical advice (${advicePatterns.join(", ")}). You are the front desk: refuse the clinical part, then offer an appointment or a call from the team.`,
      severity: "fail",
    });
  } else if ((await modelSaysAdvice(text, deps)) === true) {
    violations.push({
      check: "clinical_advice",
      detail:
        "a safety review judged this to give medical advice. Remove anything that names, judges or reassures about a symptom, and offer an appointment instead.",
      severity: "fail",
    });
  }

  violations.push(...checkGrounding(text, input.groundingCorpus));
  violations.push(
    ...checkPii(text, input.allowedPhones ?? [], input.patientFirstName, input.groundingCorpus),
  );
  violations.push(...checkLanguage(text, input.patientLanguage));

  if (stripped.length > limit) {
    violations.push({
      check: "format",
      detail: `reply was ${stripped.length} characters and was trimmed to ${limit}`,
      severity: "warn",
    });
  }

  const failures = violations.filter((violation) => violation.severity === "fail");
  return {
    text,
    violations,
    failed: failures.length > 0,
    warnings: violations.filter((violation) => violation.severity === "warn"),
  };
}

/** The instruction handed back to the model for its one rewrite attempt. */
export function rewriteInstruction(violations: readonly GuardrailViolation[]): string {
  const failures = violations.filter((violation) => violation.severity === "fail");
  const lines = failures.map((violation) => `- ${violation.check}: ${violation.detail}`);
  return [
    "Your reply was blocked before it was sent. It has not reached the patient.",
    "",
    ...lines,
    "",
    "Write the message again, fixing exactly those problems. Do not argue, do not explain the block to the patient, and do not state any fact you have not been given. If you cannot answer without one of the blocked claims, say you will check with the team instead.",
  ].join("\n");
}
