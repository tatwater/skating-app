import { useState } from 'react';

/**
 * **What a console read is asked with** — one rule each, shared by every page (the Bodies list and
 * preview, the Body console, the People pages, the shell):
 *
 * - {@link ID_SHAPE} — a Convex id's shape, so a hand-edited link or a stored entry never reaches a
 *   read as junk;
 * - {@link useClockFor} — the minute a place was opened at, held while it stays open, so the clock
 *   moving on never restarts a subscription or its paging;
 * - {@link minuteOf} — the start of the minute an instant falls in.
 */

/** A Convex id's shape. */
export const ID_SHAPE = /^[0-9a-z]{30,34}$/;

/** The start of the minute `at` falls in. */
export const minuteOf = (at: number): number => Math.floor(at / 60_000) * 60_000;

/**
 * The minute a place was opened at, held while it stays open: the clock its reads are asked
 * against. A new `key` (another lane, search or body) reads the clock again.
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
