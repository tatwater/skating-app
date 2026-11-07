import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { useChromeStore } from '@/stores/chromeStore';

import { PanelDrawerHost } from '../panels/PanelDrawer';
import { LatestPhoneBar } from '../phone/LatestPhoneBar';
import { useIsMidWidth } from '../phone/usePhoneLayout';

/**
 * Latest's three columns (board 4.1): filters left (272), the feed center (640), Recommended and
 * *Wanted near you* right (300), centered with 40 between. Each column scrolls on its own, so the
 * feed's scroll is the feed column's and nothing else's — which is what lets a report open as a
 * **drawer from the right** over a scrim on the whole page (4.5–4.7) while the feed under it keeps
 * its place: the feed stays mounted, inert under the scrim, and is exactly where it was when the
 * drawer closes. The page is the drawer's host (`PanelDrawerHost`), so the top bar stays lit.
 *
 * Layout only; every piece inside is the kit's or a composition's. Below `xl` the right column
 * steps out; below `md` (row 9) the page shows one column at a time, switched by the phone bar.
 *
 * Recommended never steps out with it (D50): its reports are subtracted from the feed, so a hidden
 * strip would hide them everywhere. Between `md` and `xl` it rides at the top of the feed column —
 * one copy, mounted where it shows; below `md` it stays in the right column the phone bar opens.
 */
export function LatestFrame({
  filters,
  feed,
  recommended,
  aside,
  report,
  filterCount = 0,
}: {
  filters: ReactNode;
  feed: ReactNode;
  /** The Recommended strip: the right column's head, or the feed's between `md` and `xl`. */
  recommended?: ReactNode;
  aside: ReactNode;
  /** The report drawer over the page, when `?report=` names one. */
  report?: ReactNode;
  /** How many filters are on: the phone bar shows it beside "Filters" (row 9). */
  filterCount?: number;
}) {
  const open = report !== undefined && report !== null;
  // Phone (row 9): one column at a time; an open report goes back to its row in the feed, so the
  // feed is the one under the drawer.
  const chosen = useChromeStore((s) => s.latestPhonePane);
  const pane = open ? 'feed' : chosen;
  const midWidth = useIsMidWidth();
  const phoneColumn = 'max-md:w-full max-md:flex-1 max-md:px-(--space-4) max-md:pt-(--space-4)';
  return (
    <PanelDrawerHost className="h-full min-h-0" drawer={open ? report : undefined}>
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
            'h-full min-h-0 w-[40rem] min-w-0 shrink',
            pane === 'feed' ? 'max-md:w-full max-md:flex-1' : 'max-md:hidden',
          )}
        >
          <div
            data-slot="latest-feed-scroll"
            inert={open || undefined}
            className="h-full overflow-y-auto pt-(--space-7) pb-(--space-14) max-md:px-(--space-4) max-md:pt-(--space-4)"
          >
            {midWidth && recommended && (
              <div data-slot="latest-recommended-lead" className="mb-(--space-6)">
                {recommended}
              </div>
            )}
            {feed}
          </div>
        </main>
        <aside
          aria-label="Recommended and wanted"
          className={cn(
            'flex h-full min-h-0 w-[18.75rem] shrink-0 flex-col gap-(--space-6) overflow-y-auto pt-(--space-7) pb-(--space-14) max-xl:hidden',
            pane === 'wanted' && `max-md:flex ${phoneColumn}`,
          )}
        >
          {!midWidth && recommended}
          {aside}
        </aside>
      </div>
    </PanelDrawerHost>
  );
}
