/**
 * Drizzle schema.
 *
 * Deliberately empty in Phase 0. Tables, enums, indexes, exclusion constraints
 * and RLS policies all land together in Phase 1 (docs/BUILD_PLAN.md, and
 * docs/DATA_MODEL.md for the shape).
 *
 * When adding a tenant table here, the migration that creates it MUST also
 * enable RLS and create the `tenant_isolation` policy in the same migration —
 * CLAUDE.md hard rule 8, enforced by a test in Phase 1.
 */

export {};
