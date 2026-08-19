import { cacheKey, type ClassifierCache } from "./cache.js";
import { ModelCallError, type ModelClient, type ModelMessage } from "./client.js";
import { guessLanguage } from "./language.js";
import { CLASSIFIER_MAX_TOKENS, CLASSIFIER_TIMEOUT_MS, MODELS } from "./models.js";
import { PROMPT_VERSION, classifierSystemPrompt } from "./prompts/index.js";
import { containsSymptomWord, matchSafetyLexicon } from "./safety/index.js";
import {
  CLASSIFIER_CATEGORIES,
  CLASSIFIER_INTENTS,
  CLASSIFIER_LANGUAGES,
  CLASSIFIER_URGENCIES,
  classifierOutputSchema,
  type ClassifierFallbackReason,
  type ClassifierLanguage,
  type ClassifierOutput,
  type ClassifierResult,
} from "./types.js";

/**
 * The safety + intent classifier (CONVERSATION_ENGINE.md §2).
 *
 * Runs on every inbound message before the main model, and can never be
 * bypassed (CLAUDE.md hard rule 1). Three layers, in this order:
 *
 *   1. **Lexicon.** Deterministic regex over EN/SW/Sheng emergency and
 *      distress terms. A hit returns immediately — the model is not called at
 *      all, so a model outage, a slow network or a prompt injection cannot
 *      turn an emergency into a booking request.
 *   2. **Cache.** Identical recent input for the same clinic, served from
 *      memory, to hold the p95 < 400ms target.
 *   3. **Model.** Haiku-class, structured output, 1.5s deadline.
 *
 * Every failure of layer 3 — timeout, transport error, refusal, malformed
 * output — lands on the same fail-safe path, which never produces "normal with
 * high confidence". See `failSafe`.
 */

export interface ClassifierMessage {
  readonly role: "patient" | "clinic";
  readonly text: string;
}

export interface ClassifierInput {
  /** The inbound message (or its voice-note transcript). */
  readonly message: string;
  /**
   * Conversation history, oldest first. Only the last
   * `CONTEXT_MESSAGE_LIMIT` are sent (CONVERSATION_ENGINE.md §2: "last 3
   * messages + current"). COMPLIANCE.md §2 — do not put a patient's full name
   * in here; the classifier does not need it and must not receive it.
   */
  readonly recent?: readonly ClassifierMessage[];
  /** e.g. "General practice". Helps disambiguate what is routine for a clinic. */
  readonly clinicSpecialty?: string;
  /** Scopes the cache. Never sent to the model. */
  readonly clinicId?: string;
}

export interface ClassifierDeps {
  readonly client: ModelClient;
  readonly cache?: ClassifierCache;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

/** CONVERSATION_ENGINE.md §2: "last 3 messages + current". */
export const CONTEXT_MESSAGE_LIMIT = 3;

/**
 * Per-message truncation before anything leaves the tenant boundary.
 * COMPLIANCE.md §2: "Do not send more context than needed." A message longer
 * than this is a pasted document, and the tail rarely changes the category.
 */
export const MAX_CONTEXT_CHARS = 1000;

/**
 * JSON Schema for the structured output.
 *
 * Kept as an explicit object rather than generated from the Zod schema: the
 * structured-outputs subset does not accept `minimum`/`maximum`, so the
 * numeric bounds on `confidence` live only in Zod, where an out-of-range value
 * fails validation and lands on the fail-safe path.
 */
export const CLASSIFIER_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    category: { type: "string", enum: [...CLASSIFIER_CATEGORIES] },
    language: { type: "string", enum: [...CLASSIFIER_LANGUAGES] },
    intent: { type: "string", enum: [...CLASSIFIER_INTENTS] },
    urgency: { type: "string", enum: [...CLASSIFIER_URGENCIES] },
    confidence: { type: "number" },
  },
  required: ["category", "language", "intent", "urgency", "confidence"],
  additionalProperties: false,
};

const PHONE_LIKE = /(?:\+?\d[\d\s-]{7,}\d)/g;

/**
 * Strip identifiers that add nothing to a classification.
 *
 * A phone number never changes whether a message is an emergency, and it is
 * the one identifier patients paste most often ("call me on 07…"). Removing it
 * costs nothing and keeps a directly identifying datum inside the tenant
 * boundary (COMPLIANCE.md §2, hard rule 4).
 */
export function scrubIdentifiers(text: string): string {
  return text.replace(PHONE_LIKE, "[phone]");
}

function clamp(text: string): string {
  const scrubbed = scrubIdentifiers(text).trim();
  return scrubbed.length <= MAX_CONTEXT_CHARS
    ? scrubbed
    : `${scrubbed.slice(0, MAX_CONTEXT_CHARS)}…`;
}

