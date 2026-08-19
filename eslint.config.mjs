import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * Flat config shared by every workspace package (each package re-exports this
 * file). Deliberately non-type-aware: `pnpm lint` runs on the Husky pre-commit
 * hook and must stay fast. Type errors are caught by `pnpm typecheck`.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      // Hard rule 4: no PHI in logs. console.* bypasses the pino redaction
      // config, so it is banned outside of scripts.
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "smart"],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/vitest.config.ts", "**/*.config.*"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // Operator-facing scripts (migrate, seed, simulators) and test harnesses
    // print to a terminal, not to the log pipeline. They still must not print
    // PHI: phone numbers go through `maskPhone` (hard rule 4).
    files: ["**/scripts/**", "**/src/migrate.ts", "**/src/seed/**", "**/test/**"],
    rules: {
      "no-console": "off",
    },
  },
  prettier,
);
