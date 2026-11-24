import { type EntryProfile, entryRouteRecheckIn } from '@skating/core';
import { useEffect, useReducer } from 'react';

/**
 * The instant the gate reads `resolveEntryRoute` at, and a wake-up when that answer changes with
 * time alone: a suspension's end (`entryRouteRecheckIn`), after which the consent checks apply
 * again. Nothing else in the rule moves with the clock, so the gate re-renders on its queries
 * otherwise.
 */
export function useEntryNow(profile: EntryProfile | null | undefined): number {
  const [, wake] = useReducer((n: number) => n + 1, 0);
  const now = Date.now();
  const delay = entryRouteRecheckIn(profile, now);
  // Keyed on the instant it wakes at, not the delay: a re-render must not push the wake-up back.
  const at = delay === null ? null : now + delay;
  useEffect(() => {
    if (at === null) return;
    const timer = setTimeout(wake, Math.max(0, at - Date.now()));
    return () => clearTimeout(timer);
  }, [at]);
  return now;
}
