import { createDetailTabStore, type DetailTab } from '@skating/core';
import { useSyncExternalStore } from 'react';

/**
 * The one session-scoped tab store for the water-body sheet (N6h/H) — the mobile twin of web's
 * `lib/detailTabs.ts`, over the same core store. Module-level on purpose: the selection outlives
 * any single sheet, so comparing five lakes on *Planning* costs no re-selection. In memory only; a
 * cold start is a new session.
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
