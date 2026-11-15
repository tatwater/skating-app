import { useState } from 'react';

/**
 * The minute a place was opened at, held while it stays open — the clock both People pages ask
 * their reads against (the list per lane or search, the person page per person), so a new minute
 * never restarts a subscription or the paging. A new `key` reads the clock again.
 */
export function useClockFor(key: string): number {
  const [clock, setClock] = useState(() => ({ key, at: minuteOf(Date.now()) }));
  if (clock.key !== key) {
    const next = { key, at: minuteOf(Date.now()) };
    setClock(next);
    return next.at;
  }
  return clock.at;
}

/** The start of the minute `at` falls in. */
export const minuteOf = (at: number): number => Math.floor(at / 60_000) * 60_000;
