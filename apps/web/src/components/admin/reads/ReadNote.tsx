import type { ReactNode } from 'react';

import { RetryNote, type RetryNoteProps } from '@/components/kit/retry-note';

import { isFailed, type Loadable } from './consoleReads';

/**
 * The kit `RetryNote` for the console's reads: mounted always where a block's failure would be
 * said, and saying it (with *Try again*, which tries every failed read here again) only while one of
 * `reads` has failed — *Trying again…* while the fresh answer is on its way.
 */
export function ReadNote({
  reads,
  children,
  ...props
}: Omit<RetryNoteProps, 'children' | 'onRetry' | 'pending'> & {
  /** The reads the note speaks for. */
  reads: readonly Loadable<unknown>[];
  /** What couldn't be read, as a sentence. */
  children: ReactNode;
}) {
  const failed = reads.filter(isFailed);
  return (
    <RetryNote
      {...props}
      pending={failed.length > 0 && failed.every((f) => f.pending)}
      onRetry={
        failed.length > 0
          ? () => {
              for (const f of failed) f.retry();
            }
          : undefined
      }
    >
      {failed.length > 0 ? children : null}
    </RetryNote>
  );
}
