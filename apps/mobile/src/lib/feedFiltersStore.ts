/**
 * Device-local feed-filter storage (Phase 4, decision #6) — the `expo-sqlite` glue behind the pure
 * logic in `feedFilters.ts`. A tiny key-value table (`prefsDb`, shared with the theme preference)
 * holds the working copy (the UI reads it first → instant, offline-safe); the pure `feedFilters`
 * module handles parse/reconcile. Best-effort native (like `bodyCache`): a storage failure never
 * blocks the feed.
 *
 * **Since N6h (D166) this is also the in-memory store both the feed and the map subscribe to**,
 * through `useFeedFilters`. Phase 4 kept the working copy in the feed screen's own state; weather
 * discovery makes the map a second reader, and two copies of one row is how the map draws one set
 * of lakes while the feed lists another.
 */

import { api } from '@skating/convex/api';
import type { FeedFilters } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { FEED_FILTERS_KEY, parseFilters, reconcileFilters } from './feedFilters';
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

let current: FeedFilters | null = null;
let reconciled = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): FeedFilters {
  if (current === null) current = loadStoredFilters();
  return current;
}

function setLocal(next: FeedFilters) {
  current = next;
  saveStoredFilters(next);
  emit();
}

/**
 * The shared filter row and its setter. The first read of the session loads the device copy; the
 * first profile arrival reconciles it (LWW), once; every `set` writes the device copy immediately
 * and syncs the server copy best-effort.
 */
export function useFeedFilters(): { value: FeedFilters; set: (next: FeedFilters) => void } {
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const profile = useQuery(api.profiles.current, {});
  const setServer = useMutation(api.profiles.setFeedFilterPrefs);

  useEffect(() => {
    if (reconciled || profile === undefined) return;
    reconciled = true;
    setLocal(reconcileFilters(loadStoredFilters(), profile?.feedFilterPrefs));
  }, [profile]);

  const set = useCallback(
    (next: FeedFilters) => {
      setLocal(next);
      if (profile) void setServer({ filters: next });
    },
    [profile, setServer],
  );

  return { value, set };
}
