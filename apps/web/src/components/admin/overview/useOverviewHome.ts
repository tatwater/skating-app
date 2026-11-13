import { api } from '@skating/convex/api';
import type { Capability } from '@skating/core';
import { useQuery } from 'convex/react';
import { useMemo } from 'react';

import { seasonFromSummary } from '@/components/admin/season/seasonFacts';

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
   * The page's clock. Machinery reads it, rounded to the minute: a job falling late is the clock
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
  const jobs = useQuery(api.machinery.overviewJobs, canMachinery ? { now: minute } : 'skip');
  const summary = useQuery(api.seasonWatch.homeSummary, canSeason ? { season } : 'skip');
  const actions = useQuery(api.moderation.listActions, canAudit ? { limit: FEED_LIMIT } : 'skip');
  const system = useQuery(api.console.systemFeed, canAudit ? { limit: FEED_LIMIT } : 'skip');

  return useMemo(() => {
    const facts = summary ? seasonFromSummary(summary) : undefined;
    // Every console viewer holds `season.summary`; were one not to, the tiles say *Not recorded yet*.
    const tile = <T>(value: T | undefined): T | undefined | null => (canSeason ? value : null);
    return {
      inbox: overview ? inboxFromOverview(overview.inbox) : undefined,
      people: overview ? peopleFromOverview(overview.people) : undefined,
      // The intake rows lead; the Corpus counts fill in what they carry once they land.
      corpus: reviewCounts
        ? corpusFromReviewCounts(reviewCounts, corpusCounts ? corpusExtrasFrom(corpusCounts) : {})
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
      // The feed waits for people's rows; the machine's join them as soon as they land.
      feed: actions
        ? mergeFeed(feedFromActions(actions), system ? feedFromSystem(system) : [], FEED_LIMIT)
        : undefined,
    };
  }, [
    overview,
    reviewCounts,
    corpusCounts,
    jobs,
    summary,
    actions,
    system,
    canMachinery,
    canSeason,
  ]);
}
