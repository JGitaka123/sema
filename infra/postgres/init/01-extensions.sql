-- Extensions Sema depends on. Runs once when the postgres volume is empty.
--
-- btree_gist : required by packages/scheduling for the exclusion constraint on
--              (provider_id, tstzrange) that prevents overlapping slot holds
--              and appointments (ARCHITECTURE.md §4).
-- citext     : case-insensitive email / handle columns for staff accounts, so
--              login is not case sensitive (DATA_MODEL.md).
-- pgcrypto   : gen_random_bytes for per-tenant DEK generation (ARCHITECTURE.md §9).

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
