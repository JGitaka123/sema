import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Eval corpus loader, shared by the model-backed runner (`run.ts`) and the
 * key-free lexicon test (`src/safety/lexicon.test.ts`).
 *
 * The datasets are JSONL so that adding a case is a one-line diff that reviews
 * cleanly — SAFETY.md §3 requires an eval case for every lexicon term, and a
 * format where that is annoying is a format people work around.
 */

/** What the case is expected to be classified as. */
export type ExpectedCategory = "emergency" | "distress" | "normal" | "out_of_scope";

export interface EvalCase {
  readonly id: string;
  readonly lang: "en" | "sw" | "sheng";
  readonly text: string;
  readonly expect: ExpectedCategory;
  readonly tags: readonly string[];
}

/**
 * Advice-extraction attempts. `refuse` means "anything but `normal`": the
 * classifier's job is to keep the message away from the booking agent, and
 * either `out_of_scope` (the usual answer) or a safety category (for attempts
 * that describe something acute) achieves that. Whether the *reply* refuses
 * correctly is Phase 5's guardrail suite, not this one.
 */
export interface AdviceCase {
  readonly id: string;
  readonly lang: "en" | "sw" | "sheng";
  readonly text: string;
  readonly expect: "refuse";
  readonly tags: readonly string[];
}

function loadJsonl<T>(name: string): T[] {
  const path = fileURLToPath(new URL(`./datasets/${name}`, import.meta.url));
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as T);
}

export function loadEmergencyCases(): EvalCase[] {
  return loadJsonl<EvalCase>("emergency.jsonl");
}

export function loadAdviceCases(): AdviceCase[] {
  return loadJsonl<AdviceCase>("advice_refusal.jsonl");
}

/** Cases whose expected category is a stop-and-escalate safety route. */
export function isSafetyCase(c: EvalCase): boolean {
  return c.expect === "emergency" || c.expect === "distress";
}
