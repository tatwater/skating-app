/**
 * The shared report-read gate (D3/D13/D32). A report is viewable **iff its moderation status is
 * `visible`** — nothing else. Centralized so every surface that resolves report-derived data makes
 * the *same* decision — in particular a photo's serving URL must never outlive the viewer's access
 * to the report that references it (D42).
 *
 * ⚠️ **Phase 3 (2026-07-16, D3):** a **block NEVER hides a report** — an interpersonal block must
 * not pull a safety observation off the map/feed. So report reads gate on moderation alone; the
 * block set instead hides **comments** by a blocked author, hides **profiles** both ways, and
 * de-emphasizes a blocked author's report line (a "Blocked" chip — a *display* concern the read paths
 * annotate, not a gate). `loadBlockedAuthorIds` below is the single source of that block set.
 */

import { canViewReport } from '@skating/core'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'

/**
 * The set of author profile ids blocked from `viewerId`, unioned across **both** directions — I
 * blocked them OR they blocked me (D32). Feeds comment filtering, profile access, and the report
 * author-line "Blocked" chip. Gets its real implementation in Workstream B (query `blocks` by
 * `by_blocker` + `by_blocked`); a stub set until then.
 */
export async function loadBlockedAuthorIds(
  _ctx: QueryCtx,
  _viewerId: Id<'profiles'> | '',
): Promise<Set<string>> {
  // TODO(Workstream B): union `blocks` by_blocker + by_blocked for the viewer.
  return new Set<string>()
}

/**
 * Load a report only if the viewer may see it — moderation-`visible` **only** (D3/D13). Blocks never
 * hide a report, so this needs no viewer/block resolution: `reports.get` and `photos.getUrls` share
 * this one moderation gate.
 */
export async function getViewableReport(
  ctx: QueryCtx,
  reportId: Id<'reports'>,
): Promise<Doc<'reports'> | null> {
  const report = await ctx.db.get(reportId)
  if (report === null) return null
  return canViewReport(report.moderationStatus) ? report : null
}
