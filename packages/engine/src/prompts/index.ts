import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Prompt versioning (CONVERSATION_ENGINE.md §10).
 *
 * "Changing behaviour = new version file + eval run + `PROMPT_VERSION` bump
 * recorded on `message.meta.prompt_version`." So: never edit
 * `classifier.v1.md` to change behaviour — add `classifier.v2.md`, point the
 * loader at it, bump the constant, and re-run `pnpm test:evals`. Editing v1 in
 * place would silently invalidate every eval result and audit row that claims
 * to have been produced by v1.
 *
 * Each prompt carries its own version, because they move independently: a
 * classifier change must not invalidate the agent's eval baseline and vice
 * versa. `PROMPT_VERSION` keeps its Phase 4 meaning (the classifier) so the
 * rows already stamped with it still mean what they said.
 */
export const PROMPT_VERSION = "classifier.v1";

/** Stamped on `message.meta.prompt_version` for every agent-authored reply. */
export const AGENT_PROMPT_VERSION = "agent.v1";

/** The guardrail's fast advice check (CONVERSATION_ENGINE.md §4.1). */
export const GUARDRAIL_PROMPT_VERSION = "guardrail.v1";

/** Conversation summaries (CONVERSATION_ENGINE.md §8). */
export const SUMMARY_PROMPT_VERSION = "summary.v1";

/**
 * `../../src/prompts/…` resolves to the same directory from `src/prompts`
 * (vitest, tsx) and from `dist/prompts` (built), because both live exactly two
 * levels under the package root. `package.json` ships `src/prompts` in `files`
 * for the same reason.
 */
function loadPrompt(name: string): string {
  const path = fileURLToPath(new URL(`../../src/prompts/${name}`, import.meta.url));
  return readFileSync(path, "utf8").trim();
}

const cache = new Map<string, string>();

function cached(name: string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const text = loadPrompt(name);
  cache.set(name, text);
  return text;
}

/** The classifier system prompt, read once per process. */
export function classifierSystemPrompt(): string {
  return cached("classifier.v1.md");
}

/**
 * The agent prompt *template*. Placeholders are filled by `renderAgentPrompt`
 * in `context.ts`; this function deliberately returns the unfilled text so the
 * template is a reviewable artefact rather than a string built in code.
 */
export function agentPromptTemplate(): string {
  return cached("agent.v1.md");
}

export function guardrailSystemPrompt(): string {
  return cached("guardrail.v1.md");
}

export function summarySystemPrompt(): string {
  return cached("summary.v1.md");
}

/**
 * Substitute `{{PLACEHOLDER}}` tokens.
 *
 * Unknown placeholders are a programming error, not a runtime surprise: a
 * prompt that ships to the model with a literal `{{PATIENT_CARD}}` in it would
 * be a silent, invisible regression, so this throws instead.
 */
export function fillPrompt(template: string, values: Readonly<Record<string, string>>): string {
  const filled = template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`Prompt placeholder {{${key}}} has no value.`);
    }
    return value;
  });
  return filled;
}
