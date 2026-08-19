# `@sema/scheduling`

Availability, slot search, holds and booking rules. `docs/ARCHITECTURE.md` §4
is the specification; this package is its implementation.

Nothing here talks to a patient, a model or a payment provider. It answers four
questions and records the answers: _when is this clinic free_, _can I reserve
this slot_, _turn that reservation into an appointment_, and _what does the
clinic's policy say about moving or cancelling it_.

## Layout

```
src/calendar.ts      DateKey arithmetic — calendar days, never milliseconds
src/availability.ts  availability_rule → concrete UTC windows (pure)
src/slots.ts         windows + busy → bookable slots (pure)
src/ranking.ts       soonest, then preference, then load balance (pure)
src/policy.ts        cancellation / reschedule windows against a Clock (pure)
src/repository.ts    every SQL statement the package issues
src/context.ts       the read shared by searchSlots and holdSlot
src/search.ts        searchSlots
src/holds.ts         holdSlot, expireHolds
src/booking.ts       book, reschedule, cancel
src/scheduler.ts     createScheduler(deps) — the public surface
test/                integration tests; need a real Postgres
```

The first five files have no I/O at all, which is why the slot maths, the
timezone handling and the policy are unit-tested without Docker.

## Usage

```ts
import { createScheduler } from "@sema/scheduling";
import { withTenantDb } from "@sema/db";
import { systemClock } from "@sema/shared";

const scheduler = createScheduler({ withTenantDb, clock: systemClock });

const { slots } = await scheduler.searchSlots({ clinicId, serviceId, from, to, limit: 3 });
const held = await scheduler.holdSlot({ clinicId, providerId, serviceId, start, patientId });
const { appointment } = await scheduler.book({ clinicId, holdId: held.holdId, patientId });
```

Every function takes a `clinicId` and runs inside `withTenantDb`, so RLS is in
force. **No function in this package reads across tenants** — the hold-expiry
worker job supplies the clinic list itself (ARCHITECTURE.md §3).

## Two decisions the spec left open

**1. The stored range is the _occupied block_, not the appointment.**
`slot_hold.slot` and `appointment.slot` are `[start, start + duration_min +
buffer_min)`. The patient-visible end is `start + duration_min`, which every
result object exposes separately as `end` (`blockEnd` is the stored one).

Putting the turnaround buffer inside the range means the Postgres exclusion
constraint — not application code — protects it. The alternative, storing only
the appointment and filtering the buffer in JavaScript, would let two
concurrent writers book into each other's turnaround time, which is exactly the
race the constraint exists to remove.

A slot is offered when the _appointment_ fits inside the working window; the
buffer may run past closing, because it is cleanup, not care.

**2. `providerId` filters, it does not merely rank.** A patient who asks for a
named doctor is not offered a different one. The preference tiebreak in
`ranking.ts` still exists and matters when a `providerId` is passed alongside
slots that came from several providers.

## Holds and expiry

Holds live for `HOLD_TTL_MINUTES` (10). `expires_at` is computed by Postgres,
and every comparison against it uses `now()` — an app container with a skewed
clock must not be able to resurrect an expired hold.

`DATA_MODEL.md` sketches the exclusion constraint as
`exclude using gist (…) where (expires_at > now())`. Postgres rejects that
predicate (an index predicate must be `IMMUTABLE`; `now()` is `STABLE`), so the
constraint is unconditional and expiry is a delete. Two consequences:

- `holdSlot()` deletes that provider's expired holds **inside the same
  transaction** as the insert. This is what makes expiry invisible to callers,
  and it is not optional.
- `expireHolds()` (and the `hold.expiry` worker job) is pure housekeeping.
  Slot search already ignores expired holds; the sweep only keeps the table
  small, so a missed run is not an incident.

## Errors

Typed `AppError` codes, never a driver error:

| code                | when                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `SLOT_UNAVAILABLE`  | the slot is real but taken: an appointment, a live hold or time off covers it, or the constraint rejected the write |
| `HOLD_EXPIRED`      | the hold is gone or past its TTL                                                                                    |
| `VALIDATION_FAILED` | malformed id, unbookable service, or a time this clinic would never offer (off-grid, closed, too soon, too far out) |
| `CONFLICT`          | the appointment is in a status that can no longer be changed                                                        |
| `NOT_FOUND`         | the clinic, service or appointment is not visible in this tenant                                                    |

The first and third rows carry the load-bearing distinction.
`SLOT_UNAVAILABLE` means "that time has gone, offer another", which the agent
can recover from; `VALIDATION_FAILED` means the request itself was wrong and
retrying will not help.

**Every way of losing a race reports `SLOT_UNAVAILABLE`** — whether the
competing transaction had already committed by the time `holdSlot` re-derived
the day, or landed between that read and the insert. `resolveOfferedSlot`
keeps the two apart by generating candidate slots with _no_ occupancy first,
so only the clinic's own rules can produce a validation error, and then asking
separately whether the slot is free.

## Money

`book()` sets `status = 'pending_deposit'` and `deposit_required_minor` when the
service has a deposit; `cancel()` and `reschedule()` record whether the deposit
is forfeited. **Nothing here moves money** — Sema is non-custodial (ADR-003,
CLAUDE.md hard rule 5) and payments are Phase 6.

## Tests

```
pnpm test                 unit — slot maths, timezones/DST, policy, ranking, property test
pnpm test:integration     needs Postgres; skips cleanly without one
```

The integration suites reuse `packages/db/test/support/postgres.ts` (one
harness, one migrated database) and run every statement as the unprivileged
`sema_rls_probe` role, because **superusers bypass RLS** and the CI database
user is one.
