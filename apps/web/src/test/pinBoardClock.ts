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
 * Only `Date` is faked. Faking the timers too cost a flake straight away: `GlobalSearch`'s
 * "once per query" analytics assertion is debounce-timed, and it passed alone but failed under a
 * full-suite load where turbo runs every package at once. The components here read the clock
 * through `Date.now()` and nothing else, so `setTimeout`, `setInterval`, `waitFor` and `findBy*`
 * are left entirely real and behave as they did.
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
