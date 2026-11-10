/**
 * The fixed instant that fixtures, stories and render tests call "now".
 *
 * The cards' clock words are **calendar**-based, not elapsed-based: `panelTime`'s `daysBetween`
 * rounds both instants down with `setHours(0, 0, 0, 0)`, so "Today" and a row's `3 h` corner both
 * require the item to fall on the same local date as `now`. A fixture that backdates a live
 * `Date.now()` by N hours therefore stops saying "Today" whenever the runner's clock reads earlier
 * than N:00 — and says a weekday instead.
 *
 * That is not hypothetical. It turned CI red on PR #102 at 00:18 UTC with five failures across
 * `GlobalSearch`, `latestViews` and `ProfilePage`, none of them in the code that PR touched. The
 * window is the founder's working hours: 7 PM–midnight Eastern *is* 00:00–05:00 UTC, so a suite
 * anchored to a live clock is green on a New Hampshire laptop and red on a UTC runner every night.
 *
 * Both constants are Saturday 16 January 2027 — the design boards' "today" — and which one a test
 * wants depends on who owns the zone:
 *
 * - `BOARD_NOON` for zone-*naive* code (`panelTime`, `profileModel`, anything rendering a card).
 *   Built from local parts, so it reads as noon in whatever zone the runner uses and the same
 *   assertions hold in UTC and in Eastern alike. Midday leaves ~12 h of headroom on either side of
 *   local midnight, which is more than any fixture here backdates.
 * - `BOARD_NOW_NH` for zone-*aware* code that takes the zone as an argument (`lakeModel`,
 *   `reportCalendar`, `PhoneInstrumentStrip`). Those need one absolute instant, so it is pinned in
 *   UTC and read back through `America/New_York`.
 *
 * The date is frozen rather than "today at noon" because weekday labels are asserted outright —
 * `profileModel.test.ts` expects `dayKicker(NOW - 3 * DAY, NOW)` to be `'Wednesday'`, which holds
 * only when "today" is a Saturday. `packages/guards/src/testClock.test.ts` keeps new fixtures and
 * calendar-asserting render tests on these constants.
 *
 * Constants only, and no `vitest` import: `latestFixtures.ts` reaches this file and
 * `Latest.stories.tsx` reaches that, so whatever this imports is bundled into Storybook's
 * browser graph. A test file that needs the clock itself pinned imports `pinBoardClock` from
 * `./pinBoardClock`, which is where the `vitest` dependency is kept.
 */

/** Saturday 16 January 2027, 12:00 in the runner's own zone. For code that reads the local date. */
export const BOARD_NOON = new Date(2027, 0, 16, 12, 0).getTime();

/** Saturday 16 January 2027, 11:52 AM in New Hampshire. For code that takes the zone explicitly. */
export const BOARD_NOW_NH = Date.UTC(2027, 0, 16, 16, 52);
