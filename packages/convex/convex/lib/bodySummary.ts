/**
 * Maintaining `waterBodies.summary` — the map card's denormalized counts (A06c Workstream 5).
 *
 * ## Recomputed from the window, not incremented
 *
 * The plan describes this as a counter "bumped by `reports.create`, moderation transitions, and
 * hazard create/confirm/archive", generalizing the Phase 04 contribution counters. **A counter is the
 * wrong shape for half of what the card carries**, and the reason is worth stating because
 * `contributionCounts.ts` sitting next door makes the counter look like the obvious pattern:
 *
 * - A profile's `reportCount` is a lifetime total. Every event that changes it is a ±1, and nothing
 *   changes it *by the passage of time*.
 * - This summary is **window-scoped and season-scoped**. A report aging out of the 14-day window
 *   decrements the count with no event to hang the decrement on, and — worse — it changes the
 *   *mean* behind the D86 dots, which cannot be maintained incrementally at all. You cannot remove a
 *   value from a mean without knowing which value left.
 *
 * So each write recomputes the body's summary from its recent rows. That is bounded work: the read
 * is an index range over one body's reports inside a 14-day window, which is a handful of rows even
 * on the busiest lake, and it is exact by construction rather than exact-until-a-path-is-missed.
 * The cron sweep then handles pure time decay, which has no write to ride on.
 *
 * ## The sweep reads only what is due
 *
 * Each recompute also records **when time will next change the card** (`summaryRefreshAt`: the
 * oldest report it read leaving the window, or the season's end, whichever is first) in
 * `bodySummaryRefreshes`, in the same transaction. The sweep reads the rows that are due and
 * recomputes those bodies, so its cost follows the cards that can change rather than the corpus:
 * it used to page all ~25,000 bodies, polygons included, to find the ~200 with a card. A card with
 * no report in the window has no row — its hazards change only on a write — and is never swept.
 * The full walk (`sweepAllBodySummaries`) remains, as the backfill that fills the table once and as
 * a repair.
 *
 * ## ⚠ The caller invariant: pass the id off a STORED document, never off mutation args
 *
 * Review found this violated twice, in the two places it was easiest to violate. `reports.create`
 * and `hazards.create` both run their requested `waterBodyId` through `resolveSurvivor` before
 * storing — an offline draft can carry a body id that was merged away before the queue flushed
 * (D36, Phase 02a §6.2) — so the content lands on the canonical survivor while `args.waterBodyId` still names the
 * loser. Recomputing the argument refreshes a row nothing renders, because a merged body is
 * unlisted, and leaves the card a skater is actually looking at stale until the sweep.
 *
 * Every call site now reads its id from something already written: `body._id` after
 * `resolveSurvivor`, `stored.waterBodyId` off the inserted hazard, `existing.waterBodyId` off the
 * report being edited, `onBody.waterBodyId` off the moderated document. **If you are about to pass
 * something that came from `args`, resolve it first.**
 *
 * ## The one write path that has no content mutation to ride on
 *
 * `waterBodies.merge` re-points the loser's reports and hazards onto the survivor. That changes both
 * bodies' counts without touching a single report or hazard row, so it is invisible to every rule
 * above and calls this directly for both bodies. It is the exception worth knowing about, because
 * anything else that moves content between bodies wholesale will need the same treatment.
 *
 * ## The complete writer set, audited 2026-08-10
 *
 * Every production path that can change what this function would return, and where it recomputes:
 *
 * | input | writers | covered by |
 * | --- | --- | --- |
 * | `reports.skateEndTime` / `skateQuality` | `reports.create`, `reports.update` | both call directly |
 * | `reports.moderationStatus` | `moderation.setStatus` | calls directly |
 * | `hazards.status` | `hazardConfirmations` (the archive vote) | calls directly |
 * | `hazards.moderationStatus` | `moderation.setStatus` | calls directly |
 * | **`hazards.mergedIntoHazardId`** | `applyMerge`, `unmergeHazard` | **`lib/hazardMerge.ts`, beside each write** |
 * | which body content belongs to | `waterBodies.merge` | calls directly, for both bodies |
 * | the passage of time | nothing | the hourly `sweepDueBodySummaries` cron, due rows only |
 *
 * The merge/unmerge pair sits in the lib rather than in its callers on purpose: `mergedIntoHazardId`
 * became a summary input only when the card started excluding tombstones, and the first attempt
 * covered the merge direction and forgot the unmerge. Putting the recompute beside the field write
 * means a third writer cannot be added without meeting it.
 *
 * **One deliberate omission.** `reports.renameSkateTimeToSkateEndTime` patches `skateEndTime`, but it
 * is the one-time Phase 05 field rename — already run, against reports far outside any card's window.
 * Named here so its absence reads as a decision rather than a miss.
 *
 * Nothing on the hazard *decay* path appears above, and that is correct: `hazardWeather` patches
 * `decayMultiplier` and `snowHidden` only. A decayed hazard is still an active hazard on the map, so
 * it is still one on the card.
 */

