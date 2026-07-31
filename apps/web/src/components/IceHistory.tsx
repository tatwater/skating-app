import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  ADVISORY_DISCLAIMER,
  ADVISORY_HEADING,
  publicMinSeasonsFor,
  recurrenceAdvisory,
} from '@skating/core';
import { useQuery } from 'convex/react';

/**
 * *Ice history* — what several winters said about one spot (N5c / §9, D78).
 *
 * **It is not a hazard, and every difference from one is deliberate.** No pin, no halo, no confirm
 * buttons, no freshness chip, no decay. It sits above the hazard list rather than among the pins,
 * because the map is where a mark means *somebody reported this* and an advisory has no reporter this
 * season. It never enters the on-ice payload — structurally, since it comes from a query the proximity
 * path never subscribes to, rather than by a guard somebody could remove.
 *
 * **It renders nothing today, and that is the shipped state.** `RECURRENCE_ADVISORIES_PUBLIC` is off,
 * so the server's public read returns an empty list whatever the corpus holds. The flag flips when the
 * operator queue has been read across at least two rollovers and the clusters at the current bar look
 * like real patterns — a judgement from `/admin/recurrence`, not a date.
 *
 * The server also decides when this **yields**: a pin reported this season inside a cluster has a date,
 * a reporter and a confirm loop, and is better than history in every respect, so the cluster stands
 * down rather than competing with it.
 */
export function IceHistory({ waterBodyId }: { waterBodyId: string }) {
  const clusters = useQuery(api.recurrence.listForBody, {
    waterBodyId: waterBodyId as Id<'waterBodies'>,
  });
  if (!clusters || clusters.length === 0) return null;

  const lines = clusters
    .map((cluster) =>
      recurrenceAdvisory({
        family: cluster.family,
        seasonsObserved: cluster.seasonsObserved.length,
        windowSeasons: cluster.windowSeasons,
        ...(cluster.subAreaName !== undefined ? { subAreaName: cluster.subAreaName } : {}),
        firstReportedDayOfSeasonP25: cluster.firstReportedDayOfSeasonP25,
        firstReportedDayOfSeasonP75: cluster.firstReportedDayOfSeasonP75,
        // The timing clause clears the same bar the advisory does, so raising the constant makes both
        // claims more conservative together (D78). A cluster only just over the line says how many
        // winters and no more.
        showTiming: cluster.seasonsObserved.length > publicMinSeasonsFor(cluster.family),
      }),
    )
    .filter((line): line is string => line !== null);
  if (lines.length === 0) return null;

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border bg-surface-muted p-3">
      <h3 className="font-semibold text-foreground text-sm">{ADVISORY_HEADING}</h3>
      <ul className="flex flex-col gap-1 text-foreground text-sm">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {/* The line that closes the gap a reader would otherwise fill in themselves. Not small print:
          a history panel with nothing beneath it reads as "and it's here now" unless something says
          otherwise, and that inversion is the one D3 exists to prevent. */}
      <p className="text-foreground-muted text-xs">{ADVISORY_DISCLAIMER}</p>
    </section>
  );
}
