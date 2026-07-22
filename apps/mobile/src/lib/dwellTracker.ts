/**
 * The on-device dwell singleton (Phase 9.5) — the runtime around the pure `dwell.ts` fold, the mobile
 * mirror of how `onIceMode` wraps `onIce`. Plain module state (not React): the on-ice watcher pushes a
 * resolved body id in on every fix from the layout, and the report form reads a suggested skate window
 * out when it opens — neither needs to re-render on the stream of observations in between.
 */

import {
  type DwellState,
  emptyDwellState,
  recordDwellFix,
  type SkateWindowSuggestion,
  suggestedSkateWindow,
} from './dwell';

let state: DwellState = emptyDwellState();

/** Local midnight for `now`, so intervals are pruned/aggregated by calendar day (D12, on-device). */
function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Record the body the device is on right now (`null` = off any lake). Called by the layout's on-ice
 * watcher each time it resolves a fix.
 */
export function noteDwell(bodyId: string | null, now: number = Date.now()): void {
  state = recordDwellFix(state, bodyId, now, { dayStartMs: startOfDay(now) });
}

/** The earliest-in / latest-out skate window for `bodyId` from today's dwells — `{}` when none. */
export function getSuggestedSkateWindow(
  bodyId: string,
  now: number = Date.now(),
): SkateWindowSuggestion {
  return suggestedSkateWindow(state, bodyId, { dayStartMs: startOfDay(now) });
}

/** Test seam — clears all recorded dwells. */
export function resetDwellTracker(): void {
  state = emptyDwellState();
}