import {
  currentSeason,
  isInSeason,
  type SkateQuality,
  summarizeQuality,
  summaryRefreshAt,
  summaryWindowStart,
  topHazardTypes,
} from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { refreshBodyLibrary } from './bodyLibrary';

/**
 * How many recent rows the recompute will read per body.
 *
 * A ceiling rather than an expectation: the busiest body in the corpus has single-digit reports in a
 * fortnight. It exists so that a body which somehow accumulates thousands cannot turn one report
 * creation into an unbounded read — the same instinct behind every other cap in this codebase, and
 * the reason `listInViewport` needed two fixes.
 */
const MAX_SUMMARY_ROWS = 200;

/**
 * Recompute and store one body's summary.
 *
 * **Season-scoped, and this is the line that gets forgotten** (A06c §5.4). The count is a *current-season*
 * count: a card must never carry last winter's numbers into November, when the lake is open water
 * and the number is a lie that looks like news. The window and the season are both applied, and the
 * season is the stricter of the two every autumn.
 */
export async function recomputeBodySummary(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  now: number = Date.now(),
  /**
   * The body doc, when the caller already holds it.
   *
   * The full walk pages `waterBodies` and therefore *has* every row it is about to recompute; without
   * this it would re-read each one, and a `waterBodies` doc carries its `polygon` — ~300 KB for
   * Champlain against a 1.8 KB average. Doubling the byte cost of the heaviest rows in a
   * transaction already reading a page of them is how the depth loader blew Convex's 16 MB read cap
   * at batch 8 of 1,611.
   */
  known?: Doc<'waterBodies'>,
  /**
   * Also refresh the body's Bodies library row (B01-3): its reports this season, whether it was
   * ever reported, and the put-ins its reports derive. On for every report write that calls this;
   * the summary sweeps pass `false` — the passage of time moves none of those figures inside a
   * season, and their pages are sized for the card alone. No library fact counts hazards, so the
   * hazard writes could pass `false` too; their call sites are in files the author-deletion PR is
   * rewriting, so until it lands they pay a refresh that writes nothing.
   */
  library = true,
): Promise<void> {
  const windowStart = summaryWindowStart(now);
  const season = currentSeason(now);

  const reports = await ctx.db
    .query('reports')
    .withIndex('by_water_body_skate_end_time', (q) =>
      q.eq('waterBodyId', waterBodyId).gte('skateEndTime', windowStart),
    )
    .order('desc')
    .take(MAX_SUMMARY_ROWS);

  const visible = reports.filter(
    (report) => report.moderationStatus === 'visible' && isInSeason(report.skateEndTime, season),
  );

  const hazards = await ctx.db
    .query('hazards')
    .withIndex('by_water_body_status', (q) =>
      q.eq('waterBodyId', waterBodyId).eq('status', 'active'),
    )
    .take(MAX_SUMMARY_ROWS);

  // **A merged-away tombstone is not a second hazard.** D80's auto-merge sets `mergedIntoHazardId`
  // and deliberately leaves `status`/`moderationStatus` alone — the row stays `active` and `visible`
  // so a link to it still resolves — so filtering on those two alone counts one ridge twice the
  // moment two skaters pin it. The map's own renderer already excludes them
  // (`hazards.ts`: `inScope.filter((h) => h.mergedIntoHazardId === undefined)`); the card has to
  // agree with the map it sits on, or it claims two hazards over a lake showing one pin.
  //
  // It is worse than a wrong count: `topHazardTypes` is capped at three, so a duplicated type can
  // push a genuinely different one off the card entirely.
  const visibleHazards = hazards.filter(
    (hazard) => hazard.moderationStatus === 'visible' && hazard.mergedIntoHazardId === undefined,
  );

  const qualities: (SkateQuality | undefined)[] = visible.map((report) => report.skateQuality);
  const latestReportAt = visible[0]?.skateEndTime;

  const summary = {
    recentReportCount: visible.length,
    topHazardTypes: topHazardTypes(visibleHazards.map((hazard) => hazard.type)),
    ...(latestReportAt !== undefined ? { latestReportAt } : {}),
    ...summarizeQuality(qualities),
    updatedAt: now,
  };

  const body = known ?? (await ctx.db.get(waterBodyId));
  // The sweep's work list moves with the card, in the same transaction, whether or not the card
  // itself changed: every report this read is a report that will age out, and a stale `refreshAt`
  // is a card the sweep never revisits. Every report read counts, not just the ones the card shows
  // (see `summaryRefreshAt`) — an early refresh is one cheap recompute, a late one a stale card.
  await syncSummaryRefresh(
    ctx,
    waterBodyId,
    body
      ? summaryRefreshAt(
          reports.map((report) => report.skateEndTime),
          now,
        )
      : null,
  );
  if (!body) return;
  // The body in hand, never a second read of its polygon (see `known`). The summary this writes is no
  // part of the library row, so the doc read before the patch below is current for it.
  if (library) await refreshBodyLibrary(ctx, waterBodyId, { now, known: body });
  // **Skip the write when nothing changed.** A recompute runs on every report and hazard transition,
  // and a no-op patch is still a document write, a mutation conflict surface and a subscription
  // invalidation for every client watching this lake. Comparing `updatedAt` is deliberately excluded
  // from the comparison, or the check could never be true.
  if (summaryUnchanged(body.summary, summary)) return;
  await ctx.db.patch(waterBodyId, { summary });
}

