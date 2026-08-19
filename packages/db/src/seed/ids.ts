import { ID_PREFIXES, type IdEntity, type PrefixedId } from "@sema/shared";

/**
 * Deterministic ids for seeded rows.
 *
 * `pnpm db:seed` must be safe to re-run (BUILD_PLAN Phase 1), which means every
 * row needs a stable primary key to upsert on. Random ULIDs would create a
 * second Afyanex on every run.
 *
 * The body is still a syntactically valid ULID — 26 characters of Crockford
 * base32 — so `isId()` and every downstream parser treat seeded ids exactly
 * like real ones. It is *recognisably* fake (`0SEED…`), which is what you want
 * when you find one in a staging log.
 */

const ULID_LENGTH = 26;
const SEED_MARKER = "0SEED";

/** Crockford base32 excludes I, L, O and U to avoid transcription mistakes. */
const SUBSTITUTIONS: Record<string, string> = { I: "1", L: "1", O: "0", U: "V" };

function toUlidBody(key: string): string {
  const cleaned = key
    .toUpperCase()
    .split("")
    .map((char) => {
      if (SUBSTITUTIONS[char]) return SUBSTITUTIONS[char];
      return /[0-9A-HJKMNP-TV-Z]/.test(char) ? char : "0";
    })
    .join("");

  return `${SEED_MARKER}${cleaned}`.slice(0, ULID_LENGTH).padEnd(ULID_LENGTH, "0");
}

/** `seedId("patient", "p01")` → `pat_0SEEDP01000000000000000000` */
export function seedId<E extends IdEntity>(entity: E, key: string): PrefixedId<E> {
  return `${ID_PREFIXES[entity]}_${toUlidBody(key)}` as PrefixedId<E>;
}

/** True for an id this module produced. Used by the seed's cleanup guards. */
export function isSeedId(value: string): boolean {
  const body = value.slice(value.indexOf("_") + 1);
  return body.startsWith(SEED_MARKER) && body.length === ULID_LENGTH;
}
