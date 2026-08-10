/**
 * Maintaining `waterBodies.summary` — the map card's denormalized counts (N6c Workstream E).
 *
 * ## Recomputed from the window, not incremented
 *
 * The plan describes this as a counter "bumped by `reports.create`, moderation transitions, and
 * hazard create/confirm/archive", generalizing the Phase 4 contribution counters. **A counter is the
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
 * ## ⚠ The caller invariant: pass the id off a STORED document, never off mutation args
 *
 * Review found this violated twice, in the two places it was easiest to violate. `reports.create`
 * and `hazards.create` both run their requested `waterBodyId` through `resolveSurvivor` before
 * storing — an offline draft can carry a body id that was merged away before the queue flushed
 * (D36/F2) — so the content lands on the canonical survivor while `args.waterBodyId` still names the
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
 * | the passage of time | nothing | the six-hourly `sweepAllBodySummaries` cron |
 *
 * The merge/unmerge pair sits in the lib rather than in its callers on purpose: `mergedIntoHazardId`
 * became a summary input only when the card started excluding tombstones, and the first attempt
 * covered the merge direction and forgot the unmerge. Putting the recompute beside the field write
 * means a third writer cannot be added without meeting it.
 *
 * **One deliberate omission.** `reports.renameSkateTimeToSkateEndTime` patches `skateEndTime`, but it
 * is the one-time Phase 5 field rename — already run, against reports far outside any card's window —
 * and the sweep would reconcile it within six hours regardless. Named here so its absence reads as a
 * decision rather than a miss.
 *
 * Nothing on the hazard *decay* path appears above, and that is correct: `hazardWeather` patches
 * `decayMultiplier` and `snowHidden` only. A decayed hazard is still an active hazard on the map, so
 * it is still one on the card.
 */

import {
  currentSeason,
  isInSeason,
  type SkateQuality,
  SUMMARY_RECENT_DAYS,
  summarizeQuality,
  topHazardTypes,
} from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

const DAY_MS = 86_400_000;

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
 * **Season-scoped, and this is the line that gets forgotten** (E4). The count is a *current-season*
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
   * The sweep pages `waterBodies` and therefore *has* every row it is about to recompute; without
   * this it would re-read each one, and a `waterBodies` doc carries its `polygon` — ~300 KB for
   * Champlain against a 1.8 KB average. Doubling the byte cost of the heaviest rows in a
   * transaction already reading a page of them is how the depth loader blew Convex's 16 MB read cap
   * at batch 8 of 1,611.
   */
  known?: Doc<'waterBodies'>,
): Promise<void> {
  const windowStart = now - SUMMARY_RECENT_DAYS * DAY_MS;
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
  if (!body) return;
  // **Skip the write when nothing changed.** A recompute runs on every report and hazard transition,
  // and a no-op patch is still a document write, a mutation conflict surface and a subscription
  // invalidation for every client watching this lake. Comparing `updatedAt` is deliberately excluded
  // from the comparison, or the check could never be true.
  if (summaryUnchanged(body.summary, summary)) return;
  await ctx.db.patch(waterBodyId, { summary });
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
