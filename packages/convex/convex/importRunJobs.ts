/**
 * **The run list's backfill** (D341, B01-8a): `importRunJobs:backfillListed`, run once on a
 * deployment after B01-8a lands.
 *
 * Two jobs in one walk over `importRuns` (`by_started`, oldest first, one `.paginate()` a pass):
 *
 * 1. **`listedIn`** on every row written before `start` derived it: `corpus` for a corpus kind with no
 *    parent, absent on a campaign's own passes — exactly what `start` writes today
 *    (`importRuns.listedInOf`).
 * 2. **A reconstructed campaign row** for every campaign from before B01-8a (the founder's ruling on
 *    fork 3: written once, not assembled at every read). One `corpus_campaign` row per `campaignId`
 *    whose script passes have no campaign row, built **only from what its pass rows prove**: the
 *    earliest start, the latest finish (none while a pass is still `running`), the status its passes
 *    give (`failed` if any failed, else `running` if any runs, else `succeeded`), the deployment of its
 *    first pass. Its flags, plan, exit status and heartbeat were never recorded and stay so — `flags`
 *    and `plan` empty with `campaign.reconstructed: true`, no `progressAt` — so the page reads *Not
 *    recorded*, never "none". Its script passes get `parentRunId` and leave the list, as a live
 *    campaign's do; the by-hand passes (`prune-floor`, `seed-standing`, `retire-absorbed`) keep their
 *    own rows in the list, matched to their campaign by `campaignId`, as they are after B01-8a.
 *
 * **Never touches a campaign that has its own row**: a `campaignId` with a `corpus_campaign` row not
 * marked reconstructed is left exactly as it is (its passes only get `listedIn`, as any row does).
 *
 * **Idempotent and resumable.** Every write is "set it to what the rows prove", compared first, so a
 * second run writes nothing; a pass interrupted part-way is safe to run again from its cursor or from
 * the start. A campaign's aggregate is recomputed from all its rows (`by_campaign`, bounded), so a
 * campaign whose passes straddle two pages comes out the same whichever page reached it.
 *
 * `pnpm exec convex run importRunJobs:backfillListed '{"dryRun":true}'`, then without `dryRun`. Each
 * pass logs its tally and schedules the next until the table is walked.
 */

import { CORPUS_RUN_PLAN } from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { listedInOf } from './importRuns';

/**
 * Rows a pass reads (the page): a few hundred rows on dev is a handful of passes. Bounded by the
 * worst page: every row a different campaign at {@link BACKFILL_CAMPAIGN_READ} script passes, so a
 * pass reads one range per campaign and one per pass it links (a patch reads its row) — 50 × 61 is
 * 3,050 ranges, under the backend's 4,096 with its start cost. At 100 a real backend refused the
 * page ("Too many reads", 6,100 ranges).
 */
export const BACKFILL_PAGE = 50;
/**
 * The most rows one campaign's aggregate reads (`by_campaign`). A campaign is seven script passes
 * and three by hand, re-runs included: tens at most. One past this is refused for that campaign
 * (tallied as `campaignsTooLarge`) rather than rebuilt from a part of its rows.
 */
export const BACKFILL_CAMPAIGN_READ = 60;

/** The kinds `run-corpus.sh` itself runs: the passes a campaign row is the parent of. */
const SCRIPT_PASS_KINDS: ReadonlySet<string> = new Set(
  CORPUS_RUN_PLAN.filter((p) => p.by === 'script').map((p) => p.kind),
);

export type BackfillTally = {
  scanned: number;
  /** Rows whose `listedIn` was set or cleared. */
  listed: number;
  /** Reconstructed campaign rows written for the first time. */
  campaignsCreated: number;
  /** Reconstructed campaign rows whose aggregate moved (a pass found on a later page). */
  campaignsUpdated: number;
  /** Passes given their campaign row as `parentRunId`. */
  passesLinked: number;
  /** Campaigns with their own row, left untouched. */
  campaignsKept: number;
  /** Campaigns past `BACKFILL_CAMPAIGN_READ` rows, left untouched. */
  campaignsTooLarge: number;
};

const emptyTally = (): BackfillTally => ({
  scanned: 0,
  listed: 0,
  campaignsCreated: 0,
  campaignsUpdated: 0,
  passesLinked: 0,
  campaignsKept: 0,
  campaignsTooLarge: 0,
});

/** What a reconstructed campaign row holds, as its passes prove it. */
type Aggregate = Pick<
  Doc<'importRuns'>,
  'status' | 'startedAt' | 'finishedAt' | 'deployment' | 'isProd'
>;

/** The campaign its passes prove: see the module note. `passes` is non-empty, oldest first. */
export function aggregateOfPasses(passes: readonly Doc<'importRuns'>[]): Aggregate {
  const first = passes[0] as Doc<'importRuns'>;
  const running = passes.some((p) => p.status === 'running');
  const status = passes.some((p) => p.status === 'failed')
    ? 'failed'
    : running
      ? 'running'
      : 'succeeded';
  return {
    status,
    startedAt: Math.min(...passes.map((p) => p.startedAt)),
    finishedAt: running ? undefined : Math.max(...passes.map((p) => p.finishedAt ?? p.startedAt)),
    deployment: first.deployment,
    isProd: first.isProd,
  };
}