/** Render the model's user turn. Exported so the eval runner sends the real thing. */
export function buildUserContent(input: ClassifierInput): string {
  const parts: string[] = [];

  if (input.clinicSpecialty !== undefined && input.clinicSpecialty.trim() !== "") {
    parts.push(`Clinic specialty: ${input.clinicSpecialty.trim()}`);
  }

  const recent = (input.recent ?? []).slice(-CONTEXT_MESSAGE_LIMIT);
  if (recent.length > 0) {
    const rendered = recent.map((m) => `${m.role}: ${clamp(m.text)}`).join("\n");
    parts.push(`Earlier messages (oldest first):\n${rendered}`);
  }

  parts.push(`Current message:\n${clamp(input.message)}`);
  return parts.join("\n\n");
}

function keyFor(input: ClassifierInput): string {
  const recent = (input.recent ?? []).slice(-CONTEXT_MESSAGE_LIMIT);
  return cacheKey([
    PROMPT_VERSION,
    MODELS.classifier,
    input.clinicId ?? "",
    input.clinicSpecialty ?? "",
    ...recent.map((m) => `${m.role}:${m.text}`),
    input.message,
  ]);
}

function lexiconResult(
  severity: "emergency" | "distress",
  terms: readonly string[],
  input: ClassifierInput,
  latencyMs: number,
): ClassifierResult {
  return {
    output: {
      category: severity,
      language: languageOrOther(input.message),
      intent: "other",
      urgency: "high",
      // Deterministic match: there is nothing uncertain about it.
      confidence: 1,
    },
    source: "lexicon",
    lexiconTerms: terms,
    latencyMs,
    promptVersion: PROMPT_VERSION,
    model: null,
  };
}

function languageOrOther(message: string): ClassifierLanguage {
  return guessLanguage(message);
}

/**
 * The fail-safe result.
 *
 * CONVERSATION_ENGINE.md §2: "Timeout 1.5s → treat as `normal` with `low
 * confidence` … if the message contains any symptom words, route
 * `out_of_scope` instead."
 *
 * Confidence is pinned to 0, not merely lowered: the router treats low
 * confidence as "add the conservative addendum and let a human see this", and
 * a malformed model response must never be able to present itself as a
 * confident "normal". This is the single place where an unknown becomes a
 * decision, so it is written to be boring and to fail toward a human.
 */
function failSafe(
  reason: ClassifierFallbackReason,
  input: ClassifierInput,
  latencyMs: number,
): ClassifierResult {
  const clinical = containsSymptomWord(input.message);
  return {
    output: {
      category: clinical ? "out_of_scope" : "normal",
      language: languageOrOther(input.message),
      intent: "other",
      urgency: clinical ? "low" : "none",
      confidence: 0,
    },
    source: "fallback",
    fallbackReason: reason,
    lexiconTerms: [],
    latencyMs,
    promptVersion: PROMPT_VERSION,
    model: MODELS.classifier,
  };
}

/** Parse and validate the model's text. Returns undefined when unusable. */
export function parseClassifierOutput(text: string): ClassifierOutput | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = classifierOutputSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export async function classify(
  input: ClassifierInput,
  deps: ClassifierDeps,
): Promise<ClassifierResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const elapsed = (): number => now() - startedAt;

  // ---- Layer 1: deterministic lexicon, before the model, always. ----------
  const lexicon = matchSafetyLexicon(input.message);
  if (lexicon.severity !== null) {
    return lexiconResult(lexicon.severity, lexicon.terms, input, elapsed());
  }

  // ---- Layer 2: cache. ---------------------------------------------------
  const key = deps.cache ? keyFor(input) : undefined;
  if (deps.cache && key !== undefined) {
    const hit = deps.cache.get(key);
    if (hit) {
      return {
        output: hit,
        source: "cache",
        lexiconTerms: [],
        latencyMs: elapsed(),
        promptVersion: PROMPT_VERSION,
        model: MODELS.classifier,
      };
    }
  }

  // ---- Layer 3: model. ---------------------------------------------------
  const messages: ModelMessage[] = [{ role: "user", content: buildUserContent(input) }];

  let text: string;
  try {
    const response = await deps.client.structured({
      model: MODELS.classifier,
      system: classifierSystemPrompt(),
      messages,
      jsonSchema: CLASSIFIER_JSON_SCHEMA,
      maxTokens: CLASSIFIER_MAX_TOKENS,
      timeoutMs: deps.timeoutMs ?? CLASSIFIER_TIMEOUT_MS,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
    text = response.text;
  } catch (error) {
    const reason: ClassifierFallbackReason =
      error instanceof ModelCallError ? error.reason : "transport_error";
    return failSafe(reason, input, elapsed());
  }

  const output = parseClassifierOutput(text);
  if (!output) {
    return failSafe("malformed_output", input, elapsed());
  }

  if (deps.cache && key !== undefined) deps.cache.set(key, output);

  return {
    output,
    source: "model",
    lexiconTerms: [],
    latencyMs: elapsed(),
    promptVersion: PROMPT_VERSION,
    model: MODELS.classifier,
  };
}
