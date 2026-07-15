/**
 * The shared report-visibility gate (D13/D32). A report is viewable only when it's moderation
 * `visible` **and** the current viewer passes `canViewReport`. Centralized so every surface that
 * resolves report-derived data makes the *same* decision — in particular a photo's serving URL
 * must never outlive the viewer's access to the report that references it (D42).
 *
 * With no social graph (D13), report reads are simply `public` → anyone, `just_me` → author. The
 * only relationship that narrows access is a block (D32), which lands in Phase 3 — until then the
 * viewer relationship is `{ blocked: false }`.
 */

import { canViewReport } from '@skating/core'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { getCurrentProfile } from './auth'

/** Viewer relationship until blocks exist (Phase 3): no block in effect. */
export const NO_RELATIONSHIP = { blocked: false }

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
