/**
 * The shared report-read gate (D13/D32). A report is viewable only when it's moderation `visible`.
 * Centralized so every surface that resolves report-derived data makes the *same* decision — in
 * particular a photo's serving URL must never outlive the viewer's access to the report that
 * references it (D42).
 *
 * All reports are **public** (D13), so there is no per-report visibility to resolve. The only
 * relationship that will narrow access is a **block** (D32), which lands in Phase 3; `canViewReport`
 * (from `@skating/core`) carries that seam, and `NO_RELATIONSHIP` is the no-block default callers
 * pass until then. Reads that want the block filter compose `canViewReport` themselves (e.g.
 * `reports.listByWaterBody`); this loader only needs the moderation check today.
 */

import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'

/** Viewer relationship until blocks exist (Phase 3): no block in effect. */
export const NO_RELATIONSHIP = { blocked: false }

/** Load a report only if it's moderation-visible; else `null`. (Blocks join here in Phase 3.) */
export async function getViewableReport(
  ctx: QueryCtx,
  reportId: Id<'reports'>,
): Promise<Doc<'reports'> | null> {
  const report = await ctx.db.get(reportId)
  if (report?.moderationStatus !== 'visible') return null
  return report
}
