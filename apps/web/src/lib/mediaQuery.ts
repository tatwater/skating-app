import { useSyncExternalStore } from 'react';

/**
 * A media query as an external store, for the few choices CSS can't make — which overlay mounts,
 * whether a second map is created, whether "now" is an honest offer. One store per query, made once
 * at module scope, so a re-render never resubscribes.
 */
export interface MediaQueryStore {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => boolean;
}

/** The query's list, or `null` where there is no `matchMedia` (the server, an old engine). */
function listFor(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(query);
}

export function mediaQueryStore(query: string): MediaQueryStore {
  return {
    subscribe(onChange) {
      const list = listFor(query);
      // The jsdom stub and very old engines carry `addListener` only; a no-op unsubscribe is fine there.
      list?.addEventListener?.('change', onChange);
      return () => list?.removeEventListener?.('change', onChange);
    },
    getSnapshot: () => listFor(query)?.matches ?? false,
  };
}

/**
 * The server, and the hydration pass, answer `false`; the client corrects it in the same commit,
 * before the first paint (React re-renders a mismatched external store synchronously after
 * hydrating). CSS hides whatever the wrong guess drew in the meantime.
 */
const getServerSnapshot = () => false;

/** Whether the store's query matches now; re-renders when the answer changes. */
export function useMediaQuery(store: MediaQueryStore): boolean {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, getServerSnapshot);
}
