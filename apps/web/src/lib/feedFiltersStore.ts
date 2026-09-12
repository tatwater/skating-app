/**
 * The one filter row, shared by the feed and the map (N6h / **D166**).
 *
 * Phase 4 kept the row's working copy inside the feed page's own hook, which was fine while the feed
 * was its only reader. Weather-first discovery makes the map a second reader — narrow on the feed,
 * switch to the map, and the same dozen lakes are what is drawn — so the working copy moves out of
 * the page into a module store both subscribe to through `useSyncExternalStore`. Persistence is
 * unchanged: local storage is the working copy, `profiles.feedFilterPrefs` the durable one, and the
 * one-time LWW reconcile happens once per session rather than once per page mount.
 */

import { api } from '@skating/convex/api';
import type { FeedFilters } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { readStoredFilters, reconcileFilters, writeStoredFilters } from './feedFilters';

let current: FeedFilters = {};
let loadedLocal = false;
let reconciled = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EMPTY: FeedFilters = {};
const getSnapshot = () => current;
// SSR has no local storage; the server renders "show everything" and the client corrects on mount.
const getServerSnapshot = () => EMPTY;

/** Replace the working copy and notify every subscriber. Persists locally; the hook syncs the server. */
function setLocal(next: FeedFilters) {
  current = next;
  writeStoredFilters(window.localStorage, next);
  emit();
}

/** Test seam: forget the session's loaded/reconciled state. */
export function resetFeedFiltersStoreForTests() {
  current = {};
  loadedLocal = false;
  reconciled = false;
}

/**
 * The shared filter row and its setter. Any number of components may call this; the first mount of
 * the session loads the local copy, the first profile arrival reconciles it, and every `set` writes
 * local immediately and syncs the server copy best-effort.
 */
export function useFeedFilters(): { value: FeedFilters; set: (next: FeedFilters) => void } {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const profile = useQuery(api.profiles.current, {});
  const setServer = useMutation(api.profiles.setFeedFilterPrefs);

  // Load the local working copy once per session (client-only).
  useEffect(() => {
    if (loadedLocal) return;
    loadedLocal = true;
    current = readStoredFilters(window.localStorage);
    emit();
  }, []);

  // Reconcile against the server copy once the profile arrives (LWW), a single time per session.
  useEffect(() => {
    if (reconciled || profile === undefined) return;
    reconciled = true;
    const merged = reconcileFilters(
      readStoredFilters(window.localStorage),
      profile?.feedFilterPrefs,
    );
    setLocal(merged);
  }, [profile]);

  const set = useCallback(
    (next: FeedFilters) => {
      setLocal(next);
      // Best-effort server sync; the local copy already drives this session.
      if (profile) void setServer({ filters: next });
    },
    [profile, setServer],
  );

  return { value, set };
}
