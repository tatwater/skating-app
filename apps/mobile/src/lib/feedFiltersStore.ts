/**
 * Device-local feed-filter storage (Phase 4, decision #6) — the `expo-sqlite` glue behind the pure
 * logic in `feedFilters.ts`. A tiny key-value table (`prefsDb`, shared with the theme preference)
 * holds the working copy (the UI reads it first → instant, offline-safe); the pure `feedFilters`
 * module handles parse/reconcile. Best-effort native (like `bodyCache`): a storage failure never
 * blocks the feed.
 */

import type { FeedFilters } from '@skating/core';
import { FEED_FILTERS_KEY, parseFilters } from './feedFilters';
import { readPref, writePref } from './prefsDb';

/** Read the device-local working copy (sanitized). Empty on any sqlite error. */
export function loadStoredFilters(): FeedFilters {
  try {
    return parseFilters(readPref(FEED_FILTERS_KEY));
  } catch {
    return {};
  }
}

/** Persist the working copy locally. Best-effort — a write failure never blocks the session. */
export function saveStoredFilters(filters: FeedFilters): void {
  try {
    writePref(FEED_FILTERS_KEY, JSON.stringify(filters));
  } catch {
    // Best-effort — the in-memory copy still drives this session.
  }
}
