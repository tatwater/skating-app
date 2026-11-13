import { onceADay } from '@skating/core';
import { useEffect, useRef } from 'react';

/**
 * Run `sync` on app open — the mount of the shell every signed-in page renders — and again when a
 * tab left open comes back into view on a new UTC day.
 *
 * The second half is for the per-day sign-in record (`signInDays`, B01): `profiles.syncFromClerk`
 * is where a day's first open goes on the record, and a tab opened on Monday and returned to on
 * Tuesday never remounts, so a mount-only call would miss the returning person — and a missed day
 * can't be backfilled. Gated to once a day (`onceADay`), not every focus: the server writes once a
 * day either way, so a call on each return would only be chatter.
 */
export function useOpenSync(sync: () => void, enabled: boolean): void {
  const latest = useRef(sync);
  latest.current = sync;

  useEffect(() => {
    if (!enabled) return;
    const due = onceADay();
    due(Date.now());
    latest.current();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && due(Date.now())) latest.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [enabled]);
}
