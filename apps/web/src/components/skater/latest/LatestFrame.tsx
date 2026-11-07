import type { ReactNode } from 'react';

import { PanelColumn } from '../panels/InsetCard';

/**
 * Latest's three columns (board 4.1): filters left (272), the feed center (640), Recommended and
 * *Wanted near you* right (300), centered with 40 between. Each column scrolls on its own, so the
 * feed's scroll is the feed column's and nothing else's — which is what lets a report open **over
 * the center column** (4.5–4.7) while the feed under it keeps its place: the feed stays mounted, inert
 * behind the card, and is exactly where it was when the card closes.
 *
 * Layout only; every piece inside is the kit's or a composition's. Below `xl` the right column
 * steps out (the phone pass, row 9, owns the narrow layouts).
 */
export function LatestFrame({
  filters,
  feed,
  aside,
  report,
}: {
  filters: ReactNode;
  feed: ReactNode;
  aside: ReactNode;
  /** The report card over the center column, when `?report=` names one. */
  report?: ReactNode;
}) {
  const open = report !== undefined && report !== null;
  return (
    <div
      data-slot="skater-page"
      className="flex h-full min-h-0 justify-center gap-(--space-10) px-(--space-10)"
    >
      <aside
        aria-label="Filters"
        className="h-full min-h-0 w-[17rem] shrink-0 overflow-y-auto pt-(--space-7) pb-(--space-14) max-md:hidden"
      >
        {filters}
      </aside>
      <main aria-label="Latest" className="relative h-full min-h-0 w-[40rem] min-w-0 shrink">
        <div
          data-slot="latest-feed-scroll"
          inert={open || undefined}
          className="h-full overflow-y-auto pt-(--space-7) pb-(--space-14)"
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
        className="flex h-full min-h-0 w-[18.75rem] shrink-0 flex-col gap-(--space-6) overflow-y-auto pt-(--space-7) pb-(--space-14) max-xl:hidden"
      >
        {aside}
      </aside>
    </div>
  );
}
