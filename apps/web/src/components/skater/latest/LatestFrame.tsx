import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { useChromeStore } from '@/stores/chromeStore';

import { PanelColumn } from '../panels/InsetCard';
import { LatestPhoneBar } from '../phone/LatestPhoneBar';

/**
 * Latest's three columns (board 4.1): filters left (272), the feed center (640), Recommended and
 * *Wanted near you* right (300), centered with 40 between. Each column scrolls on its own, so the
 * feed's scroll is the feed column's and nothing else's — which is what lets a report open **over
 * the center column** (4.5–4.7) while the feed under it keeps its place: the feed stays mounted, inert
 * behind the card, and is exactly where it was when the card closes.
 *
 * Layout only; every piece inside is the kit's or a composition's. Below `xl` the right column
 * steps out; below `md` (row 9) the page shows one column at a time, switched by the phone bar.
 */
export function LatestFrame({
  filters,
  feed,
  aside,
  report,
  filterCount = 0,
}: {
  filters: ReactNode;
  feed: ReactNode;
  aside: ReactNode;
  /** The report card over the center column, when `?report=` names one. */
  report?: ReactNode;
  /** How many filters are on: the phone bar shows it beside "Filters" (row 9). */
  filterCount?: number;
}) {
  const open = report !== undefined && report !== null;
  // Phone (row 9): one column at a time; an open report is over the feed, so the feed is the one.
  const chosen = useChromeStore((s) => s.latestPhonePane);
  const pane = open ? 'feed' : chosen;
  const phoneColumn = 'max-md:w-full max-md:flex-1 max-md:px-(--space-4) max-md:pt-(--space-4)';
  return (
    <div
      data-slot="skater-page"
      className="flex h-full min-h-0 justify-center gap-(--space-10) px-(--space-10) max-md:flex-col max-md:gap-0 max-md:px-0"
    >
      {!open && (
        <LatestPhoneBar filterCount={filterCount} className="px-(--space-4) pt-(--space-3_5)" />
      )}
      <aside
        aria-label="Filters"
        className={cn(
          'h-full min-h-0 w-[17rem] shrink-0 overflow-y-auto pt-(--space-7) pb-(--space-14)',
          pane === 'filters' ? phoneColumn : 'max-md:hidden',
        )}
      >
        {filters}
      </aside>
      <main
        aria-label="Latest"
        className={cn(
          'relative h-full min-h-0 w-[40rem] min-w-0 shrink',
          pane === 'feed' ? 'max-md:w-full max-md:flex-1' : 'max-md:hidden',
        )}
      >
        <div
          data-slot="latest-feed-scroll"
          inert={open || undefined}
          className="h-full overflow-y-auto pt-(--space-7) pb-(--space-14) max-md:px-(--space-4) max-md:pt-(--space-4)"
        >
          {feed}
        </div>
        {open && (
          <PanelColumn className="absolute inset-0 h-auto w-auto border-r-0 bg-transparent">
            {report}
          </PanelColumn>
        )}
      </main>
      <aside
        aria-label="Recommended and wanted"
        className={cn(
          'flex h-full min-h-0 w-[18.75rem] shrink-0 flex-col gap-(--space-6) overflow-y-auto pt-(--space-7) pb-(--space-14) max-xl:hidden',
          pane === 'wanted' && `max-md:flex ${phoneColumn}`,
        )}
      >
        {aside}
      </aside>
    </div>
  );
}
