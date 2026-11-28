import { type RefObject, useState } from 'react';

import { ActionBar, type ActionBarButton } from '@/components/kit/action-bar';

import { type ImageryPageView, waitingToRetry } from './imageryModel';
import * as W from './imageryWords';
import type { ImageryWrites } from './useImageryWrites';

/**
 * **The season's floating bar** (board 6.4's *This season* bar, at the detail column's foot):
 *
 * - ***Retry failed · N*** (R) while any granule failed and imagery runs or is paused;
 * - ***Pause*** (P) while it runs, ***Resume*** (P) while it's paused — each the other's undo;
 * - ***Try again now*** (T) only while the pump backs off or the index waits to re-read.
 *
 * None while imagery hasn't started (the start panel holds *Start imagery*) or after it ended. No
 * explaining line: what each does is its tooltip. `null` when the viewer can't write, or nothing
 * applies. A press is busy until its write answers; a refusal is a toast (the write path's).
 */
export function imageryActionsShown(
  view: Pick<ImageryPageView, 'state' | 'counts' | 'backoffUntil' | 'index'>,
  now: number,
): { retryFailed: boolean; pause: boolean; resume: boolean; tryAgain: boolean } {
  const live = view.state === 'running' || view.state === 'paused';
  return {
    retryFailed: live && view.counts.failed > 0,
    pause: view.state === 'running',
    resume: view.state === 'paused',
    tryAgain: live && waitingToRetry(view as ImageryPageView, now),
  };
}

export function ImageryActions({
  view,
  now,
  writes,
  pane,
}: {
  view: ImageryPageView;
  now: number;
  writes: ImageryWrites | null | undefined;
  /** The pane the keys act in. */
  pane?: RefObject<HTMLElement | null>;
}) {
  const [busy, setBusy] = useState<'retry' | 'pause' | 'resume' | 'again' | null>(null);
  if (writes == null) return null;
  const shown = imageryActionsShown(view, now);
  const run = (which: NonNullable<typeof busy>, write: () => Promise<boolean>) => {
    if (busy !== null) return;
    setBusy(which);
    void write().then(() => setBusy(null));
  };
  const items: ActionBarButton[] = [];
  if (shown.retryFailed) {
    items.push({
      id: 'retry',
      label: W.retryFailedLabel(view.counts.failed),
      hotkey: 'R',
      what: W.RETRY_FAILED_WHAT,
      loading: busy === 'retry',
      onPress: () => run('retry', () => writes.retryFailed(view.season)),
    });
  }
  if (shown.pause) {
    items.push({
      id: 'pause',
      label: W.PAUSE,
      hotkey: 'P',
      what: W.PAUSE_WHAT,
      loading: busy === 'pause',
      onPress: () => run('pause', () => writes.pause(view.season)),
    });
  }
  if (shown.resume) {
    items.push({
      id: 'resume',
      label: W.RESUME,
      hotkey: 'P',
      what: W.RESUME_WHAT,
      loading: busy === 'resume',
      onPress: () => run('resume', () => writes.start(view.season, true)),
    });
  }
  if (shown.tryAgain) {
    items.push({
      id: 'again',
      label: W.TRY_AGAIN_NOW,
      hotkey: 'T',
      what: W.TRY_AGAIN_WHAT,
      loading: busy === 'again',
      onPress: () => run('again', () => writes.tryAgainNow(view.season)),
    });
  }
  if (items.length === 0) return null;
  return (
    <ActionBar
      data-slot="imagery-actions"
      aria-label={W.BAR}
      groups={[{ id: 'season', label: W.BAR, items }]}
      {...(pane !== undefined && { pane })}
    />
  );
}
