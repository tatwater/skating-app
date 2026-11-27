/**
 * Which `importRuns` rows are a campaign's own — its merge or its load — and not a by-hand pass
 * that carries the campaign's id after it (a prune, `retire-absorbed`, a standing seed). One rule
 * for the Overview's *last campaign* (`console.corpusCounts`) and a corpus task's *Queued: By the
 * <day> campaign* (`lib/corpusTaskViews.ts`), so the two can't name different days.
 */
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';

/** The run kinds a campaign's merge and load write. */
export const CAMPAIGN_RUN_KINDS = ['corpus_merge', 'canonical_water'] as const;

/**
 * How far back a read looks past the passes that aren't a campaign's merge or load. A campaign
 * writes a handful of runs after its load (sub-areas, standing, retirements, prunes), so past this
 * many the read answers `null` rather than scan.
 */
export const CAMPAIGN_RUN_LOOKBACK = 20;

/**
 * A `retire-absorbed` row written before it had its own kind: `canonical_water`, labeled by
 * `scripts/etl/src/retireAbsorbed.ts` (with " (dry run)" after a dry one). It folds rows away, so it
 * is no campaign's load.
 */
export function isLegacyRetireRow(run: { kind: string; label: string }): boolean {
  return run.kind === 'canonical_water' && run.label.startsWith('retire absorbed duplicates');
}

/** Whether a run is a campaign's merge or load. */
export function isCampaignRun(run: Pick<Doc<'importRuns'>, 'kind' | 'label'>): boolean {
  return (CAMPAIGN_RUN_KINDS as readonly string[]).includes(run.kind) && !isLegacyRetireRow(run);
}

/**
 * The newest **succeeded** merge-or-load run of either kind, or `null` past the lookback — the
 * Overview's *last campaign*. A running merge or load is no campaign yet, and a failed one (marked
 * failed in the console included) didn't land, so neither names the last campaign (B01-8a).
 */
export async function lastCampaignRun(ctx: QueryCtx): Promise<Doc<'importRuns'> | null> {
  let last: Doc<'importRuns'> | null = null;
  for (const kind of CAMPAIGN_RUN_KINDS) {
    const recent = await ctx.db
      .query('importRuns')
      .withIndex('by_kind_started', (q) => q.eq('kind', kind))
      .order('desc')
      .take(CAMPAIGN_RUN_LOOKBACK);
    const run = recent.find(
      (r) => isCampaignRun(r) && r.status === 'succeeded' && r.markedFailed === undefined,
    );
    if (run && (last === null || run.startedAt > last.startedAt)) last = run;
  }
  return last;
}

/**
 * The newest merge-or-load run carrying `campaignId` — never a by-hand pass stamped with it later —
 * or `null` when none is within the lookback.
 */
export async function campaignRunOf(
  ctx: QueryCtx,
  campaignId: string,
): Promise<Doc<'importRuns'> | null> {
  const recent = await ctx.db
    .query('importRuns')
    .withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
    .order('desc')
    .take(CAMPAIGN_RUN_LOOKBACK);
  return recent.find(isCampaignRun) ?? null;
}

/**
 * The **first** merge-or-load run carrying `campaignId` — when the campaign's corpus was written —
 * never its region build, its campaign row (B01-8a), or a by-hand pass stamped with it later; `null`
 * when none is within the lookback. A body's *outline trusted since* (register Co11).
 */
export async function firstCampaignRunOf(
  ctx: QueryCtx,
  campaignId: string,
): Promise<Doc<'importRuns'> | null> {
  const early = await ctx.db
    .query('importRuns')
    .withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
    .take(CAMPAIGN_RUN_LOOKBACK);
  return early.find(isCampaignRun) ?? null;
}
