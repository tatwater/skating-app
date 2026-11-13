import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSpinnerThird } from '@fortawesome/sharp-regular-svg-icons';
import type { ComponentProps } from 'react';

import { Badge } from '@/components/kit/badge';
import { Button } from '@/components/kit/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/kit/popover';
import { cn } from '@/lib/utils';

import { clockSeconds, type LiveState } from './overviewModel';

/**
 * The live mark: a list that updates on its own wears it at its section's end (the audit feed),
 * as the status bar's lamp does for the connection.
 *
 * - **Live**: the kit's live badge — the white LED, glowing and breathing (still under reduced
 *   motion), and *Live*.
 * - **Checking**: a request is in flight — the LED dims and stops, *Checking*.
 * - **Not live**: quiet past three times the expected interval — the LED goes hollow, the words
 *   step back to *Not live*, and the plate offers a refresh.
 *
 * Hovering (or focusing) it opens a plate with *Last checked* to the second. It is a popover, not a
 * tooltip, because the quiet state's plate holds a button.
 */

const WORDS: Record<LiveState, string> = { live: 'Live', checking: 'Checking', off: 'Not live' };

type LiveMarkProps = Omit<ComponentProps<'button'>, 'children'> & {
  state: LiveState;
  /** When the list last heard from the server; `null` before it has. */
  lastCheckedAt: number | null;
  /** Catch up: the quiet state's plate offers it. */
  onRefresh?: () => void;
  /** The plate's open state, for a board that draws it open; otherwise hover and focus decide. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function LiveMark({
  state,
  lastCheckedAt,
  onRefresh,
  open,
  onOpenChange,
  className,
  ...props
}: LiveMarkProps) {
  return (
    <Popover
      modal={false}
      {...(open !== undefined && { open })}
      onOpenChange={(next) => onOpenChange?.(next)}
    >
      <PopoverTrigger
        openOnHover
        delay={120}
        data-slot="live-mark"
        data-state={state}
        aria-label={`${WORDS[state]} — when it last checked`}
        className={cn(
          'inline-flex cursor-default items-center border-0 bg-transparent p-0 outline-none',
          'rounded-control focus-visible:shadow-focus',
          className,
        )}
        {...props}
      >
        {/* The kit's live badge: lit while live, dim while checking, hollow (`off`) when not live. */}
        <Badge variant="live" tone={state === 'live' ? 'default' : state === 'off' ? 'off' : 'dim'}>
          {WORDS[state]}
        </Badge>
      </PopoverTrigger>
      <PopoverContent
        data-slot="live-plate"
        side="bottom"
        align="end"
        sideOffset={5}
        // Hovering only shows the plate; focus moves in only when a keyboard opened it.
        initialFocus={(type) => type === 'keyboard'}
        className="flex-row items-center gap-(--space-2) px-(--space-3) py-(--space-2) text-assist leading-none whitespace-nowrap text-fg2"
      >
        {state === 'checking' && (
          <>
            <FontAwesomeIcon
              data-slot="live-spinner"
              icon={faSpinnerThird}
              className="h-[1em] text-fg2 motion-safe:animate-spin"
            />
            <span>Checking</span>
            {lastCheckedAt !== null && <span aria-hidden="true">·</span>}
          </>
        )}
        {lastCheckedAt !== null && (
          <>
            <span>Last checked</span>
            <b
              data-slot="live-time"
              className="font-(family-name:--family-mono) font-medium tracking-value text-fg tabular-nums"
            >
              {clockSeconds(lastCheckedAt)}
            </b>
          </>
        )}
        {state === 'off' && (
          <>
            {lastCheckedAt !== null && <span aria-hidden="true">·</span>}
            <span>Refresh the page to catch up</span>
            <Button size="xs" className="ms-(--space-1)" onClick={onRefresh}>
              Refresh
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
