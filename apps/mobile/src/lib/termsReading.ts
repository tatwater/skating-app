/**
 * Reading the terms to the end, on the phone (B03 §9.6 boards 11.2–11.4, §9.7). The page is the
 * reader: the terms scroll in the screen's own `ScrollView`, a hairline under the bar fills with the
 * scroll, and the end marker below the last section is what unlocks the agree line once it has been
 * on screen.
 *
 * The server stamps both moments (`consent.openTerms` when the reader first shows, then
 * `consent.reachTermsEnd` when the end is on screen), and the acceptance is refused unless the
 * second landed — so the box unlocks on the server's answer, not on the scroll alone. Everything
 * here is plain functions and a small controller over injected calls, so the rules are tested
 * without a device.
 */

import { consentRefusalAction } from '@skating/core';
import { readRefusal } from './consentClient';

/** What a `ScrollView`'s `onScroll` / `onLayout` / `onContentSizeChange` report, in dp. */
export interface ScrollMetrics {
  /** `contentOffset.y`: how far the content has scrolled. */
  offsetY: number;
  /** The scroll view's own height (`layoutMeasurement.height`). */
  viewportHeight: number;
  /** The content's full height (`contentSize.height`). */
  contentHeight: number;
}

/** The hairline's fill, 0–1: how much of the scrollable distance has been scrolled. */
export function readingProgress({ offsetY, viewportHeight, contentHeight }: ScrollMetrics): number {
  const scrollable = contentHeight - viewportHeight;
  // Everything fits: there is nothing left to scroll, so the reader is full.
  if (scrollable <= 0) return contentHeight > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, offsetY / scrollable));
}

/**
 * Whether the end marker's top edge is inside the visible window. `markerY` is the marker's top
 * within the scroll content (its `onLayout` y), `null` until it has been laid out. A content
 * shorter than the screen shows its marker without a scroll, and counts.
 */
export function endMarkerOnScreen(metrics: ScrollMetrics, markerY: number | null): boolean {
  if (markerY === null || metrics.viewportHeight <= 0) return false;
  return markerY <= metrics.offsetY + metrics.viewportHeight;
}

/**
 * Where the end stands:
 * - `unseen` — the marker hasn't been on screen (or was re-armed);
 * - `recording` — it was, and the stamp is on its way;
 * - `recorded` — the server has it: the agree line unlocks;
 * - `failed` — the stamp was refused or lost; it is tried again when the marker comes back on
 *   screen, never on every scroll event while it stays there;
 * - `outdated` — the server refused this build's terms as out of date (`client_outdated`): no
 *   re-reading fixes that, so it is final — nothing re-arms it, and the screen stops on its update
 *   notice.
 */
export type TermsEnd = 'unseen' | 'recording' | 'recorded' | 'failed' | 'outdated';

export interface TermsReadingState {
  end: TermsEnd;
  progress: number;
}

export interface TermsReadingDeps {
  /** `consent.openTerms` for this build's terms. */
  open: () => Promise<unknown>;
  /** `consent.reachTermsEnd` for this build's terms, `via: 'inline'`. */
  reach: () => Promise<unknown>;
  /** A refusal from either call: the screen toasts it. */
  onRefusal: (error: unknown) => void;
  onChange: (state: TermsReadingState) => void;
}

export interface TermsReading {
  /** The reader is on screen: stamp the opening (once; a repeat changes nothing on the server). */
  start(): void;
  /** A scroll, layout or content-size change. */
  observe(metrics: ScrollMetrics, markerY: number | null): void;
  /**
   * `terms_not_read`: the server has no end for this reading. Start the end over and look again at
   * where the reader is — if the marker is still on screen, it is stamped once more.
   */
  rearm(): void;
  /** The reading starts again from the top (the screen scrolls there). */
  restart(): void;
  state(): TermsReadingState;
  /** The screen is gone: late answers change nothing. */
  dispose(): void;
}

export function createTermsReading(deps: TermsReadingDeps): TermsReading {
  let state: TermsReadingState = { end: 'unseen', progress: 0 };
  let opening: Promise<unknown> | null = null;
  let last: { metrics: ScrollMetrics; markerY: number | null } | null = null;
  let generation = 0;
  let disposed = false;

  const set = (next: Partial<TermsReadingState>) => {
    const merged = { ...state, ...next };
    if (merged.end === state.end && merged.progress === state.progress) return;
    state = merged;
    if (!disposed) deps.onChange(state);
  };

  /** The opening's promise, made once per reading; a failed one is forgotten so the next try asks. */
  const ensureOpen = (): Promise<unknown> => {
    if (opening === null) {
      const attempt = deps.open();
      opening = attempt;
      attempt.catch(() => {
        if (opening === attempt) opening = null;
      });
    }
    return opening;
  };

  /** Whether a refusal says this build's words are out of date: final, never retried. */
  const outdated = (error: unknown) => consentRefusalAction(readRefusal(error).code) === 'outdated';

  const record = () => {
    const mine = generation;
    set({ end: 'recording' });
    const stamp = () => ensureOpen().then(() => deps.reach());
    stamp()
      .catch((error: unknown) => {
        // `terms_not_opened`: the server has no reading under the opening this controller cached
        // (pruned, or lost to a race). The cached promise would only answer "opened" again, so it
        // is dropped, the reader opens anew, and the end is stamped once more — once, not forever.
        const stale = mine !== generation || disposed;
        if (stale || consentRefusalAction(readRefusal(error).code) !== 'reopen') throw error;
        opening = null;
        return stamp();
      })
      .then(
        () => {
          if (mine === generation) set({ end: 'recorded' });
        },
        (error: unknown) => {
          if (mine !== generation || disposed) return;
          set({ end: outdated(error) ? 'outdated' : 'failed' });
          deps.onRefusal(error);
        },
      );
  };

  const look = () => {
    if (last === null) return;
    const onScreen = endMarkerOnScreen(last.metrics, last.markerY);
    if (onScreen && state.end === 'unseen') record();
    else if (!onScreen && state.end === 'failed') set({ end: 'unseen' });
  };

  const start = () => {
    ensureOpen().catch((error: unknown) => {
      if (disposed) return;
      if (outdated(error)) set({ end: 'outdated' });
      deps.onRefusal(error);
    });
  };

  return {
    start,
    observe(metrics, markerY) {
      last = { metrics, markerY };
      set({ progress: readingProgress(metrics) });
      look();
    },
    rearm() {
      if (state.end === 'outdated') return;
      generation++;
      opening = null;
      set({ end: 'unseen' });
      look();
    },
    restart() {
      if (state.end === 'outdated') return;
      generation++;
      opening = null;
      last = null;
      set({ end: 'unseen', progress: 0 });
      start();
    },
    state: () => state,
    dispose() {
      disposed = true;
      generation++;
    },
  };
}
