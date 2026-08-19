/**
 * @sema/channels — how Sema talks to patients.
 *
 * The `Channel` interface (ARCHITECTURE.md §6) plus the WhatsApp Cloud API
 * adapter. Nothing in here knows about clinics, Postgres or queues: it turns a
 * Sema message into an HTTP call and a Meta webhook into events.
 *
 * Nothing outside the outbox worker may call a channel directly
 * (CLAUDE.md §Conventions) — request handlers write to `outbox`.
 */
export * from "./types.js";
export * from "./whatsapp/adapter.js";
export * from "./whatsapp/errors.js";
export * from "./whatsapp/jobs.js";
export * from "./whatsapp/payloads.js";
export * from "./whatsapp/signature.js";
export * from "./whatsapp/webhook.js";
