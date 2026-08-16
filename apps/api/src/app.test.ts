import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    config: loadConfig({ NODE_ENV: "test" }),
    logger: false,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("does not require a database or redis connection", async () => {
    // No DATABASE_URL / REDIS_URL are set in this test process. If the health
    // route ever starts touching them, this fails — which is the point:
    // liveness must not flap because a dependency is slow.
    expect(process.env["DATABASE_URL"]).toBeUndefined();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
  });

  it("is serialised through the Zod response schema", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    // Anything not declared in the schema is stripped by the serializer.
    expect(Object.keys(response.json() as object)).toEqual(["status"]);
  });
});

describe("OpenAPI document", () => {
  it("is generated from the Zod schemas", () => {
    const document = app.swagger() as {
      openapi: string;
      info: { title: string };
      paths: Record<string, unknown>;
    };

    expect(document.openapi).toMatch(/^3\./);
    expect(document.info.title).toBe("Sema API");
    expect(document.paths["/health"]).toBeDefined();
  });

  it("describes the health response body", () => {
    const document = app.swagger() as Record<string, never>;
    const serialised = JSON.stringify(document);
    expect(serialised).toContain("Liveness probe");
    expect(serialised).toContain("status");
  });
});

describe("unknown routes", () => {
  it("returns a typed 404 envelope, not an HTML page", async () => {
    const response = await app.inject({ method: "GET", url: "/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Route not found." },
    });
  });
});

describe("error handler", () => {
  it("never leaks internal error messages to the client", async () => {
    const isolated = await buildApp({ config: loadConfig({ NODE_ENV: "test" }), logger: false });
    isolated.get("/boom", async () => {
      throw new Error("connection string postgres://user:hunter2@db/sema");
    });
    await isolated.ready();

    const response = await isolated.inject({ method: "GET", url: "/boom" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "INTERNAL", message: "Something went wrong." },
    });
    expect(response.body).not.toContain("hunter2");

    await isolated.close();
  });
});

describe("config", () => {
  it("applies documented defaults", () => {
    const config = loadConfig({});
    expect(config.API_PORT).toBe(3001);
    expect(config.API_HOST).toBe("0.0.0.0");
    expect(config.isProduction).toBe(false);
  });

  it("coerces API_PORT and splits CORS origins", () => {
    const config = loadConfig({
      API_PORT: "8080",
      CORS_ORIGINS: "http://localhost:3000, https://inbox.sema.health",
    });
    expect(config.API_PORT).toBe(8080);
    expect(config.corsOrigins).toEqual(["http://localhost:3000", "https://inbox.sema.health"]);
  });

  it("rejects an invalid environment rather than booting", () => {
    expect(() => loadConfig({ API_PORT: "not-a-port" })).toThrowError(/Invalid API environment/);
    expect(() => loadConfig({ NODE_ENV: "staging" })).toThrowError(/Invalid API environment/);
  });
});
