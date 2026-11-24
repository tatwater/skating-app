import { type EntryProfile, entryRouteRecheckIn } from '@skating/core';
import { useEffect, useReducer } from 'react';

/**
 * The instant the gate reads `resolveEntryRoute` at, and a wake-up when that answer changes with
 * time alone: a suspension's end (`entryRouteRecheckIn`), after which the consent checks apply
 * again. Nothing else in the rule moves with the clock, so the gate re-renders on its queries
 * otherwise.
 */
export function useEntryNow(profile: EntryProfile | null | undefined): number {
  const [woken, wake] = useReducer((n: number) => n + 1, 0);
  const now = Date.now();
  const delay = entryRouteRecheckIn(profile, now);
  // Keyed on the instant it wakes at, not the delay: a re-render must not push the wake-up back.
  const at = delay === null ? null : now + delay;
  // And on each wake, as the phone's gate is: a timer that fired a hair early (a clock step, a
  // coarsened `Date.now()`) computes the same `at`, and keyed on that alone would set no new one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the wake count is the trigger
  useEffect(() => {
    if (at === null) return;
    const timer = setTimeout(wake, Math.max(0, at - Date.now()));
    return () => clearTimeout(timer);
  }, [at, woken]);
  return now;
}
