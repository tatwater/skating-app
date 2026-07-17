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
 * author-line "Blocked" chip. An unauthenticated viewer (`''`) has no block set.
 */
export async function loadBlockedAuthorIds(
  ctx: QueryCtx,
  viewerId: Id<'profiles'> | '',
): Promise<Set<string>> {
  if (viewerId === '') return new Set<string>()
  const blocked = new Set<string>()
  // Users I blocked.
  const asBlocker = await ctx.db
    .query('blocks')
    .withIndex('by_blocker', (q) => q.eq('blockerId', viewerId))
    .collect()
  for (const b of asBlocker) blocked.add(b.blockedId)
  // Users who blocked me (bidirectional — a block hides both ways, D32).
  const asBlocked = await ctx.db
    .query('blocks')
    .withIndex('by_blocked', (q) => q.eq('blockedId', viewerId))
    .collect()
  for (const b of asBlocked) blocked.add(b.blockerId)
  return blocked
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
