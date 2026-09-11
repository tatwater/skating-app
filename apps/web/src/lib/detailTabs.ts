import { createDetailTabStore, type DetailTab } from '@skating/core';
import { useSyncExternalStore } from 'react';

/**
 * The one session-scoped tab store for the water-body drawer (N6h/H). Module-level on purpose:
 * the selection outlives any single drawer — close Champlain on *Planning*, open Willoughby, and
 * it is still *Planning*. See `detailTabs.ts` in core for the vocabulary and the reasoning.
 */
export const detailTabStore = createDetailTabStore();

export function useDetailTab(): [DetailTab, (next: DetailTab) => void] {
  const tab = useSyncExternalStore(
    detailTabStore.subscribe,
    detailTabStore.get,
    detailTabStore.get,
  );
  return [tab, detailTabStore.set];
}
