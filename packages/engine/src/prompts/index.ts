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
 */
export const PROMPT_VERSION = "classifier.v1";

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

let cached: string | undefined;

/** The classifier system prompt, read once per process. */
export function classifierSystemPrompt(): string {
  cached ??= loadPrompt("classifier.v1.md");
  return cached;
}
