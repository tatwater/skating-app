import { useSyncExternalStore } from 'react';

/**
 * The phone pass's breakpoint (row 9): below Tailwind's `md` (48 rem) the skater app swaps its
 * chrome and lays its pages out one column at a time. CSS owns what can be decided by CSS
 * (`max-md:` classes); this hook is for the few choices CSS can't make — which overlay mounts
 * (two copies of a controlled popover would both open), and whether a second map instance is
 * created at all.
 *
 * The same edge as `max-md:` (`width < 48rem`), written as `max-width` for the broadest support.
 */
export const PHONE_QUERY = '(max-width: 47.99rem)';

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(PHONE_QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

const getSnapshot = () => window.matchMedia(PHONE_QUERY).matches;

/**
 * The server, and the hydration pass, render the desktop answer; the client corrects it in the
 * same commit, before the first paint (React re-renders a mismatched external store synchronously
 * after hydrating). CSS hides whatever the wrong guess drew in the meantime.
 */
const getServerSnapshot = () => false;

/** True below `md`: the phone's layout. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
