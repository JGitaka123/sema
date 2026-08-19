import { z } from "zod";

/**
 * Environment is parsed once, at the boundary, with Zod — like every other
 * boundary in Sema. A missing or malformed variable fails at boot rather than
 * at 2am inside a webhook handler.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(3001),
  API_PUBLIC_URL: z.string().url().default("http://localhost:3001"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),

  // ── WhatsApp Cloud API (Phase 3, INTEGRATIONS.md §1) ─────────────────────
  /**
   * The Meta app secret. Every inbound webhook is HMAC-verified against it
   * (ARCHITECTURE.md §9). Optional in the schema so `pnpm test` and a fresh
   * clone boot without it; the refinement below makes it mandatory in
   * production, where a missing secret would mean an unauthenticated endpoint
   * that writes to patient records.
   */
  WHATSAPP_APP_SECRET: z.string().min(1).optional(),
  /** Echoed back on Meta's GET verification handshake. */
  WHATSAPP_VERIFY_TOKEN: z.string().min(1).optional(),
  WHATSAPP_GRAPH_VERSION: z.string().default("v20.0"),
});

export type ApiConfig = z.infer<typeof EnvSchema> & {
  readonly isProduction: boolean;
  readonly corsOrigins: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid API environment — ${issues}`);
  }
  const value = parsed.data;

  // Fail at boot, loudly, rather than serving an endpoint that cannot
  // authenticate its caller. The webhook itself also fails closed
  // (`verifySignature` returns `missing_secret`), but a production process
  // that cannot receive messages should not pretend to be healthy.
  if (value.NODE_ENV === "production") {
    const missing = (
      [
        ["WHATSAPP_APP_SECRET", value.WHATSAPP_APP_SECRET],
        ["WHATSAPP_VERIFY_TOKEN", value.WHATSAPP_VERIFY_TOKEN],
      ] as const
    )
      .filter(([, v]) => v === undefined)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(`Invalid API environment — ${missing.join(", ")} is required in production.`);
    }
  }

  return {
    ...value,
    isProduction: value.NODE_ENV === "production",
    corsOrigins: value.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  };
}
