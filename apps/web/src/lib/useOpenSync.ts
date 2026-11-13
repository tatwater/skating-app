import { onceADay } from '@skating/core';
import { useEffect, useRef } from 'react';

/**
 * Run `sync` on app open — the mount of the shell every signed-in page renders — and again when a
 * tab left open comes back on a new UTC day: back into view, or a window that never left view
 * focused again.
 *
 * The second half is for the per-day sign-in record (`signInDays`, B01): `profiles.syncFromClerk`
 * is where a day's first open goes on the record, and a tab opened on Monday and returned to on
 * Tuesday never remounts, so a mount-only call would miss the returning person — and a missed day
 * can't be backfilled. `visibilitychange` alone isn't enough: a desktop window left visible
 * overnight (a second monitor, a window behind another) is never hidden, so it never fires. Gated to
 * once a day (`onceADay`), not every return: the server writes once a day either way, so a call on
 * each would only be chatter.
 */
export function useOpenSync(sync: () => void, enabled: boolean): void {
  const latest = useRef(sync);
  latest.current = sync;

  useEffect(() => {
    if (!enabled) return;
    const due = onceADay();
    due(Date.now());
    latest.current();
    const onReturn = () => {
      if (document.visibilityState === 'visible' && due(Date.now())) latest.current();
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [enabled]);
}
