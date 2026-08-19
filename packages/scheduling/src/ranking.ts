import type { ProviderId, Slot } from "./types.js";

/**
 * Slot ranking (ARCHITECTURE.md §4: "soonest, then provider preference, then
 * load balance").
 *
 * Pure and total: the comparator falls all the way through to `providerId`, so
 * the same inputs always produce the same order. A patient who asks twice must
 * be offered the same three times.
 */

export interface RankingInput {
  readonly slots: readonly Slot[];
  /** The provider the patient asked for, if any. */
  readonly preferredProviderId?: ProviderId | null;
  /**
   * Occupied appointments per provider inside the search range. Used only as a
   * tiebreak between providers free at the same instant, so a clinic's second
   * doctor actually gets offered instead of the first one filling up.
   */
  readonly loadByProvider?: Readonly<Record<string, number>>;
}

export function rankSlots(input: RankingInput): Slot[] {
  const { preferredProviderId, loadByProvider = {} } = input;
  const load = (id: ProviderId): number => loadByProvider[id] ?? 0;
  const preferenceRank = (id: ProviderId): number =>
    preferredProviderId && id === preferredProviderId ? 0 : 1;

  return [...input.slots].sort((a, b) => {
    const byStart = a.start.getTime() - b.start.getTime();
    if (byStart !== 0) return byStart;

    const byPreference = preferenceRank(a.providerId) - preferenceRank(b.providerId);
    if (byPreference !== 0) return byPreference;

    const byLoad = load(a.providerId) - load(b.providerId);
    if (byLoad !== 0) return byLoad;

    return a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0;
  });
}
