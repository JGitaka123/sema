import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Building a Fastify instance registers plugins and compiles schemas.
    // The default 10s hook timeout is tight on a cold cache / slow CI runner.
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
