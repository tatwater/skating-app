import type { ComponentProps, ReactNode } from 'react';

import { Button } from '@/components/kit/button';
import { Note } from '@/components/kit/note';
import { cn } from '@/lib/utils';

/**
 * **A read that failed, said in its own place** — the kit `Note` (gray: something worth knowing,
 * never red at rest) with *Try again* beside it, which runs the read again. One block of a page
 * failing never takes the page with it: the block draws this where its content would be.
 *
 * - **The words are the block's**: what couldn't be read ("The history couldn’t be read"), never
 *   the server's error, which goes to Sentry instead.
 * - **Try again is the only action**, an outlined button at the extra-small size, so the note sits
 *   in a list or a section without growing it. It stays pressable while the read runs again: the
 *   block shows its skeleton meanwhile.
 *
 * Tokens only; no page's props. A kit candidate from the Body console.
 */

type ReadFailedProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** What couldn't be read, as a sentence. */
  children: ReactNode;
  /** Runs the read again. */
  onRetry: () => void;
};

function ReadFailed({ children, onRetry, className, ...props }: ReadFailedProps) {
  return (
    <div
      {...props}
      data-slot="read-failed"
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-(--space-3) gap-y-(--space-2)',
        className,
      )}
    >
      <Note className="min-w-0 flex-1">{children}</Note>
      <Button variant="outline" size="xs" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export { ReadFailed, type ReadFailedProps };
