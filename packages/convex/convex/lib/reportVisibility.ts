/**
 * The shared report-read gate (D13/D32). A report is viewable only when it's moderation `visible`
 * AND not hidden by a block. Centralized so every surface that resolves report-derived data makes
 * the *same* decision — in particular a photo's serving URL must never outlive the viewer's access
 * to the report that references it (D42).
 *
 * All reports are **public** (D13), so there is no per-report visibility to resolve. The only
 * relationship that narrows access is a **block** (D32), which lands in Phase 3. The block *source*
 * is centralized in `loadBlockedAuthorIds` below, and **all three report-read paths** — `reports.get`
 * and `photos.getUrls` (via `getViewableReport`) plus `reports.listByWaterBody` — route their
 * `canViewReport` decision through it. So Phase 3 implements the block lookup in **one** place and
 * every path picks it up at once (no partial-fix trap).
 */

import { canViewReport } from '@skating/core'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { getCurrentProfile } from './auth'

/**
 * The set of author profile ids hidden from `viewerId` by a block, in either direction (D32) — the
 * single source of the report block filter. **Empty until Phase 3 ships the `blocks` surface**;
 * when it does, this is the one function to implement (query the `blocks` table for `viewerId`), and
 * every report-read path already consumes it.
 */
export async function loadBlockedAuthorIds(
  _ctx: QueryCtx,
  _viewerId: Id<'profiles'> | '',
): Promise<Set<string>> {
  // TODO(Phase 3, D32): return the profile ids that block / are blocked by the viewer.
  return new Set<string>()
}

/**
 * Load a report only if the viewer may see it — moderation-`visible` AND not block-hidden (D13/D32).
 * Resolves the viewer + block set itself, so `reports.get` and `photos.getUrls` share one gate.
 */
export async function getViewableReport(
  ctx: QueryCtx,
  reportId: Id<'reports'>,
): Promise<Doc<'reports'> | null> {
  const report = await ctx.db.get(reportId)
  if (report?.moderationStatus !== 'visible') return null
  const viewer = await getCurrentProfile(ctx)
  const viewerId = viewer?._id ?? ''
  const blocked = await loadBlockedAuthorIds(ctx, viewerId)
  return canViewReport(viewerId, report.authorId, { blocked: blocked.has(report.authorId) })
    ? report
    : null
}
