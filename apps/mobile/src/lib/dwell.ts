/**
 * Per-body dwell bookkeeping (Phase 9.5) — the pure half of "auto-suggest the skate window".
 *
 * The on-ice GPS watcher already resolves *which lake you're on* every fix (see the `(map)` layout).
 * This folds that stream of `(bodyId, time)` observations into **dwell intervals per body**, so when the
 * report form opens for lake X it can prefill the skate window from when the device was actually on X.
 *
 * Two rules make the suggestion robust without much machinery:
 * - **Debounced leaves.** A single lap that clips the shoreline (a brief resolve to `null` or a
 *   neighbour) is not a departure — a leave is only committed once the skater has been off the body for
 *   `graceMs`. So a normal skate is one interval, not a shredded pile of them.
 * - **Per-body earliest-in / latest-out.** The suggestion is `min(start)` and `max(end)` across *all* of
 *   today's intervals on that body, so even if bookkeeping does fragment (a snack break off the ice, a
 *   peek at a neighbouring lake), the window collapses back to one honest span — and excursions to
 *   *other* lakes never touch this body's suggestion.
 *
 * On-device only (D12): these observations never leave the phone, and they're pruned to the current day.
 * The data is *complete* only while on-ice mode is armed (background fixes keep flowing); unarmed the
 * watcher is foreground-only, so a pocketed stretch leaves gaps and the suggestion is best-effort — which
 * is why it's a prefill the skater edits, never an authoritative value.
 */

/** A completed dwell on one body: the device was on it from `start` to `end` (epoch ms). */
export interface DwellInterval {
  bodyId: string;
  start: number;
  end: number;
}

/** The dwell in progress — held open across brief excursions until a leave is confirmed. */
export interface OpenDwell {
  bodyId: string;
  start: number;
  /** The last fix that was actually on this body — the interval's end if it's committed now. */
  lastSeen: number;
}

export interface DwellState {
  intervals: DwellInterval[];
  current: OpenDwell | null;
}

export function emptyDwellState(): DwellState {
  return { intervals: [], current: null };
}

/**
 * How long the device must be off a body before its dwell is closed. Absorbs the brief off-body fixes a
 * shoreline-clipping lap produces, so those don't split one skate into many intervals.
 */
export const DEFAULT_DWELL_GRACE_MS = 2 * 60_000;

export interface RecordDwellOptions {
  graceMs?: number;
  /** Intervals ending before this (start of the current day) are dropped; on-device, day-scoped (D12). */
  dayStartMs?: number;
}

/**
 * Fold one resolved fix — the body the device is on right now (`null` = off any lake) at `now` — into the
 * dwell state. Pure: returns the next state, never mutates the input.
 */
export function recordDwellFix(
  state: DwellState,
  bodyId: string | null,
  now: number,
  options: RecordDwellOptions = {},
): DwellState {
  const { graceMs = DEFAULT_DWELL_GRACE_MS, dayStartMs = 0 } = options;
  let intervals = state.intervals;
  let current = state.current;

  if (current) {
    if (bodyId === current.bodyId) {
      // Still here — extend the open dwell. Any pending brief excursion is thereby forgiven.
      current = { ...current, lastSeen: now };
    } else if (now - current.lastSeen > graceMs) {
      // Off the body past the grace window ⇒ a real departure. Commit the dwell and open a new one if
      // the skater has moved onto another body (else they're off the ice entirely).
      intervals = [
        ...intervals,
        { bodyId: current.bodyId, start: current.start, end: current.lastSeen },
      ];
      current = bodyId ? { bodyId, start: now, lastSeen: now } : null;
    }
    // else: a brief excursion within grace — hold the open dwell untouched so a return re-extends it.
  } else if (bodyId) {
    current = { bodyId, start: now, lastSeen: now };
  }

  // Prune completed intervals to the current day, and clamp an open dwell that began yesterday so its
  // suggested start can't reach back past midnight.
  intervals = intervals.filter((iv) => iv.end >= dayStartMs);
  if (current && current.start < dayStartMs) current = { ...current, start: dayStartMs };

  return { intervals, current };
}

/** A suggested skate window — either bound is absent when there's nothing to suggest. */
export interface SkateWindowSuggestion {
  start?: number;
  end?: number;
}

/**
 * The earliest-in / latest-out window across today's dwells on `bodyId`, including the open dwell if it's
 * on that body. `{}` when there's no dwell data for it — the caller then leaves the form on its defaults.
 */
export function suggestedSkateWindow(
  state: DwellState,
  bodyId: string,
  options: { dayStartMs?: number } = {},
): SkateWindowSuggestion {
  const { dayStartMs = 0 } = options;
  const spans: { start: number; end: number }[] = [];
  for (const iv of state.intervals) {
    if (iv.bodyId === bodyId && iv.end >= dayStartMs) {
      spans.push({ start: Math.max(iv.start, dayStartMs), end: iv.end });
    }
  }
  if (state.current && state.current.bodyId === bodyId) {
    spans.push({ start: Math.max(state.current.start, dayStartMs), end: state.current.lastSeen });
  }
  if (spans.length === 0) return {};
  return {
    start: Math.min(...spans.map((s) => s.start)),
    end: Math.max(...spans.map((s) => s.end)),
  };
}
