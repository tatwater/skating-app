/**
 * The `reportSubAreas` join — a report's bay memberships as rows an index can see (A09 / D175).
 *
 * `reports.subAreaIds` is the membership; this is its indexable copy, because Convex cannot index
 * an array and two readers need to find a spanning report under its *second* bay: the bay-scoped
 * feed (`reports.listByWaterBody`) and the bay bounty gate (`bounties.recentReports`). The row
 * carries mirrors of `moderationStatus` and `skateEndTime` so both reads apply their gate and their
 * range *in* the index, which is the same reason the body-scoped report index keeps them there.
 *
 * **Every writer of the mirrored fields goes through here**, and the list is short by design:
 * `reports.create` / `update` (membership + skate time), `moderation.setModerationStatus` (status),
 * `subAreas.restampParent` (membership) and `waterBodies.merge` (`waterBodyId`). A mirror kept by
 * hand in each of those would be the drift this module exists to make impossible.
 *
 * Reports are never deleted (D62 keeps and redacts them), so nothing here deletes a join row except
 * to replace it.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

/** The join rows for one report — bounded by the handful of bays a lake has. */
export async function loadReportSubAreas(
  ctx: QueryCtx,
  reportId: Id<'reports'>,
): Promise<Doc<'reportSubAreas'>[]> {
  return ctx.db
    .query('reportSubAreas')
    .withIndex('by_report', (q) => q.eq('reportId', reportId))
    .collect();
}

/**
 * Make the join say exactly `subAreaIds` for this report — insert what is missing, delete what is
 * no longer a member, and refresh the mirrors on what stays. Idempotent, so the backfill and the
 * re-stamp can call it without first asking what is there.
 */
export async function syncReportSubAreas(
  ctx: MutationCtx,
  report: Pick<Doc<'reports'>, '_id' | 'waterBodyId' | 'moderationStatus' | 'skateEndTime'>,
  subAreaIds: readonly Id<'waterBodySubAreas'>[],
): Promise<{ inserted: number; deleted: number }> {
  const existing = await loadReportSubAreas(ctx, report._id);
  const wanted = new Set(subAreaIds);
  let inserted = 0;
  let deleted = 0;
  const seen = new Set<Id<'waterBodySubAreas'>>();
  for (const row of existing) {
    // A duplicate row (two rows for one bay) is a state nothing writes, but a sync that tolerated it
    // would keep it for ever; collapse it here.
    if (!wanted.has(row.subAreaId) || seen.has(row.subAreaId)) {
      await ctx.db.delete(row._id);
      deleted++;
      continue;
    }
    seen.add(row.subAreaId);
    if (
      row.waterBodyId !== report.waterBodyId ||
      row.moderationStatus !== report.moderationStatus ||
      row.skateEndTime !== report.skateEndTime
    ) {
      await ctx.db.patch(row._id, {
        waterBodyId: report.waterBodyId,
        moderationStatus: report.moderationStatus,
        skateEndTime: report.skateEndTime,
      });
    }
  }
  for (const subAreaId of wanted) {
    if (seen.has(subAreaId)) continue;
    await ctx.db.insert('reportSubAreas', {
      reportId: report._id,
      subAreaId,
      waterBodyId: report.waterBodyId,
      moderationStatus: report.moderationStatus,
      skateEndTime: report.skateEndTime,
    });
    inserted++;
  }
  return { inserted, deleted };
}

/**
 * Refresh the mirrors after a report's own fields moved — the moderation verdict, an edited skate
 * time, a merge that repointed the body. Membership is untouched; that is `syncReportSubAreas`.
 */
export async function mirrorReportSubAreas(
  ctx: MutationCtx,
  report: Pick<Doc<'reports'>, '_id' | 'waterBodyId' | 'moderationStatus' | 'skateEndTime'>,
): Promise<number> {
  const rows = await loadReportSubAreas(ctx, report._id);
  for (const row of rows) {
    await ctx.db.patch(row._id, {
      waterBodyId: report.waterBodyId,
      moderationStatus: report.moderationStatus,
      skateEndTime: report.skateEndTime,
    });
  }
  return rows.length;
}
