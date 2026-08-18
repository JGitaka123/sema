import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

/**
 * Process entrypoint. Owns listening and graceful shutdown; `buildApp` owns
 * everything else so tests never bind a port.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config });

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, "shutting down");
    // Let in-flight webhook acks finish, then exit. Fly sends SIGTERM and
    // waits before SIGKILL.
    void app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
}

main().catch((error: unknown) => {
  console.error("api failed to start", error);
  process.exit(1);
});
