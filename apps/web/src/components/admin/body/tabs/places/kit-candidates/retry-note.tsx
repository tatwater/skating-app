import type { ComponentProps, ReactNode } from 'react';

import { Button } from '@/components/kit/button';
import { Note, type NoteTone } from '@/components/kit/note';
import { cn } from '@/lib/utils';

/**
 * **A read that failed, and the way to ask again** — a kit candidate (B01-3, the Body console's
 * tabs): the kit `Note` saying what couldn't be read, with *Try again* under it.
 *
 * - **Gray by default.** A read that failed may well answer the next time, so it is something worth
 *   knowing, not something that waits on a person (`warn`) or won't recover (`bad`); a caller whose
 *   failure is either passes the tone.
 * - **Try again re-runs the read** — the caller's `onRetry`; the button is the kit's extra-small
 *   outlined action, a heading gap under the note's rule, at the note's start.
 * - **It is announced politely** (`role="status"` on the wrapper), once, when it appears.
 */

type RetryNoteProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** What couldn't be read, as a sentence ("Couldn’t read who asked."). */
  children: ReactNode;
  /** Ask again. */
  onRetry: () => void;
  /** The note's tone; gray unless the failure means more. */
  tone?: NoteTone;
};

function RetryNote({ children, onRetry, tone = 'default', className, ...props }: RetryNoteProps) {
  return (
    <div
      role="status"
      data-slot="retry-note"
      className={cn('flex min-w-0 flex-col items-start gap-heading', className)}
      {...props}
    >
      <Note tone={tone}>{children}</Note>
      <Button size="xs" data-slot="retry-note-action" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export { RetryNote, type RetryNoteProps };
