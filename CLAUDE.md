# Sema — Project Memory

> **Working name:** Sema ("speak" in Swahili). Confirm trademark + domain before public launch, then replace globally (`rg -l "Sema"`).

## What this is

An AI front-desk for clinics. It talks to patients on WhatsApp — answering questions, booking / rescheduling / cancelling appointments, sending reminders, collecting deposits via M-Pesa — while clinic staff supervise from a shared inbox and take over any conversation at any time.

**Launch market: Kenya. Founding clinic: Afyanex (owned by the founder; live design partner).** Multi-tenant and multi-region from day one so it scales across East Africa and later Western markets.

The front-desk is the wedge. The long-term expansion is claims / revenue-cycle automation (SHA and beyond, see the ClaimFlow project). Architecture must not preclude that; **do not build claims features in v1.**

**This is a healthcare product. Patient safety and data protection are not features, they are constraints. Read `docs/SAFETY.md` and `docs/COMPLIANCE.md` before touching the conversation engine or any patient data.**

Always read `docs/SPEC.md` for product intent before any non-trivial task. `docs/BUILD_PLAN.md` says what to build in what order.

## Locked architectural decisions (see docs/adr/)

1. **ADR-001** WhatsApp Cloud API direct, one number per clinic, Sema as Meta Tech Provider (Embedded Signup).
2. **ADR-002** Internal scheduler for v1. No external calendar / EMR sync until Phase 2.
3. **ADR-003** Non-custodial payments. M-Pesa STK Push lands in the clinic's own Paybill/Till. Sema never holds funds.
4. **ADR-004** Afyanex is the founding design partner; its front-desk staff are the primary inbox users.
5. **ADR-005** Claims / RCM deferred to Phase 3; data model keeps `patient`, `encounter`, `payer` shape.

Do not re-litigate these in code. If a decision needs to change, add a superseding ADR first.

## Tech stack

- **Monorepo:** pnpm workspaces + Turborepo. TypeScript everywhere, `strict: true`.
- **API:** Fastify (Node 20 LTS), Zod for all boundaries, OpenAPI generated from Zod.
- **DB:** Postgres 16 with **Row-Level Security** on every tenant table. Drizzle ORM + drizzle-kit migrations. Managed Postgres (Neon or Supabase; region eu-central or af-south when available).
- **Queue / scheduling:** Redis + BullMQ (reminders, follow-ups, retries, outbox delivery).
- **Staff inbox:** Next.js 14 (App Router) + Tailwind + shadcn/ui. Realtime via SSE from the API.
- **AI:** Anthropic API. `claude-haiku` class model for the safety/intent classifier; `claude-sonnet` class model for the main conversation agent with tool use. Model IDs live in `packages/engine/src/models.ts` only.
- **Channels:** WhatsApp Cloud API v20+ (Graph). `Channel` interface abstracts it; SMS/voice slot in later.
- **Payments:** Safaricom Daraja (STK Push, C2B confirmation). `PaymentProvider` interface abstracts it.
- **Auth (staff):** email + magic link / OTP; sessions in httpOnly cookies. Roles: `owner`, `admin`, `staff`, `provider`.
- **Observability:** pino logs → OpenTelemetry; Sentry for errors. **No PHI in logs, spans, or Sentry.**
- **Infra:** Docker; deploy API + workers on Fly.io / Railway (Nairobi-adjacent region), inbox on Vercel. IaC in `infra/`.
- **Testing:** Vitest (unit), Playwright (inbox e2e), Testcontainers (Postgres integration), recorded-fixture tests for Meta and Daraja webhooks. Safety eval suite in `packages/engine/evals/`.

## Repo layout

```
apps/
  api/          Fastify API + webhooks (WhatsApp, Daraja) + SSE
  worker/       BullMQ workers: reminders, follow-ups, outbox sender, nightly jobs
  inbox/        Next.js staff app (shared inbox, calendar, settings, onboarding)
packages/
  db/           Drizzle schema, migrations, RLS policies, seed
  engine/       Conversation engine: classifier, agent, tools, prompts, evals
  channels/     Channel interface + WhatsApp Cloud API adapter
  payments/     PaymentProvider interface + Daraja adapter
  scheduling/   Availability, slot search, booking rules, holds
  shared/       Types, Zod schemas, errors, i18n strings, phone/time utils
docs/           SPEC, ARCHITECTURE, DATA_MODEL, CONVERSATION_ENGINE, SAFETY, COMPLIANCE, INTEGRATIONS, TESTING, BUILD_PLAN, adr/
infra/          Dockerfiles, fly.toml, env templates
```

