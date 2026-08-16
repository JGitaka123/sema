# Sema — Build Plan (Claude Code phases)

Each phase is one or more Claude Code sessions. Start every session with: "Read CLAUDE.md, docs/SPEC.md and the docs named below. Then implement Phase X. Do not build anything from later phases."

Definition of done for every phase: tests pass, `pnpm typecheck` clean, docs updated, PR description lists assumptions.

---

## Phase 0 — Repo bootstrap (Session 1)
Read: CLAUDE.md, ARCHITECTURE.md.
- pnpm + Turborepo monorepo, TS strict, ESLint/Prettier, Vitest, Husky pre-commit (lint+typecheck).
- `apps/api` Fastify skeleton with health route, pino, Zod, OpenAPI plugin. `apps/worker` BullMQ skeleton. `apps/inbox` Next.js + Tailwind + shadcn.
- `packages/shared` (ids, errors, phone/money/time utils, i18n loader), `packages/db` (Drizzle config, `withTenant`, docker compose pg16 with btree_gist + citext, redis).
- CI (GitHub Actions): install, lint, typecheck, test.
- `infra/` Dockerfiles, `.env.example`.
Acceptance: `pnpm dev` runs all three apps; `/health` OK.

## Phase 1 — Data model + RLS + seed (Session 2)
Read: DATA_MODEL.md, COMPLIANCE.md.
- All tables, enums, indexes, exclusion constraints, RLS policies. Migration.
- `rls.test.ts` cross-tenant isolation + policy presence.
- Seed: Afyanex fixture (providers, services with intake questions and deposits, hours, knowledge, 3 staff), 20 demo patients.
Acceptance: seed + RLS tests green.

## Phase 2 — Scheduling engine (Session 3)
Read: ARCHITECTURE.md §4.
- `packages/scheduling`: `searchSlots`, `holdSlot`, `book`, `reschedule`, `cancel`, policy evaluation (`cancellation_policy`), tz handling, hold expiry job.
- Concurrency test: two holds same slot → one wins.
Acceptance: unit + integration tests; property test on no-overlap.

## Phase 3 — WhatsApp channel + webhooks + outbox (Session 4)
Read: INTEGRATIONS.md §1, ARCHITECTURE.md §2, §6.
- `packages/channels` interface + WhatsApp adapter (text, interactive, template, location, media download, mark read).
- `POST /webhooks/whatsapp` verify + dedup + enqueue; status webhook handling.
- Outbox table + worker with retry/backoff/dead-letter and 24h-window template fallback.
- `pnpm wa:simulate`.
Acceptance: simulated inbound creates patient/conversation/message; simulated outbound hits mocked Graph API; fixture tests pass.

## Phase 4 — Engine: classifier + safety + scripted routes (Session 5)
Read: CONVERSATION_ENGINE.md §1–2, SAFETY.md, COMPLIANCE.md §2.
- `packages/engine`: model registry, classifier with structured output, emergency lexicon EN/SW, router, scripted replies (i18n), escalation creation + notifications, abuse muting.
- Evals scaffold + `emergency.jsonl` (≥ 200), `advice_refusal.jsonl` seed (≥ 50 to start).
Acceptance: emergency recall 1.0 on eval; classifier p95 < 400ms with cache.

## Phase 5 — Engine: agent + tools + guardrails (Sessions 6–7)
Read: CONVERSATION_ENGINE.md §3–4, §8–10.
- Agent loop with tool use, all tools with Zod + audit + tenant scope, context builder, post-check guardrails, summaries, prompt versioning.
- Evals: `grounding.jsonl`, `booking_flows.jsonl`, `language.jsonl`; expand advice suite to ≥ 150.
Acceptance: booking flow end-to-end via simulate (hold → book → confirmation message); 0 grounding violations.

## Phase 6 — Payments (Session 8)
Read: INTEGRATIONS.md §2, ARCHITECTURE.md §5, SPEC.md §3, §4.3.
- `packages/payments` interface + Daraja adapter (token cache, STK push, callback parse, query), encrypted per-tenant creds, `payment_request` state machine, reconciler, `mpesa:simulate`.
- Wire `request_deposit` tool + `pending_deposit` → `confirmed` transitions + hold expiry on failure.
Acceptance: fixture tests for all result codes; end-to-end deposit in sandbox.

## Phase 7 — Reminders, no-show, digests (Session 9)
- Reminder scheduling on book/reschedule/cancel, template sends, confirm/reschedule replies handled by agent, no-show marking + rebook nudge, owner weekly digest, staff morning digest per provider.
Acceptance: time-travel tests using fake clock.

## Phase 8 — Staff inbox (Sessions 10–12)
Read: SPEC.md §4.6–4.9.
- Auth (magic link/OTP), roles. Inbox views, conversation pane, patient card, takeover/handback, quick actions, SSE realtime, escalation alerts with sound, mobile-first layout.
- Calendar (day/week per provider, drag reschedule, walk-in, block).
- Settings: hours, providers, services (+ intake, deposit), policies, knowledge editor, templates status, staff mgmt, notifications.
- Reports page.
Acceptance: Playwright e2e for takeover, book from inbox, deposit request, knowledge edit reflected in agent.

## Phase 9 — Onboarding + WhatsApp Embedded Signup + M-Pesa connect (Session 13)
- Wizard per SPEC §4.9; Embedded Signup flow; template registration; Daraja credential form + test push; sandbox chat; go-live checklist; DPA acceptance + consent copy.
Acceptance: new clinic live in < 60 min on staging.

## Phase 10 — Compliance + hardening + observability (Session 14)
- Data export/erasure tools, retention jobs, PHI-free logging tests, Sentry scrubbing, OpenTelemetry, rate limits, backups verified, k6 load test, security checklist, runbooks (breach, daraja-golive, meta-quality-drop, outbox-dead-letter).
Acceptance: load targets met; checklist signed.

## Phase 11 — Afyanex go-live (Week 6)
- Real number connected, staff trained (30-min session), 50-conversation review, metrics baseline captured (no-show %, missed messages) for the before/after case study.

---

## Session opener template
```
Read CLAUDE.md, docs/SPEC.md, docs/BUILD_PLAN.md and [docs for this phase].
We are in Phase N. Summarise the acceptance criteria back to me, list files you will create/change, then implement.
Constraints: follow Hard rules in CLAUDE.md; write tests alongside code; update docs if behaviour differs; do not touch later-phase scope.
When done: run pnpm typecheck && pnpm test, and give me a PR-style summary with assumptions.
```
