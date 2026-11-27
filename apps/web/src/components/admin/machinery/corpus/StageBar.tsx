import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * **The stage bar** (kit candidate; boards 6.2 and `live-v5` §1): a run's passes as a row of short
 * segments, 16 × 5 px, 2 px apart, a wider gap before the second group (the by-hand passes).
 *
 * - **Tones by meaning only.** `done` is the quiet fill; `running` ice with its glow; `late` and
 *   `waiting` (a stall held by a person) amber; `stalled` and `failed` red, the stall with its glow;
 *   `dead` a pass the run will never reach, a step brighter than `idle` (planned, not started).
 * - **Decoration over words**: the sub-line beside it says the same in words, so the bar is one
 *   image to a reader, named by `label`.
 */

export type StageTone =
  | 'done'
  | 'running'
  | 'late'
  | 'stalled'
  | 'waiting'
  | 'failed'
  | 'dead'
  | 'idle';

export type StageSegment = { id: string; tone: StageTone; group?: 'script' | 'hand' };

const TONE: Record<StageTone, string> = {
  done: 'bg-fg2',
  running: 'bg-acc shadow-[0_0_var(--stroke-tick)_var(--acc-glow)]',
  late: 'bg-warn',
  waiting: 'bg-warn',
  stalled: 'bg-bad shadow-[0_0_var(--stroke-tick)_var(--bad-glow)]',
  failed: 'bg-bad',
  dead: 'bg-line2',
  idle: 'bg-line',
};

export function StageBar({
  segments,
  label,
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & {
  segments: readonly StageSegment[];
  /** What the bar says, for a reader: the sub-line's words. */
  label: string;
}) {
  return (
    <div
      data-slot="stage-bar"
      role="img"
      aria-label={label}
      className={cn('flex min-w-0 items-center gap-(--space-0_5)', className)}
      {...props}
    >
      {segments.map((s, i) => (
        <span
          key={s.id}
          data-slot="stage-segment"
          data-tone={s.tone}
          className={cn(
            // 16 px each, giving way (never below 4) when a phone's stat is narrower than the bar.
            'h-[calc(var(--stroke-now)+var(--stroke-hair))] w-(--space-4) min-w-(--space-1) shrink',
            TONE[s.tone],
            // The second group starts a gap further on.
            i > 0 && s.group === 'hand' && segments[i - 1]?.group !== 'hand' && 'ms-(--space-2)',
          )}
        />
      ))}
    </div>
  );
}