## Commands

```
pnpm i                    install
pnpm dev                  api + worker + inbox with hot reload (docker compose up -d first for pg+redis)
pnpm db:migrate           apply migrations
pnpm db:seed              seed dev tenant (Afyanex fixture) + demo patients
pnpm test                 all unit + integration tests
pnpm test:evals           conversation engine safety + behaviour evals (needs ANTHROPIC_API_KEY)
pnpm lint / pnpm typecheck
pnpm wa:simulate          send a fake inbound WhatsApp webhook to local api
pnpm mpesa:simulate       send a fake Daraja callback to local api
```

## Conventions

- **Tenancy:** every tenant table has `clinic_id`. Every DB access goes through `withTenant(clinicId, fn)` which sets `app.current_clinic` for RLS. Never bypass with the service role except in explicitly named system jobs.
- **Time:** store UTC `timestamptz`. Clinic has `timezone`; render in clinic tz. Slot math uses the clinic tz via `date-fns-tz`.
- **Money:** integers in minor units (`amount_minor`, `currency`). No floats.
- **Phones:** E.164 in DB. Normalise on ingest (`+2547...`). Never log raw.
- **IDs:** ULIDs (`ulid`), prefixed in APIs (`pat_`, `apt_`, `conv_`).
- **Errors:** typed `AppError` with `code`; never leak internals to WhatsApp replies.
- **Outbound messages:** never call the channel directly from request handlers. Write to `outbox`, worker delivers, retries with backoff, marks `delivered/failed`.
- **Idempotency:** dedup inbound on `wa_message_id`; dedup payment callbacks on `checkout_request_id`; all worker jobs idempotent by job key.
- **AI:** all model calls go through `packages/engine`. Prompts are versioned files under `engine/src/prompts/`. Every tool call is validated with Zod before execution and audited.
- **i18n:** patient-facing strings in `shared/i18n/{en,sw}.json`; agent may reply in English, Swahili or Sheng matching the patient.

## Hard rules

1. **Safety classifier runs on every inbound message before the main model.** Emergency → immediate scripted reply + human escalation. Never bypass.
2. **The agent never gives diagnosis, treatment, dosage, or triage advice.** It books, informs about the clinic, and escalates. See `docs/SAFETY.md`.
3. **A human can take over any conversation at any time**, and the agent stays silent until handed back.
4. **PHI never leaves the tenant boundary**: no PHI in logs, analytics, error tracking, or model training. Model calls use zero-retention API settings.
5. **We do not custody patient money.** No wallet, hold, escrow, or refund logic in our ledger. Refunds are the clinic's action on their M-Pesa.
6. **Webhooks are idempotent and fast**: ack < 3s, do work in the queue.
7. **Every AI action is audited** in `audit_log`: bookings, payment requests, escalations, messages.
8. **RLS on, always.** Migrations adding a tenant table must add the policy in the same migration; a test enforces this.
9. **No new dependency without a one-line justification** in the commit.
10. **Don't disable or skip tests to ship.**

## Out of scope for v1 (do not build until asked)

- SHA / NHIF / insurer claims, billing, RCM (Phase 3)
- Voice or SMS channels (interface only)
- Patient-facing app or login (patients only use WhatsApp)
- EMR / HMIS integrations (Aifya later, via `packages/connectors`)
- Languages beyond English / Swahili / Sheng
- Any custody of funds, lending, subscriptions to patients
- Clinical decision support of any kind

## When stuck

1. Re-read `docs/SPEC.md` and the relevant deep-dive doc.
2. Check the package README.
3. `rg` the codebase before assuming something doesn't exist.
4. Write the assumption in the PR description and proceed.

## Commit style

Conventional Commits, subject < 70 chars, body explains *why*.
`feat(engine): add emergency classifier short-circuit before main model`