/**
 * Make `bodySummaryRefreshes` say `refreshAt` for this body: one row, or none for `null`.
 *
 * Reads every row the body has (a handful at most — there is meant to be one) rather than
 * `.unique()`, so a duplicate left by anything at all is folded away here instead of throwing on
 * every report written to that lake. Writes only on a change, like the card.
 */
async function syncSummaryRefresh(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  refreshAt: number | null,
): Promise<void> {
  const rows = await ctx.db
    .query('bodySummaryRefreshes')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
    .take(8);
  const [keep, ...extra] = rows;
  for (const row of extra) await ctx.db.delete(row._id);
  if (refreshAt === null) {
    if (keep) await ctx.db.delete(keep._id);
    return;
  }
  if (!keep) {
    await ctx.db.insert('bodySummaryRefreshes', { waterBodyId, refreshAt });
  } else if (keep.refreshAt !== refreshAt) {
    await ctx.db.patch(keep._id, { refreshAt });
  }
}

/** Whether two summaries say the same thing, ignoring when they were computed. */
function summaryUnchanged(
  previous: { recentReportCount: number; topHazardTypes: string[] } | undefined,
  next: { recentReportCount: number; topHazardTypes: string[] },
): boolean {
  if (!previous) return false;
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  return (
    before.recentReportCount === after.recentReportCount &&
    before.latestReportAt === after.latestReportAt &&
    before.qualityDots === after.qualityDots &&
    before.qualityCount === after.qualityCount &&
    previous.topHazardTypes.join(',') === next.topHazardTypes.join(',')
  );
}
