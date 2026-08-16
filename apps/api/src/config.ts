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
  return {
    ...value,
    isProduction: value.NODE_ENV === "production",
    corsOrigins: value.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  };
}
