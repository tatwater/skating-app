import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  ADVISORY_DISCLAIMER,
  ADVISORY_HEADING,
  publicMinSeasonsFor,
  recurrenceAdvisory,
} from '@skating/core';
import { useQuery } from 'convex/react';
import { Paragraph, YStack } from 'tamagui';
import { Section } from './detailUi';

/**
 * *Ice history* — what several winters said about one spot (N5c / §9, D78). The mobile half of the
 * web component of the same name, reading the same server decision and the same core copy.
 *
 * **It is not a hazard**, and the differences are the design: no pin, no halo, no confirm loop, no
 * freshness, no decay. It never reaches the on-ice path — structurally, because that path subscribes
 * to `hazards.listForBody` and this reads `recurrence.listForBody`, so an advisory cannot become a
 * *"⚠ hazard ahead"* even by accident. That inversion — a statement about past winters turning into a
 * live warning about ice underfoot — is the single thing D3 most forbids.
 *
 * **It renders nothing today**: `RECURRENCE_ADVISORIES_PUBLIC` is off and the public read returns an
 * empty list whatever the corpus holds. Shipped dark on purpose, so the machinery can be watched
 * working before anybody is shown its output.
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
        // One constant governs the advisory and its timing clause, so raising it makes both claims
        // more conservative together (D78).
        showTiming: cluster.seasonsObserved.length > publicMinSeasonsFor(cluster.family),
      }),
    )
    .filter((line): line is string => line !== null);
  if (lines.length === 0) return null;

  return (
    <Section label={ADVISORY_HEADING}>
      <YStack gap="$1.5">
        {lines.map((line) => (
          <Paragraph key={line} color="$foreground" fontSize={13}>
            {line}
          </Paragraph>
        ))}
        {/* Not small print. A history panel with nothing beneath it reads as "and it's here now"
            unless something says otherwise. */}
        <Paragraph color="$foregroundMuted" fontSize={12}>
          {ADVISORY_DISCLAIMER}
        </Paragraph>
      </YStack>
    </Section>
  );
}
