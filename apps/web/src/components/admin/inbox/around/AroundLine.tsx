import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faScaleBalanced } from '@fortawesome/sharp-regular-svg-icons';
import type { ComponentProps } from 'react';

import { Button } from '@/components/kit/button';
import { RetryNote } from '@/components/kit/retry-note';
import { cn } from '@/lib/utils';
import type { AroundItData } from '../handlers/Flag/flagTypes';
import { AROUND_WORDS as W } from '../handlers/Flag/flagWords';
import { type Retry, SubHead } from '../handlers/Flag/parts';
import { aroundLine, aroundSummary, isCapped } from './aroundModel';

/** What the *Around it* read came to. */
export type AroundState = AroundItData | null | 'loading' | 'failed';

export type AroundLineProps = Omit<ComponentProps<'section'>, 'children'> & {
  state: AroundState;
  /** The body's name, as the line says it ("at Mascoma Lake"). */
  bodyName: string;
  /** Opens the drawer. Absent: no *Compare* (nothing to compare against). */
  onCompare?: () => void;
} & Retry;

/**
 * ***Around it*** (board 2.1): the other reports at this body near this one's skate — "3 more
 * reports at Mascoma Lake, within 3 days of this one" — with what they claimed on a gray second line,
 * quoted from their own fields ("2 measured less · 1 saw open water"), never a class (D3). *Compare*
 * (the scale-balanced glyph marks it a button) opens every one of them in the drawer, the ones that
 * agree included.
 */
export function AroundLine({
  state,
  bodyName,
  onCompare,
  onRetry,
  retrying = false,
  className,
  ...props
}: AroundLineProps) {
  const ready = typeof state === 'object' && state !== null;
  const summary = ready ? aroundSummary(state.phrases, undefined, isCapped(state)) : null;
  return (
    <section
      data-slot="around-it"
      className={cn(
        'flex flex-col gap-(--space-1_5) border-0 border-t-(length:--stroke-hair) border-dotted border-line pt-(--space-2_5)',
        className,
      )}
      {...props}
    >
      <div className="flex items-center justify-between gap-(--space-3_5)">
        <SubHead>{W.title}</SubHead>
        {ready && onCompare !== undefined && (
          <Button size="xs" data-slot="around-compare" aria-haspopup="dialog" onClick={onCompare}>
            <FontAwesomeIcon icon={faScaleBalanced} className="h-[1em]" aria-hidden="true" />
            {W.compare}
          </Button>
        )}
      </div>
      <RetryNote data-slot="around-failed" onRetry={onRetry} pending={retrying}>
        {state === 'failed' ? W.missing : undefined}
      </RetryNote>
      {state !== 'failed' && (
        <p data-slot="around-line" className="m-0 text-row leading-snug text-fg1">
          {state === 'loading' ? W.loading : state === null ? W.gone : aroundLine(state, bodyName)}
          {summary !== null && (
            <span
              data-slot="around-summary"
              className="mt-(--space-1) block text-assist leading-snug text-fg3"
            >
              {summary}
            </span>
          )}
        </p>
      )}
    </section>
  );
}
