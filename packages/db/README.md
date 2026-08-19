# `@sema/db`

Drizzle schema, migrations, RLS policies, tenant access and the Afyanex dev seed.
`docs/DATA_MODEL.md` is the authority for shape; this package is its
implementation.

## Layout

```
src/schema/      one file per domain, re-exported by schema/index.ts
src/with-tenant  the tenant transaction (Phase 0)
src/tenant-db    the same transaction, with Drizzle instead of raw SQL
src/migrate.ts   applies drizzle/*.sql — the only migration runner
src/seed/        Afyanex fixture, deterministic ids, idempotent upserts
drizzle/         generated + hand-edited migration SQL
test/            integration tests; need a real Postgres
```

## Commands

```
pnpm db:generate     regenerate migration SQL from the schema
pnpm db:migrate      apply migrations (DATABASE_MIGRATION_URL ?? DATABASE_URL)
pnpm db:seed         seed the Afyanex fixture (safe to re-run)
pnpm test            unit tests — no database needed
pnpm test:integration  RLS + constraint tests — needs Postgres
```

`docker compose up -d postgres` gives you a local Postgres 16 on
`postgres://sema:sema@localhost:5432/sema`, which the integration tests find by
themselves when `DATABASE_URL` is unset. With no database reachable they skip
with a message instead of failing.

## Migrations

`drizzle-kit generate` writes the tables, enums, indexes and foreign keys.
Three things it cannot express are hand-written in the same file, each under a
numbered banner comment:

1. `CREATE EXTENSION` for `btree_gist`, `citext` and `pgcrypto` — they must
   exist before the tables that use them, so they sit at the top.
2. The `EXCLUDE USING gist` constraints on `slot_hold` and `appointment`.
3. `ENABLE`/`FORCE ROW LEVEL SECURITY` and the `tenant_isolation` policies.

Keep those sections when regenerating. `src/schema/rls-coverage.test.ts` runs in
the ordinary unit suite and fails if a tenant table ever loses its policy, its
timestamps or its `clinic_id` — hard rule 8 without needing Docker.

Note on `slot_hold`: `DATA_MODEL.md` sketches the exclusion constraint as
`where (expires_at > now())`. Postgres rejects that, because an index predicate
must be `IMMUTABLE` and `now()` is `STABLE`. The constraint is therefore
unconditional, and expiry is a delete: the hold-expiry job removes expired rows
and `holdSlot()` (Phase 2) deletes the provider's expired holds inside the same
transaction before inserting. The observable behaviour is the documented one.

## Row level security

Every table with `clinic_id` — plus `clinic`, which isolates on its own `id` —
has:

```sql
alter table X enable row level security;
alter table X force row level security;
create policy tenant_isolation on X
  using (clinic_id = current_setting('app.current_clinic', true))
  with check (clinic_id = current_setting('app.current_clinic', true));
```

`current_setting(…, true)` returns NULL when the setting is missing, so a
connection that skipped `withTenant` sees nothing rather than everything.
`FORCE` extends the policy to the table owner.

`webhook_dedup` is the single table without a policy: the webhook handler
dedups before it knows which clinic a payload belongs to, and the table holds
only opaque Meta/Daraja ids. The integration test asserts it is the _only_
exception.

### Roles (environment setup, not migrations)

Roles are cluster-level, and managed Postgres providers differ on what a
migration may do to them, so migrations create none. Set them up once per
environment:

```sql
-- the role the API and workers connect as: no superuser, no BYPASSRLS
create role sema_app login password '…';
grant usage on schema public to sema_app;
grant select, insert, update, delete on all tables in schema public to sema_app;
alter default privileges in schema public
  grant select, insert, update, delete on tables to sema_app;

-- the role migrations run as; owns the schema
create role sema_system login password '…';
```

**Superusers bypass RLS**, forced or not. `DATABASE_URL` in any environment that
holds real patient data must point at `sema_app`, never at the owner or a
superuser. The integration tests make this concrete: they `set local role` to an
unprivileged probe role before asserting isolation, because as the CI superuser
every policy would appear to pass.

## Conventions

- ids are prefixed ULIDs stored whole (`pat_01J…`), `text` columns
- money is `bigint` minor units + `char(3)` currency, never floats
- time is `timestamptz` UTC; `availability_rule` alone stores clinic-local
  wall-clock `time`, because "Tuesdays 09:00" is the rule, not an instant
- phones are E.164 and are never logged raw — use `maskPhone` from
  `@sema/shared`
