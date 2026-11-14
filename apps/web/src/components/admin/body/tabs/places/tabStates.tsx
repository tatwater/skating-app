import { SkeletonText } from '@/components/kit/skeleton';
import { cn } from '@/lib/utils';

import { countText } from '../../../overview/overviewModel';
import { RetryNote } from './kit-candidates/retry-note';

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

/** A fact whose read failed, said so in its place. */
export function ReadFailed({ className }: { className?: string }) {
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

/** "the landmarks", "the landmarks and who asked", "a, b and c". */
export function listWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The tab's one failure note: what couldn't be read, and *Try again*, which asks again for every
 * read that failed. Nothing when nothing failed.
 */
export function ReadFailures({
  failures,
  onRetry,
}: {
  failures: readonly string[];
  onRetry: (() => void) | undefined;
}) {
  if (failures.length === 0) return null;
  const words = `Couldn’t read ${listWords(failures)}.`;
  return onRetry ? (
    <RetryNote onRetry={onRetry} data-slot="read-failures">
      {words}
    </RetryNote>
  ) : (
    <p data-slot="read-failures" className={ASSIST}>
      {words}
    </p>
  );
}

/**
 * A section's count when its read stopped short: "400+", in the section count's face — the kit
 * slug's `count` takes a whole number only (a kit extension asked for), so a floor rides its `end`.
 */
export function CappedCount({ count }: { count: number }) {
  return (
    <span
      data-slot="section-count"
      data-capped=""
      className="font-(family-name:--family-mono) text-kick leading-none font-medium tracking-micro text-fg2 tabular-nums"
    >
      {countText({ count, capped: true })}
    </span>
  );
}
