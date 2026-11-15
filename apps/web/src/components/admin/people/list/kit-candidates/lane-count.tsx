import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * **A kit candidate** (People, B01): a lane's count whose ink is its meaning, chosen or not. The kit
 * `Lanes` lights the chosen lane's count whatever its tone; board 8.1 keeps Suspended's count amber
 * while Suspended is open — amber says a person is waited on, and choosing the lane doesn't answer
 * that. Drawn through a lane's `tail`, in the count's own type and place, so selection can't relight
 * it.
 *
 * **The kit change that retires it** (`components/kit/lanes.tsx`, `LaneRow`): a meaning tone survives
 * selection, and only the quiet one lights —
 * `const tone = lane.countTone === 'warn' || lane.countTone === 'bad' ? lane.countTone : on ? 'lit' : (lane.countTone ?? 'default');`
 * After it, a caller passes `count` and `countTone` as before and this goes.
 */

const TONE = { warn: 'text-warn', bad: 'text-bad' } as const;

type LaneCountProps = Omit<ComponentProps<'span'>, 'children'> & {
  /** The count as the lane writes it ("1", "200+"). */
  children: string;
  /** The meaning that holds through selection: amber waits on a person, red failed. */
  tone: keyof typeof TONE;
};

function LaneCount({ tone, className, children, ...props }: LaneCountProps) {
  return (
    <span
      data-slot="lane-count"
      data-tone={tone}
      className={cn(
        'font-(family-name:--family-mono) text-mono-sm leading-none font-medium tabular-nums',
        TONE[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

export { LaneCount, type LaneCountProps };
