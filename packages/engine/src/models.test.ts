import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MODELS, MODEL_PRIVACY_POSTURE } from "./models.js";

const SRC = fileURLToPath(new URL(".", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() && (path.endsWith(".ts") || path.endsWith(".md")) ? [path] : [];
  });
}

describe("model registry", () => {
  it("is the only place a model id appears", () => {
    // CLAUDE.md §Tech stack: "Model IDs live in packages/engine/src/models.ts
    // only." A copy-pasted id in a prompt, a test fixture or an adapter is how
    // a model silently stops being the one the evals measured.
    const offenders = walk(SRC)
      .filter((path) => !path.endsWith(`${join("src", "models.ts")}`))
      .filter((path) => !path.endsWith("models.test.ts"))
      .filter((path) => /(^|[^a-z-])claude-[a-z0-9-]+/.test(readFileSync(path, "utf8")));

    expect(offenders.map((p) => p.slice(SRC.length))).toEqual([]);
  });

  it("uses a Haiku-class model for the classifier and a Sonnet-class for the agent", () => {
    expect(MODELS.classifier).toContain("haiku");
    expect(MODELS.agent).toContain("sonnet");
  });

  it("pins the classifier to a dated snapshot", () => {
    // The classifier decides whether an emergency gets the emergency script.
    // An alias that moves underneath us changes that decision without a diff.
    expect(MODELS.classifier).toMatch(/-\d{8}$/);
  });

  it("records the data-protection posture the DPIA claims", () => {
    // COMPLIANCE.md §2 + hard rule 4.
    expect(MODEL_PRIVACY_POSTURE.zeroRetention).toBe(true);
    expect(MODEL_PRIVACY_POSTURE.noTraining).toBe(true);
    expect(MODEL_PRIVACY_POSTURE.sendPatientNames).toBe(false);
    expect(MODEL_PRIVACY_POSTURE.attachRequestMetadata).toBe(false);
    expect(MODEL_PRIVACY_POSTURE.maxRetries).toBe(0);
  });
});
