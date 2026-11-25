import { useEffect, useId, useRef } from 'react';

import { Button } from '@/components/kit/button';
import { AERIAL_LOAD_WORDS } from '../consoleWords';
import { type AerialLoadView, aerialCreditLine } from './consoleAerial';

/**
 * **The summer aerial's credit in the map's dock, with its state** (`consoleAerial`'s
 * {@link AerialLoadView}): "Aerial · NAIP Jun 2023" once the photograph is in, "… · Loading…"
 * while it isn't, "… · Didn’t load" (or "Part of it didn’t load") with *Try again* when cells
 * didn't come.
 *
 * The console's idioms for a read in place, at the size of a credit: the words are a polite live
 * region (mounted with the switch, so a change of state is announced), still — no shimmer, no
 * spinner, so reduced motion has nothing to stop — and *Try again* is the kit's extra-small button
 * as `RetryNote` draws it, *Trying again…* (`aria-disabled`, still focusable) until the answer
 * lands. When the photograph recovers and the button goes, focus that was on it stays on the
 * credit rather than dropping to the page. On one line wherever it fits; on a phone's narrow
 * embed it wraps rather than running off the map.
 */
export function AerialCredit({ credit, state }: { credit: string; state: AerialLoadView }) {
  const { load, onRetry, pending = false } = state;
  const id = useId();
  const words = useRef<HTMLSpanElement>(null);
  const focused = useRef(false);
  const offered = onRetry !== undefined;
  useEffect(() => {
    if (!offered && focused.current) {
      focused.current = false;
      words.current?.focus();
    }
  }, [offered]);
  return (
    <span className="flex min-w-0 items-end gap-(--space-2) ps-(--space-2_5)">
      <span
        ref={words}
        id={id}
        role="status"
        aria-live="polite"
        tabIndex={-1}
        data-slot="body-map-aerial-credit"
        data-state={load}
        className="pb-(--space-1) text-kick leading-none font-medium tracking-kick text-balance text-fg2 uppercase outline-none"
      >
        {aerialCreditLine(credit, load)}
      </span>
      {offered && (
        <Button
          size="xs"
          data-slot="body-map-aerial-retry"
          className="shrink-0 bg-map-plate"
          aria-describedby={id}
          aria-disabled={pending || undefined}
          onFocus={() => {
            focused.current = true;
          }}
          onBlur={() => {
            focused.current = false;
          }}
          onClick={() => {
            if (!pending) onRetry();
          }}
        >
          {pending ? AERIAL_LOAD_WORDS.retrying : AERIAL_LOAD_WORDS.retry}
        </Button>
      )}
    </span>
  );
}
