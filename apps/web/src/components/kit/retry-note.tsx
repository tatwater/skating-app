import { type ComponentProps, type FocusEvent, type ReactNode, useEffect, useRef } from 'react';

import { Button } from '@/components/kit/button';
import { Note, type NoteTone } from '@/components/kit/note';
import { cn } from '@/lib/utils';

/**
 * **A read that failed, said in its own place, with *Try again*** — the kit `Note` (gray: a second
 * try may well answer, and nothing about it waits on a person; a caller whose failure means more
 * passes a tone) and the kit's extra-small button under it, which runs the read again.
 *
 * - **It names the read, never the thing read about.** "The history couldn’t be read" is a fact
 *   about a request — never drawn as zero, as empty, or (for a hazard) as the lake being clear.
 *   The server's error goes to Sentry, not here.
 * - **It is a live region that stays mounted.** Render it always, with words only while a read has
 *   failed: the empty region is in the page before the failure, so the words put into it are
 *   announced (politely) — a region mounted already holding its text often is not. Empty, it draws
 *   nothing.
 * - **Pending, after *Try again*:** the button says *Trying again…* and does nothing more until the
 *   fresh answer arrives — the note is held, never re-shown as the old failure. The button stays
 *   focusable (`aria-disabled`, not `disabled`), so focus isn't dropped; and when the read recovers
 *   and the words go, focus that was in the note moves to the region, not to the page.
 * - **No shortcut of its own**: a button in the tab order.
 */

type RetryNoteProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** What couldn't be read, as a sentence; nothing while nothing failed. */
  children?: ReactNode;
  /** Runs the read again. Absent: no button (a failure nothing can retry). */
  onRetry?: (() => void) | undefined;
  /** Tried again, waiting on the fresh answer. */
  pending?: boolean;
  /** The note's tone; gray unless the failure means more. */
  tone?: NoteTone;
};

function RetryNote({
  children,
  onRetry,
  pending = false,
  tone = 'default',
  className,
  onFocus,
  onBlur,
  ...props
}: RetryNoteProps) {
  const region = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const shown = children !== undefined && children !== null && children !== false;
  useEffect(() => {
    // The words went while focus was in the note: keep focus here rather than drop it to the page.
    if (!shown && focused.current) region.current?.focus();
  }, [shown]);
  return (
    <div
      ref={region}
      role="status"
      aria-live="polite"
      tabIndex={-1}
      data-slot="retry-note"
      data-state={shown ? (pending ? 'pending' : 'failed') : 'idle'}
      className={cn(
        'min-w-0 outline-none',
        shown && 'flex flex-col items-start gap-heading',
        className,
      )}
      onFocus={(event: FocusEvent<HTMLDivElement>) => {
        focused.current = true;
        onFocus?.(event);
      }}
      onBlur={(event: FocusEvent<HTMLDivElement>) => {
        focused.current = event.currentTarget.contains(event.relatedTarget as Node | null);
        onBlur?.(event);
      }}
      {...props}
    >
      {shown && (
        <>
          <Note tone={tone}>{children}</Note>
          {onRetry !== undefined && (
            <Button
              size="xs"
              data-slot="retry-note-action"
              aria-disabled={pending || undefined}
              onClick={() => {
                if (!pending) onRetry();
              }}
            >
              {pending ? 'Trying again…' : 'Try again'}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

export { RetryNote, type RetryNoteProps };
