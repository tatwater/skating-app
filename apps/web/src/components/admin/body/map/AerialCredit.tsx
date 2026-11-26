import { useCallback, useEffect, useId, useRef } from 'react';

import { Button } from '@/components/kit/button';
import { Plate } from '@/components/kit/plate';
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
 * embed it wraps rather than running off the map. The words sit on their own plate (the kit's map
 * plate, opaque), so they read whatever the photograph under them — chrome in the page's theme,
 * like *Try again* beside it (founder, 2026-11-26: the imagery date stays readable everywhere).
 *
 * ⚠ Whether the button held focus is read **as its ref is detached** — while it is still on the
 * page — never from its `blur`. Chromium blurs a focused node as it is removed and jsdom doesn't,
 * so a flag a blur clears reads "not focused" by the time the effect asks: focus fell to the page
 * in the browser while the jsdom test passed. `AerialCredit.stories` holds it in a real one.
 */
export function AerialCredit({ credit, state }: { credit: string; state: AerialLoadView }) {
  const { load, onRetry, pending = false } = state;
  const id = useId();
  const words = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  /** The button went with focus on it: owed to the credit, paid by the effect below. */
  const owed = useRef(false);
  const setButton = useCallback((node: HTMLButtonElement | null) => {
    // React detaches a ref before it takes the node off the page: focus is still readable here.
    if (node === null) {
      owed.current = button.current !== null && document.activeElement === button.current;
    }
    button.current = node;
  }, []);
  const offered = onRetry !== undefined;
  useEffect(() => {
    if (!offered && owed.current) {
      owed.current = false;
      words.current?.focus();
    }
  }, [offered]);
  return (
    <span className="flex min-w-0 items-center gap-(--space-2) ps-(--space-2_5)">
      <Plate variant="plate" data-map-plate="credit" className="min-w-0">
        <span
          ref={words}
          id={id}
          role="status"
          aria-live="polite"
          tabIndex={-1}
          data-slot="body-map-aerial-credit"
          data-state={load}
          className="text-kick leading-none font-medium tracking-kick text-balance text-fg2 uppercase outline-none"
        >
          {aerialCreditLine(credit, load)}
        </span>
      </Plate>
      {offered && (
        <Button
          ref={setButton}
          size="xs"
          data-slot="body-map-aerial-retry"
          className="shrink-0 bg-map-plate"
          aria-describedby={id}
          aria-disabled={pending || undefined}
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
