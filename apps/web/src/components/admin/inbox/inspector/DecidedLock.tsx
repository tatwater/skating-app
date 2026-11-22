import type { ReactNode } from 'react';

import { Button } from '@/components/kit/button';
import { Kbd } from '@/components/kit/kbd';
import { LockBanner } from '@/components/kit/note';

import { historyWhen } from '../../shell/consoleTime';
import { BACK_TO_QUEUE, DECISION_WORDS, decidedBy } from '../words/inboxWords';
import type { DecidedState } from './InspectorFrame';

/**
 * **The decided-only lock** (D283, `states-v5.html`'s *Decided while you looked*): an item someone
 * else decided while it was open here. The kit `LockBanner` (decided-only) — the line says
 * who, when and what ("Decided by Sarah Berman · 14:42 · approved"), and under it the item's
 * *History →* and *Back to the queue* with its ⏎ (the inspector's own key while the lock stands).
 *
 * Its copy is the operator's: who and when, never "you". The time is the History row's form
 * (`historyWhen`): the clock today, the weekday this past week, the day and month before that.
 */
export function DecidedLock({
  locked,
  now,
  timeZone,
  history,
  onBack,
}: {
  locked: DecidedState;
  now: number;
  timeZone?: string | undefined;
  history?: ReactNode;
  onBack?: (() => void) | undefined;
}) {
  const hasActions = history != null || onBack !== undefined;
  return (
    <LockBanner
      data-slot="inbox-decided-lock"
      data-by-me={locked.byMe ? '' : undefined}
      {...(hasActions && {
        actions: (
          <>
            {history}
            {onBack !== undefined && (
              <Button size="xs" data-slot="inbox-back-to-queue" onClick={onBack}>
                {BACK_TO_QUEUE}
                <Kbd variant="dim" aria-hidden="true">
                  ⏎
                </Kbd>
              </Button>
            )}
          </>
        ),
      })}
    >
      <strong>{decidedBy(locked.by)}</strong>
      {` · ${historyWhen(locked.at, now, timeZone)} · ${DECISION_WORDS[locked.decision]}`}
    </LockBanner>
  );
}
