import { useSyncExternalStore } from 'react';

/**
 * Is the primary pointer a finger — a phone or tablet, not a desk? The *When* row keys off this
 * (founder, 2026-11-07): "9:25 AM · now" is only an honest offer on a device that was at the lake,
 * and nobody brings their laptop to the lake. A viewport width would call a narrow window a phone;
 * the pointer does not.
 */
const QUERY = '(pointer: coarse)';

function media(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(QUERY);
}

function subscribe(onChange: () => void): () => void {
  const mql = media();
  // The jsdom stub and very old engines carry `addListener` only; a no-op unsubscribe is fine there.
  mql?.addEventListener?.('change', onChange);
  return () => mql?.removeEventListener?.('change', onChange);
}

function snapshot(): boolean {
  return media()?.matches ?? false;
}

export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
