import { type RefObject, useState } from 'react';

import { ActionBar, type ActionBarButton } from '@/components/kit/action-bar';

import type { LivenessView, RunStatus } from '../corpus/runViews';
import { ACTION_WORDS as W } from '../words/runWords';
import { runActions } from './actionsShown';
import { MarkFailedDialog } from './MarkFailedDialog';
import type { RunTarget, RunWrites } from './useRunWrites';

/**
 * **A run's action bar** — the kit's floating `ActionBar`, drawn only from late on (`actionsShown`):
 * *Mark failed* (M) on a late, stalled, held or heartbeat-less run, opening the reason dialog;
 * *Wait 30 minutes* (W) only while stalled. No explaining line: what each does is its tooltip. One
 * action is a full-width bar (the kit decides). *Stop* only when its switch is on. `null` when the
 * run offers nothing, or the viewer can't write (`writes` absent).
 */
export function RunActions({
  target,
  status,
  liveness,
  marked,
  stopAsked = false,
  writes,
  pane,
  stopDrawn,
}: {
  target: RunTarget;
  status: RunStatus;
  /** At the page's clock. */
  liveness: LivenessView;
  marked: boolean;
  stopAsked?: boolean;
  writes: RunWrites | null | undefined;
  /** The pane the keys act in. */
  pane?: RefObject<HTMLElement | null>;
  /** The Stop switch, for its own test; the page always takes `STOP_DRAWN`. */
  stopDrawn?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<'wait' | 'stop' | null>(null);
  const shown = runActions(
    { status, liveness, marked, stopAsked },
    stopDrawn !== undefined ? { stopDrawn } : {},
  );
  if (writes == null || !shown.bar) return null;

  const run = (which: 'wait' | 'stop') => {
    if (busy !== null) return;
    setBusy(which);
    void (which === 'wait' ? writes.wait(target) : writes.stop(target)).then(() => setBusy(null));
  };
  const items: ActionBarButton[] = [];
  if (shown.markFailed) {
    items.push({
      id: 'mark',
      label: W.markFailed,
      hotkey: 'M',
      what: W.markFailedWhat,
      danger: true,
      onPress: () => setAsking(true),
    });
  }
  if (shown.wait) {
    items.push({
      id: 'wait',
      label: W.wait,
      hotkey: 'W',
      what: W.waitWhat,
      loading: busy === 'wait',
      onPress: () => run('wait'),
    });
  }
  if (shown.stop) {
    items.push({
      id: 'stop',
      label: W.stop,
      hotkey: 'S',
      what: W.stopWhat,
      loading: busy === 'stop',
      onPress: () => run('stop'),
    });
  }
  return (
    <>
      <ActionBar
        data-slot="run-actions"
        aria-label={W.bar}
        groups={[{ id: 'run', items }]}
        {...(pane !== undefined && { pane })}
      />
      <MarkFailedDialog
        open={asking}
        onOpenChange={setAsking}
        title={target.title}
        onConfirm={(reason) => writes.markFailed(target, reason)}
      />
    </>
  );
}
