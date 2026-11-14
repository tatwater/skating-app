import type { ComponentProps, ReactNode } from 'react';

import { Button } from '@/components/kit/button';
import { Note } from '@/components/kit/note';
import { cn } from '@/lib/utils';

/**
 * **A read that failed, said in its own place** — a kit candidate (it wants to join
 * `components/kit/note.tsx`). The gray note (a failed read is not red: a second try may bring it
 * back, and nothing about it waits on a person) naming what couldn't be read, and *Try again*,
 * which runs the read afresh.
 *
 * - **It names the read, never the thing read about.** "The hazards couldn’t be read" is a fact
 *   about a request; it is never drawn as zero, as empty, or as the lake being clear.
 * - **Try again is a link-weight button** after the words, on the same line when it fits; it is
 *   absent when the caller has no way to read again.
 *
 * Tokens only: the Note's rule and ink, the kit Button's link face.
 */

type ReadFailedProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** What couldn't be read, as a sentence ("The hazards couldn’t be read"). */
  children: ReactNode;
  /** Run the read again. Absent: no button. */
  onRetry?: () => void;
};

function ReadFailed({ children, onRetry, className, ...props }: ReadFailedProps) {
  return (
    <Note
      data-slot="read-failed"
      className={cn('flex flex-wrap items-baseline gap-x-(--space-3) gap-y-(--space-1)', className)}
      {...props}
    >
      <span>{children}</span>
      {onRetry !== undefined && (
        <Button variant="link" size="xs" onClick={onRetry} data-slot="read-failed-retry">
          Try again
        </Button>
      )}
    </Note>
  );
}

export { ReadFailed, type ReadFailedProps };
