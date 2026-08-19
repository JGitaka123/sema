# Sema

Sema is an AI front-desk for clinics. It talks to patients on WhatsApp — answering questions,
booking, rescheduling and cancelling appointments, sending reminders and collecting deposits via
M-Pesa — while clinic staff supervise from a shared inbox and can take over any conversation at any
time. It is multi-tenant and multi-region from day one, launching in Kenya with Afyanex as the
founding design partner. Sema is a receptionist, not a clinician: it never diagnoses, advises on
treatment or triages, and it escalates to a human whenever a conversation needs one.

> **Working name.** "Sema" is Swahili for "speak". Trademark and domain are unconfirmed — see
> `CLAUDE.md` before using the name publicly.

## Status

Phase 1 (data model) of the plan in [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md). The monorepo,
toolchain, CI, the shared utility layer and the full Postgres schema — tables, enums, indexes,
overlap constraints, row level security and the Afyanex dev seed — exist. The conversation engine,
WhatsApp channel and payments do not yet.

## Stack

| Area          | Choice                                                                         |
| ------------- | ------------------------------------------------------------------------------ |
| Monorepo      | pnpm workspaces + Turborepo, TypeScript `strict` everywhere                    |
| API           | Fastify (Node 20 LTS), Zod at every boundary, OpenAPI generated from Zod       |
| Database      | Postgres 16 with Row-Level Security on every tenant table, Drizzle ORM         |
| Queue         | Redis + BullMQ (reminders, follow-ups, retries, outbox delivery)               |
| Staff inbox   | Next.js 14 App Router, Tailwind, shadcn/ui, realtime over SSE                  |
| AI            | Anthropic API — Haiku-class safety/intent classifier, Sonnet-class agent       |
| Channel       | WhatsApp Cloud API v20+, behind a `Channel` interface                          |
| Payments      | Safaricom Daraja STK Push, behind a `PaymentProvider` interface, non-custodial |
| Observability | pino → OpenTelemetry, Sentry. No PHI in logs, spans or error tracking.         |
| Testing       | Vitest, Playwright (inbox e2e), Testcontainers, engine safety evals            |

## Repo layout

```
apps/
  api/        Fastify API + webhooks (WhatsApp, Daraja) + SSE
  worker/     BullMQ workers: reminders, follow-ups, outbox sender, nightly jobs
  inbox/      Next.js staff app (shared inbox, calendar, settings, onboarding)
packages/
  db/         Drizzle schema, migrations, RLS policies, withTenant, seed
  shared/     Ids, errors, phone/money/time utils, i18n catalogues
  engine/     Conversation engine: classifier, agent, tools, prompts, evals   (Phase 4)
  channels/   Channel interface + WhatsApp Cloud API adapter                  (Phase 3)
  payments/   PaymentProvider interface + Daraja adapter                      (Phase 6)
  scheduling/ Availability, slot search, booking rules, holds                 (Phase 2)
docs/         SPEC, ARCHITECTURE, DATA_MODEL, CONVERSATION_ENGINE, SAFETY,
              COMPLIANCE, INTEGRATIONS, TESTING, BUILD_PLAN, adr/
infra/        Dockerfiles, Postgres init scripts, deployment config
```

## Getting started

Requirements: Node >= 20, pnpm 9, Docker (for Postgres and Redis).

```bash
cp .env.example .env      # fill in placeholders; never commit .env
docker compose up -d      # postgres:16 (btree_gist, citext, pgcrypto) + redis:7
pnpm install
pnpm dev                  # api :3001, inbox :3000, worker
```

Check the API is up:

```bash
curl http://localhost:3001/health     # {"status":"ok"}
open http://localhost:3001/docs       # OpenAPI UI, generated from the Zod schemas
```

Nothing in `pnpm install`, `pnpm lint`, `pnpm typecheck` or `pnpm test` requires Docker, Postgres,
Redis or an API key — those are pure unit tests. `pnpm dev`, `pnpm db:migrate`, `pnpm db:seed` and
`pnpm test:integration` do need Postgres; the integration suite skips with a message when none is
reachable.

## Commands

| Command                 | What it does                                                    |
| ----------------------- | --------------------------------------------------------------- |
| `pnpm dev`              | api + worker + inbox with hot reload                            |
| `pnpm build`            | build every package in dependency order                         |
| `pnpm lint`             | ESLint across the workspace                                     |
| `pnpm typecheck`        | `tsc --noEmit` across the workspace                             |
| `pnpm test`             | unit tests — no Docker, Postgres or API key needed              |
| `pnpm test:integration` | migrations, RLS and constraint tests against real Postgres      |
| `pnpm test:evals`       | conversation engine safety + behaviour evals — Phase 4          |
| `pnpm db:generate`      | regenerate migration SQL from the Drizzle schema                |
| `pnpm db:migrate`       | apply migrations                                                |
| `pnpm db:seed`          | seed the Afyanex dev tenant + demo patients (safe to re-run)    |
| `pnpm wa:simulate`      | send a fake inbound WhatsApp webhook to the local API — Phase 3 |
| `pnpm mpesa:simulate`   | send a fake Daraja callback to the local API — Phase 6          |

A Husky pre-commit hook runs `pnpm lint && pnpm typecheck`. CI runs lint, typecheck, test and build
on every pull request and on pushes to `main`.

## Docs

Read these before making non-trivial changes.

- [`CLAUDE.md`](CLAUDE.md) — project memory: locked decisions, conventions, hard rules.
- [`docs/SPEC.md`](docs/SPEC.md) — product source of truth.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design, tenancy, request lifecycle.
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — tables, relationships, RLS shape.
- [`docs/CONVERSATION_ENGINE.md`](docs/CONVERSATION_ENGINE.md) — classifier, agent, guardrails.
- [`docs/SAFETY.md`](docs/SAFETY.md) — **binding.** What the agent may and may not say.
- [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) — **binding.** Kenyan DPA, PHI handling, retention.
- [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) — WhatsApp Cloud API and Daraja specifics.
- [`docs/TESTING.md`](docs/TESTING.md) — what to test and how.
- [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) — the eleven phases, in order.
- [`docs/adr/`](docs/adr/) — the five locked architectural decisions.

## Non-negotiables

This is a healthcare product. Patient safety and data protection are constraints, not features.

1. The safety classifier runs on **every** inbound message before the main model. Never bypass it.
2. The agent never gives diagnosis, treatment, dosage or triage advice.
3. A human can take over any conversation at any time; the agent then stays silent.
4. PHI never leaves the tenant boundary — not into logs, analytics, error tracking or training.
5. Sema never custodies patient money. Deposits land in the clinic's own M-Pesa account.
6. RLS is on for every tenant table, always.

The full list is in [`CLAUDE.md`](CLAUDE.md).
