/**
 * Feed-filter persistence (Phase 4, decision #6) — local-first with a `profiles.feedFilterPrefs`
 * server-sync copy. Local storage is the **working copy** (the UI always reads it → instant,
 * offline-safe); the server blob is the durable/cross-device copy. Reconciliation is last-write-wins:
 * a non-empty local copy wins (it's what the user last touched here); an empty local copy adopts the
 * server copy (first load on a new device). Everything is funneled through `@skating/core`
 * `sanitizeFeedFilters`, so a corrupt localStorage blob or a stale server shape can never crash the feed.
 */

import { type FeedFilters, sanitizeFeedFilters } from '@skating/core';

/** Versioned key so a future filter-shape change can't collide with an old cached blob. */
export const FEED_FILTERS_STORAGE_KEY = 'skating.feedFilters.v1';

/** Read + sanitize the local working copy. Returns `{}` (show everything) on absence or corruption. */
export function readStoredFilters(storage: Pick<Storage, 'getItem'>): FeedFilters {
  try {
    const raw = storage.getItem(FEED_FILTERS_STORAGE_KEY);
    return raw ? sanitizeFeedFilters(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/** Persist the working copy locally. Swallows storage errors (private mode / quota) — non-fatal. */
export function writeStoredFilters(storage: Pick<Storage, 'setItem'>, filters: FeedFilters): void {
  try {
    storage.setItem(FEED_FILTERS_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // Persistence is best-effort; the in-memory copy still drives this session.
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
