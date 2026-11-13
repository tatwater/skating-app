import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * The Machinery row's status square: 6 px, square (a dot on a console row is a mark, not a
 * person), colored only by meaning — red won't recover without a person, amber is late or
 * retrying, gray is the quiet state, and hollow is a job that hasn't run yet.
 *
 * Decoration beside a word that already says the state, so it is hidden from a screen reader.
 */
export type StatusDotTone = 'bad' | 'warn' | 'quiet' | 'hollow';

const TONE: Record<StatusDotTone, string> = {
  bad: 'bg-bad',
  warn: 'bg-warn',
  quiet: 'bg-fg2',
  hollow: 'bg-transparent inset-ring inset-ring-fg3',
};

type StatusDotProps = Omit<ComponentProps<'span'>, 'children'> & { tone?: StatusDotTone };

export function StatusDot({ tone = 'quiet', className, ...props }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      data-slot="status-dot"
      data-tone={tone}
      // 6 px: the boards' `.sq` (`--stroke-tick`, a drawing value).
      className={cn('inline-block size-(--stroke-tick) shrink-0', TONE[tone], className)}
      {...props}
    />
  );
}
