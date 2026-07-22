/**
 * Feed-filter persistence — pure logic (Phase 4, decision #6), the mobile mirror of web's
 * `lib/feedFilters`. Device storage is the working copy; `profiles.feedFilterPrefs` is the durable
 * server-sync copy; reconciliation is last-write-wins. Everything runs through `@skating/core`
 * `sanitizeFeedFilters` so a corrupt blob / stale server shape can't crash the feed. The `expo-sqlite`
 * glue that reads/writes the working copy lives in `feedFiltersStore.ts` — kept out of THIS module so
 * it stays unit-testable (vitest can't parse the native `expo-sqlite` import). Same split as
 * `reportCacheModel` ↔ `reportCache`.
 */

import { type FeedFilters, sanitizeFeedFilters } from '@skating/core';

/** Versioned key so a future filter-shape change can't collide with an old cached blob. */
export const FEED_FILTERS_KEY = 'feedFilters.v1';

/** Parse + sanitize a stored JSON blob into clean filters. Returns `{}` on absence or corruption. */
export function parseFilters(raw: string | null | undefined): FeedFilters {
  if (!raw) return {};
  try {
    return sanitizeFeedFilters(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * Reconcile the local working copy against the server copy (LWW). A non-empty local copy is what the
 * user last set on this device, so it wins; an empty local copy adopts the (sanitized) server copy —
 * the cross-device sync path on a fresh device.
 */
export function reconcileFilters(local: FeedFilters, server: unknown): FeedFilters {
  return Object.keys(local).length > 0 ? local : sanitizeFeedFilters(server);
}

/** How many filters are active — drives the "Filters (2)" affordance + clear button visibility. */
export function activeFilterCount(filters: FeedFilters): number {
  let count = 0;
  if (filters.radiusMinutes !== undefined) count++;
  if (filters.qualityFloor !== undefined) count++;
  if (filters.thicknessFloorCm !== undefined) count++;
  if (filters.noSnow) count++;
  if (filters.iceTypes && filters.iceTypes.length > 0) count++;
  if (filters.surfaceTags && filters.surfaceTags.length > 0) count++;
  if (filters.recencyHours !== undefined) count++;
  return count;
}