const sameAggregate = (row: Doc<'importRuns'>, agg: Aggregate) =>
  row.status === agg.status &&
  row.startedAt === agg.startedAt &&
  row.finishedAt === agg.finishedAt &&
  row.deployment === agg.deployment &&
  row.isProd === agg.isProd;

/** Rebuild (or write) one campaign's reconstructed row and link its script passes to it. */
async function backfillCampaign(
  ctx: MutationCtx,
  campaignId: string,
  page: ReadonlySet<Id<'importRuns'>>,
  dryRun: boolean,
  tally: BackfillTally,
): Promise<'rebuilt' | 'kept'> {
  const rows = await ctx.db
    .query('importRuns')
    .withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
    .take(BACKFILL_CAMPAIGN_READ + 1);
  if (rows.length > BACKFILL_CAMPAIGN_READ) {
    tally.campaignsTooLarge++;
    return 'kept';
  }
  const campaigns = rows.filter((r) => r.kind === 'corpus_campaign');
  if (campaigns.some((c) => c.campaign?.reconstructed !== true)) {
    // ⚠ A campaign with its own row is the script's record: never rebuilt, never re-parented.
    tally.campaignsKept++;
    return 'kept';
  }
  const existing = campaigns[0] ?? null;
  // Its script passes: those with no parent, or already this reconstructed row's (a re-run).
  const passes = rows.filter(
    (r) =>
      SCRIPT_PASS_KINDS.has(r.kind) &&
      (r.parentRunId === undefined || (existing !== null && r.parentRunId === existing._id)),
  );
  if (passes.length === 0) return 'rebuilt';
  const agg = aggregateOfPasses(passes);
  let campaignRunId: Id<'importRuns'> | null = existing?._id ?? null;
  if (existing === null) {
    // A dry run writes nothing, so it would meet the same campaign on every page that holds one of
    // its passes: it counts the campaign on the page that holds its first. A real run writes it on
    // the first page that reaches it, whichever pass that is.
    if (dryRun && !page.has((passes[0] as Doc<'importRuns'>)._id)) return 'rebuilt';
    tally.campaignsCreated++;
    if (!dryRun) {
      campaignRunId = await ctx.db.insert('importRuns', {
        kind: 'corpus_campaign',
        label: `Corpus campaign ${campaignId}`,
        campaignId,
        ...agg,
        counts: [],
        stages: [],
        failures: [],
        failuresTotal: 0,
        listedIn: 'corpus',
        campaign: { flags: [], plan: [], reconstructed: true },
      });
    }
  } else if (!sameAggregate(existing, agg)) {
    tally.campaignsUpdated++;
    if (!dryRun) await ctx.db.patch(existing._id, agg);
  }
  for (const pass of passes) {
    if (pass.parentRunId !== undefined) continue;
    tally.passesLinked++;
    if (!dryRun && campaignRunId !== null) {
      await ctx.db.patch(pass._id, { parentRunId: campaignRunId, listedIn: undefined });
    }
  }
  return 'rebuilt';
}

export const backfillListed = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    /** `false` runs one pass and stops (the tests step it); otherwise it schedules the next. */
    chain: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { dryRun = false, cursor = null, pageSize = BACKFILL_PAGE, chain = true },
  ): Promise<BackfillTally & { isDone: boolean; continueCursor: string }> => {
    const numItems = Math.min(BACKFILL_PAGE, Math.max(1, Math.floor(pageSize)));
    const result = await ctx.db
      .query('importRuns')
      .withIndex('by_started')
      .order('asc')
      .paginate({ cursor, numItems });
    const tally = emptyTally();
    const page = new Set(result.page.map((r) => r._id));
    const campaignIds: string[] = [];
    for (const row of result.page) {
      tally.scanned++;
      const pass =
        row.campaignId !== undefined &&
        row.parentRunId === undefined &&
        SCRIPT_PASS_KINDS.has(row.kind);
      if (pass) {
        if (!campaignIds.includes(row.campaignId as string)) {
          campaignIds.push(row.campaignId as string);
        }
        continue;
      }
      // Every other row lists as `start` would list it today.
      const listedIn = listedInOf(row.kind, row.parentRunId);
      if (row.listedIn !== listedIn) {
        tally.listed++;
        if (!dryRun) await ctx.db.patch(row._id, { listedIn });
      }
    }
    for (const campaignId of campaignIds) {
      const outcome = await backfillCampaign(ctx, campaignId, page, dryRun, tally);
      if (outcome === 'rebuilt') continue;
      // A campaign left as it is (its own row, or too large): its passes list as any row does.
      for (const row of result.page) {
        if (row.campaignId !== campaignId || row.parentRunId !== undefined) continue;
        if (!SCRIPT_PASS_KINDS.has(row.kind)) continue;
        const listedIn = listedInOf(row.kind, undefined);
        if (row.listedIn !== listedIn) {
          tally.listed++;
          if (!dryRun) await ctx.db.patch(row._id, { listedIn });
        }
      }
    }
    console.log(
      `importRunJobs:backfillListed${dryRun ? ' (dry run)' : ''}: ${JSON.stringify(tally)}${
        result.isDone ? ' · done' : ''
      }`,
    );
    if (chain && !result.isDone) {
      await ctx.scheduler.runAfter(0, internal.importRunJobs.backfillListed, {
        dryRun,
        cursor: result.continueCursor,
        pageSize: numItems,
      });
    }
    return { ...tally, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});
