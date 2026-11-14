import { api } from '@skating/convex/api';
import { type Capability, metricDay, metricDayStart, seasonOf } from '@skating/core';
import { useQuery } from 'convex/react';
import { useMemo } from 'react';

import { seasonFromSummary } from '@/components/admin/season/seasonFacts';

import { useHeldRead } from '../shell/presence';
import type { OverviewHomeData } from './OverviewHome';
import {
  corpusExtrasFrom,
  corpusFromReviewCounts,
  feedFromActions,
  feedFromSystem,
  inboxFromOverview,
  machineryFromJobs,
  mergeFeed,
  peopleFromOverview,
} from './overviewData';

/** How many feed rows Home reads: more than a tall screen shows, well under the server's cap. */
export const FEED_LIMIT = 50;

/** The Home blocks the reads serve: everything but cost, which no read serves yet. */
export type HomeReads = Omit<OverviewHomeData, 'cost'>;

/**
 * Home's reads: the Inbox and People counts (`console.overview`), the Corpus tasks
 * (`waterBodies.reviewQueueCounts` and `console.corpusCounts`), Machinery
 * (`machinery.overviewJobs`), the season's four (`seasonWatch.homeSummary`) and the audit trail —
 * people's actions (`moderation.listActions`) and the machine's (`console.systemFeed`) in time
 * order.
 *
 * Each read is asked for only when the viewer holds its capability (`can`, the map the server gates
 * on); Machinery, which only an admin reads, is `'withheld'` from anyone else — the card is left
 * out, as support's lane is — rather than requested and refused. A block is `undefined` while its
 * read loads, and a server `null` stays `null` — *Not recorded yet*, never a zero.
 */
export function useOverviewHome({
  season,
  now,
  can,
}: {
  /** The season the season tiles read. */
  season: number;
  /**
   * The page's clock. Machinery reads it rounded to the minute, and the season tiles rounded to the
   * UTC day: a job falling late, or a new day the first-skate look ranges through, is the clock
   * moving, not a row, so the argument is what re-runs the read.
   */
  now: number;
  can: (capability: Capability) => boolean;
}): HomeReads {
  const canCorpus = can('corpus.read');
  const canMachinery = can('machinery.read');
  const canSeason = can('season.summary');
  const canAudit = can('audit.read');

  const overview = useQuery(api.console.overview, can('inbox.read') ? {} : 'skip');
  const reviewCounts = useQuery(api.waterBodies.reviewQueueCounts, canCorpus ? {} : 'skip');
  const corpusCounts = useQuery(api.console.corpusCounts, canCorpus ? {} : 'skip');
  const minute = Math.floor(now / 60_000) * 60_000;
  // Held through each minute's new subscription, so the card doesn't fall back to loading as it lands.
  const jobs = useHeldRead(
    useQuery(api.machinery.overviewJobs, canMachinery ? { now: minute } : 'skip'),
    !canMachinery,
  );
  // Held through the day's turn, as Machinery is through the minute's — but only for the season
  // asked for: a season just chosen loads, it never shows the last one's tiles meanwhile.
  const heldSummary = useHeldRead(
    useQuery(
      api.seasonWatch.homeSummary,
      canSeason ? { season, now: metricDayStart(metricDay(now)) } : 'skip',
    ),
    !canSeason,
  );
  const summary = heldSummary?.season === season ? heldSummary : undefined;
  const actions = useQuery(api.moderation.listActions, canAudit ? { limit: FEED_LIMIT } : 'skip');
  const system = useQuery(api.console.systemFeed, canAudit ? { limit: FEED_LIMIT } : 'skip');

  // Its own memo: the feed is a new array only when its rows change, so the live mark's *Last
  // checked* (which moves when the feed does) isn't moved by Machinery's minute or any other read.
  const feed = useMemo(
    () =>
      // The feed waits for people's rows; the machine's join them as soon as they land.
      actions
        ? mergeFeed(feedFromActions(actions), system ? feedFromSystem(system) : [], FEED_LIMIT)
        : undefined,
    [actions, system],
  );

  // A chosen season that is over: its tiles never waited.
  const past = season < seasonOf(now);

  return useMemo(() => {
    const facts = summary ? seasonFromSummary(summary, past) : undefined;
    // Every console viewer holds `season.summary`; were one not to, the tiles say *Not recorded yet*.
    const tile = <T>(value: T | undefined): T | undefined | null => (canSeason ? value : null);
    return {
      inbox: overview ? inboxFromOverview(overview.inbox) : undefined,
      people: overview ? peopleFromOverview(overview.people) : undefined,
      // The intake rows lead; the Corpus counts fill in what they carry once they land.
      // Held until both reads land: drawn from the intake rows alone, Duplicates would read rows
      // and then jump to decisions.
      corpus:
        reviewCounts && corpusCounts
          ? corpusFromReviewCounts(reviewCounts, corpusExtrasFrom(corpusCounts))
          : undefined,
      machinery: !canMachinery
        ? 'withheld'
        : jobs === undefined
          ? undefined
          : jobs === null
            ? null
            : machineryFromJobs(jobs),
      watch: tile(facts?.watch),
      winter: tile(facts?.winter),
      imagery: tile(facts?.imagery),
      firstSkate: tile(facts?.firstSkate),
      feed,
    };
  }, [overview, reviewCounts, corpusCounts, jobs, summary, feed, canMachinery, canSeason, past]);
}
