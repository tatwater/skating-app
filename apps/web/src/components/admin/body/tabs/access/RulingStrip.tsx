import type { PublicAccessVerdict } from '@skating/core';
import { PersonLockup } from '@/components/kit/person-lockup';
import { dayMonthYear } from '../tabParts';
import { dayCount, daysSince, type Person, verdictWords } from './accessModel';

/**
 * The ruling's history as a static two-state strip (board 5.4.4, Review 14): two even halves,
 * whatever the dates — what stood before (a hollow mark, a dashed line: nobody had ruled, or the
 * ruling this one replaced) and the ruling in force (a filled square, a heavy line to Today). The
 * days it has stood are a label set into the heavy run, never its length. One-off to Access: the
 * strip map for an access alert's life (Inbox 2.6) is the general case, with any number of stations.
 */
export function RulingStrip({
  before,
  verdict,
  decidedAt,
  decidedBy,
  now,
}: {
  before: PublicAccessVerdict | null;
  verdict: PublicAccessVerdict;
  decidedAt: number;
  decidedBy: Person | null;
  now: number;
}) {
  const kick = 'text-kick leading-none font-medium tracking-kick uppercase';
  return (
    <div data-slot="ruling-strip" className="grid grid-cols-2 gap-y-(--space-1_5)">
      <span className={`${kick} text-fg3`}>Before</span>
      <span className="flex justify-between">
        <span className={`${kick} text-fg`} data-slot="ruling-date">
          {dayMonthYear(decidedAt)}
        </span>
        <span className={`${kick} text-fg3`}>Today</span>
      </span>
      <div aria-hidden="true" className="relative col-span-2 h-(--space-3_5)">
        <i className="absolute top-[2px] left-0 size-(--space-2_5) rounded-full bg-bg ring-1 ring-fg3 ring-inset" />
        <i className="absolute top-[6px] right-[calc(50%+0.625rem)] left-(--space-4) border-0 border-t border-dashed border-fg3" />
        <i className="absolute top-0 left-1/2 size-(--space-3_5) bg-fg shadow-[0_0_0_3px_var(--bg),0_0_0_4px_var(--fg)]" />
        <i className="absolute top-[5px] right-0 left-[calc(50%+1.5rem)] border-0 border-t-[3px] border-solid border-fg" />
        <span
          data-slot="ruling-days"
          className="absolute top-0 left-3/4 -translate-x-1/2 bg-bg px-(--space-1_5) font-(family-name:--family-mono) text-kick leading-(--space-3_5) text-fg"
        >
          {dayCount(daysSince(decidedAt, now))}
        </span>
        <i className="absolute top-0 right-0 h-(--space-3_5) w-px bg-fg" />
      </div>
      <span className="text-row leading-(--lead-snug) font-medium text-fg2">
        {verdictWords(before)}
      </span>
      <span className="flex flex-col items-start gap-(--space-1_5)">
        <span className="text-row leading-(--lead-snug) font-medium text-fg">
          {verdictWords(verdict)}
        </span>
        {decidedBy !== null && <PersonLockup name={decidedBy.name} />}
      </span>
    </div>
  );
}
