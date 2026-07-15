/**
 * The shared report-visibility gate (D13/D32). A report is viewable only when it's moderation
 * `visible` **and** the current viewer passes `canViewReport`. Centralized so every surface that
 * resolves report-derived data makes the *same* decision — in particular a photo's serving URL
 * must never outlive the viewer's access to the report that references it (D42).
 *
 * The viewer relationship is self/none until the follow graph lands (Phase 3), so `friends` /
 * `followers` resolve to author-only today and flip on for free once follows exist.
 */

import { canViewReport } from '@skating/core'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { getCurrentProfile } from './auth'

/** Viewer relationship until the follow graph exists (Phase 3): no follows, no blocks. */
export const NO_RELATIONSHIP = {
  viewerFollowsAuthor: false,
  authorFollowsViewer: false,
  blocked: false,
}

/** Load a report only if it's moderation-visible and the current viewer may see it; else `null`. */
export async function getViewableReport(
  ctx: QueryCtx,
  reportId: Id<'reports'>,
): Promise<Doc<'reports'> | null> {
  const report = await ctx.db.get(reportId)
  if (report?.moderationStatus !== 'visible') return null
  const viewer = await getCurrentProfile(ctx)
  if (!canViewReport(viewer?._id ?? '', report.authorId, report.visibility, NO_RELATIONSHIP)) {
    return null
  }
  return report
}
