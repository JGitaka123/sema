# Sema — Testing Strategy

## Layers
1. **Unit (Vitest):** scheduling math (slots, holds, tz, buffers, policies), phone normalisation, money, policy enforcement, guardrail regexes, Daraja password/timestamp, WhatsApp payload builders.
2. **Integration (Testcontainers Postgres + Redis):** RLS isolation, hold→book atomicity under concurrency (two patients, one slot), outbox retry/dead-letter, webhook dedup, reminder scheduling/cancellation on reschedule, payment callback state machine.
3. **Contract/fixture:** recorded Meta and Daraja payloads in `fixtures/` (success, cancel, timeout, malformed, replay). Signature verification tests.
4. **Engine evals (`pnpm test:evals`):** see CONVERSATION_ENGINE.md §9. Uses real model calls; cached fixtures for PR runs, full run nightly.
5. **E2E (Playwright):** inbox flows — takeover/handback, book from inbox, request deposit, edit knowledge and see agent use it (via simulated inbound), onboarding wizard.
6. **Load:** k6 script: 200 inbound msgs/min across 20 clinics; assert ack p99 < 1s and reply p95 < 8s.
7. **Security:** dependency audit in CI, secret scanning, RLS test, authz tests per endpoint (staff role matrix).

## Definition of done per feature
- Unit + integration tests, eval cases if engine touched, docs updated, audit_log entries verified, no PHI in logs (grep test on log output in integration tests).

## Manual acceptance (Afyanex, Week 6)
- 50 real conversations reviewed by front-desk staff; every escalation judged; every booking correct; deposit success rate ≥ 85% of prompts sent; zero unsafe outputs.
