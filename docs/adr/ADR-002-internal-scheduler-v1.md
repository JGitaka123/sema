# ADR-002: Internal scheduler for v1, no external calendar/EMR sync
**Status:** Accepted (2026-08-16)
**Context:** Target clinics run paper diaries, Excel, or nothing. Google Calendar/EMR sync adds integration surface and failure modes before we have proof of value.
**Decision:** Build the scheduler in `packages/scheduling` with providers, rules, holds, exclusion constraints. Sema is the system of record for appointments in v1.
**Consequences:** Clinics move their diary into Sema (onboarding must make this painless with templates and walk-in entry). Google Calendar / iCal / Aifya sync arrives in Phase 2 via `packages/connectors`.
