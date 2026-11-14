import { RetryNote } from '@/components/kit/retry-note';
import { SkeletonText } from '@/components/kit/skeleton';
import { cn } from '@/lib/utils';
import { listWords } from '@/lib/words';

/**
 * How the Body console's tabs (Names, Places, Access, Water) draw a read's states in place:
 * *Not recorded yet* for a `null`, a skeleton while it loads, *Couldn't be read* where it failed —
 * never a blank where a fact would be — a count that says when its read stopped short, and one note
 * at the top of the tab naming everything that failed, with *Try again*.
 */

/** The words for a fact no read records yet. */
export const NOT_RECORDED = 'Not recorded yet';

/** The words in the place of a fact whose read failed. */
export const COULDNT_READ = 'Couldn’t be read';

const ASSIST = 'text-assist leading-list text-fg3';

/** A fact no read records yet, said so. */
export function NotRecorded({ className }: { className?: string }) {
  return (
    <span data-slot="not-recorded" className={cn(ASSIST, className)}>
      {NOT_RECORDED}
    </span>
  );
}

/** A fact whose read failed, said so in its place (the tab's note says it with *Try again*). */
export function CouldntRead({ className }: { className?: string }) {
  return (
    <span data-slot="read-failed" className={cn(ASSIST, className)}>
      {COULDNT_READ}
    </span>
  );
}

/** A line of placeholder in a fact's place while its read is on its way. */
export function LoadingLine({ width = '8rem' }: { width?: string }) {
  return <SkeletonText width={width} className="text-row leading-list" />;
}

/**
 * The tab's one failure note, mounted always at the top of the tab (so its words are announced as
 * they come): everything that couldn't be read — or, when the tab's own record failed, that — with
 * *Try again*, which asks again for every read that failed; *Trying again…* until the answers land.
 * Empty while nothing failed.
 */
export function ReadFailures({
  failures,
  whole = null,
  onRetry,
  pending = false,
}: {
  failures: readonly string[];
  /** The whole tab failed: the sentence that says what ("Couldn’t read this body’s record."). */
  whole?: string | null;
  onRetry?: (() => void) | undefined;
  pending?: boolean;
}) {
  const words = whole ?? (failures.length > 0 ? `Couldn’t read ${listWords(failures)}.` : null);
  return (
    <RetryNote data-slot="read-failures" onRetry={onRetry} pending={pending}>
      {words}
    </RetryNote>
  );
}
