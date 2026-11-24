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

import { consentRefusalAction, termsOpenRetryDue } from '@skating/core';
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
  /** The reading starts again: the screen scrolls its reader to the top. */
  toTop?: () => void;
  /**
   * The end was reached on a reading the server never opened: the screen says why, in
   * `terms_not_opened`'s words, as the reading starts again from the top.
   */
  onUnopened?: () => void;
  /** The clock a failed opening's retries are spaced on (`termsOpenRetryDue`); a test pins it. */
  now?: () => number;
}

export interface TermsReading {
  /** The reader is on screen: stamp the opening (once; a repeat changes nothing on the server). */
  start(): void;
  /** A scroll, layout or content-size change. */
  observe(metrics: ScrollMetrics, markerY: number | null): void;
  /**
   * `terms_not_read`: the server has no end for this reading. Start the end over and look again at
   * where the reader is — if the marker is still on screen, it is stamped once more, on the opening
   * this reading already has (never a new one: a reading the server lost answers `terms_not_opened`
   * and starts again from the top, as on the web).
   */
  rearm(): void;
  /**
   * The reading starts again from the top (the screen scrolls there): opened anew, and the end
   * counts only once the marker has left the screen and been reached again.
   */
  restart(): void;
  state(): TermsReadingState;
  /** The screen is gone: late answers change nothing. */
  dispose(): void;
}

/** One try at opening a reading: `out` until the server answers, `open` once it has the reading. */
interface Opening {
  status: 'out' | 'open';
}

/**
 * The reading's controller. **A reading the server doesn't have** — the opening failed, or the end
 * was refused `terms_not_opened` (pruned, or lost to a race) — is never patched up by opening and
 * stamping in one breath: the sealed record would say the terms were opened and finished in the same
 * instant. So **an end reached while an opening is out** (the first, or a retry) never counts on it:
 * once the opening has answered, the marker must leave the screen and come back before the end is
 * stamped. A failed opening is said once and tried again, quietly, as the skater scrolls (no more
 * often than core's `TERMS_OPEN_RETRY_GAP_MS`), so the server normally has the reading by the end.
 * If the end is reached without one, the skater is told why (`onUnopened`) and — as on the web
 * (core's `reopen` action) — the reading opens anew, the screen scrolls to the top, and the end
 * counts only when the marker has left the screen and been reached again; so a server that keeps
 * refusing costs one toast per reading, never a loop. Unless the last refusal was the profile
 * gate's own (the account can't act right now): then the end says the server's words, once, and
 * nothing restarts or opens again; the end is tried again when the marker comes back, by which time
 * a quiet retry may have opened the reading.
 */
export function createTermsReading(deps: TermsReadingDeps): TermsReading {
  const now = deps.now ?? Date.now;
  let state: TermsReadingState = { end: 'unseen', progress: 0 };
  /** This reading's opening, out or answered; `null` before it, or once its last try failed. */
  let opening: Opening | null = null;
  /** The last try at opening was refused, and how: there is nothing on the server to finish. */
  let failure: { error: unknown } | null = null;
  /** When the last try at opening started, for the retries' spacing. */
  let lastTry: number | null = null;
  /**
   * The end was reached while an opening was out, or the reading started again: the marker must
   * leave the screen, with no opening out, before its arrival counts.
   */
  let mustLeave = false;
  let last: { metrics: ScrollMetrics; markerY: number | null } | null = null;
  let generation = 0;
  let disposed = false;

  const set = (next: Partial<TermsReadingState>) => {
    const merged = { ...state, ...next };
    if (merged.end === state.end && merged.progress === state.progress) return;
    state = merged;
    if (!disposed) deps.onChange(state);
  };

  /**
   * Opens the reading, once per reading. A failure is said here when it is the screen's first
   * opening, or when it changes where the skater goes (out of date, which is final). A retry, or a
   * reading started again, opens quietly: the skater was told already, and the end says why if it
   * is still unopened. A failed opening is forgotten, and marks the reading as one the server
   * doesn't have, until a retry opens it.
   */
  const ensureOpen = (quiet = false) => {
    if (opening !== null) return;
    const mine: Opening = { status: 'out' };
    opening = mine;
    failure = null;
    lastTry = now();
    deps.open().then(
      () => {
        if (opening === mine) mine.status = 'open';
      },
      (error: unknown) => {
        if (opening !== mine || disposed) return;
        opening = null;
        failure = { error };
        const final = consentRefusalAction(readRefusal(error).code) === 'outdated';
        if (final) set({ end: 'outdated' });
        if (final || !quiet) deps.onRefusal(error);
      },
    );
  };

  /** A new reading, from the top; its end counts only once reached again. */
  const restart = () => {
    if (state.end === 'outdated' || disposed) return;
    generation++;
    opening = null;
    failure = null;
    mustLeave = true;
    last = null;
    set({ end: 'unseen', progress: 0 });
    deps.toTop?.();
    // Quiet: the reason was just said; a failure here is tried again, and said at the end if need be.
    ensureOpen(true);
  };

  /**
   * The end reached on a reading the server never opened: said, then read again from the top. A
   * can't-act refusal is said in the server's words instead, and the end waits for the marker to
   * come back: no `terms_not_opened`, no restart, no new opening on top of it.
   */
  const unopened = () => {
    if (state.end === 'outdated' || disposed) return;
    if (failure !== null && readRefusal(failure.error).cannotAct) {
      deps.onRefusal(failure.error);
      set({ end: 'failed' });
      return;
    }
    deps.onUnopened?.();
    restart();
  };

  const record = () => {
    // No reading on the server for this end to finish: start it again rather than open and stamp
    // at once.
    if (opening === null) {
      unopened();
      return;
    }
    // An opening still out: this arrival never counts on it, even once it answers.
    if (opening.status === 'out') {
      mustLeave = true;
      return;
    }
    const mine = generation;
    set({ end: 'recording' });
    deps.reach().then(
      () => {
        if (mine === generation) set({ end: 'recorded' });
      },
      (error: unknown) => {
        if (mine !== generation || disposed) return;
        deps.onRefusal(error);
        const action = consentRefusalAction(readRefusal(error).code);
        if (action === 'reopen') restart();
        else set({ end: action === 'outdated' ? 'outdated' : 'failed' });
      },
    );
  };

  const look = () => {
    if (last === null) return;
    const onScreen = endMarkerOnScreen(last.metrics, last.markerY);
    if (mustLeave) {
      // Left with no opening out: the next arrival counts.
      if (!onScreen && opening?.status !== 'out') mustLeave = false;
      return;
    }
    if (onScreen && state.end === 'unseen') record();
    else if (!onScreen && state.end === 'failed') set({ end: 'unseen' });
  };

  return {
    start() {
      ensureOpen();
    },
    observe(metrics, markerY) {
      last = { metrics, markerY };
      set({ progress: readingProgress(metrics) });
      look();
      // Still reading with no opening: try again, quietly, at most once per gap — not while the end
      // waits for the marker to leave (it has just said why).
      if (
        failure !== null &&
        state.end === 'unseen' &&
        !mustLeave &&
        !disposed &&
        termsOpenRetryDue(lastTry, now())
      ) {
        ensureOpen(true);
      }
    },
    rearm() {
      if (state.end === 'outdated') return;
      generation++;
      // The opening stays: the server's answer to the end decides whether the reading was lost.
      set({ end: 'unseen' });
      look();
    },
    restart,
    state: () => state,
    dispose() {
      disposed = true;
      generation++;
    },
  };
}
