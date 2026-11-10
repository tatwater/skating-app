/**
 * Pin the clock for a file whose component reads it itself instead of taking `now` as a prop —
 * `GlobalSearch`, `SkaterMapCanvas`'s label clock, Explore's `InViewList`. Those cannot be fixed by
 * pinning fixtures alone: a pinned fixture against a live component clock disagrees with it by
 * months, and both live agree only until the local date turns over.
 *
 * Separate from `boardNow.ts` because this file imports `vitest` and that one must not: the
 * constants are reached from `latestFixtures.ts`, which `Latest.stories.tsx` imports, so anything
 * `boardNow.ts` pulls in is pulled into the Storybook browser graph too. `vitest`'s entry reaches
 * `vitest/runtime` and `node:fs`/`node:vm`; `storybook dev` served it as a 2.4 MB dependency
 * chunk, and `storybook build` dropped it only because `vitest` declares `sideEffects: false` and
 * rolldown happened to tree-shake the unused export. A test runner has no business in a story's
 * module graph on either path.
 *
 * Deliberately per-file rather than in `setup.ts`. Pinning the clock for every unit test failed
 * 118 of them: the sheet's IndexedDB, photo-pipeline and reconnect suites drive real async work and
 * a faked clock starves it, even with `shouldAdvanceTime`. So this goes only where a calendar label
 * is actually asserted.
 *
 * Only `Date` is faked. Faking the timers too broke `GlobalSearch`'s debounce outright. The
 * components here read the clock through `Date.now()` and nothing else, so `setTimeout`,
 * `setInterval`, `waitFor` and `findBy*` are left entirely real and behave as they did.
 *
 * ⚠ **The `GlobalSearch` "once per query" flake was never this file's**, though it was first read
 * that way: that test asserted an effect's analytics call immediately after a `findBy*`, and
 * `findBy*` waits with the act environment *off*, so the commit it waits for flushes its passive
 * effects in a scheduler task the wait does not reliably outlast. Load decided it, which is why it
 * passed alone and failed under a full suite. It waits for the event itself now. Pinning the clock
 * changed only how often the race was lost — if a timing assertion fails near this helper, look for
 * an un-awaited effect before suspecting the clock.
 */

import { afterEach, beforeEach, vi } from 'vitest';

import { BOARD_NOON } from './boardNow';

export function pinBoardClock(): void {
  beforeEach(() => {
    vi.useFakeTimers({ now: BOARD_NOON, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
