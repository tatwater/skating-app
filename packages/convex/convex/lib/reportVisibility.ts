/**
 * The shared report-read gate (D3/D13/D32). A report is viewable **iff its moderation status is
 * `visible`** — nothing else. Centralized so every surface that resolves report-derived data makes
 * the *same* decision — in particular a photo's serving URL must never outlive the viewer's access
 * to the report that references it (D42).
 *
 * ⚠️ **Phase 03 (2026-07-16, D3):** a **block NEVER hides a report** — an interpersonal block must
 * not pull a safety observation off the map/feed. So report reads gate on moderation alone; the
 * block set instead hides **comments** by a blocked author, hides **profiles** both ways, and
 * de-emphasizes a blocked author's report line (a "Blocked" chip — a *display* concern the read paths
 * annotate, not a gate). `loadBlockedAuthorIds` below is the single source of that block set.
 */

import { canViewReport } from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { defaultSampleAnchor } from './sampling';

/**
 * The set of author profile ids blocked from `viewerId`, unioned across **both** directions — I
 * blocked them OR they blocked me (D32). Feeds comment filtering, profile access, and the report
 * author-line "Blocked" chip. An unauthenticated viewer (`''`) has no block set.
 */
export async function loadBlockedAuthorIds(
  ctx: QueryCtx,
  viewerId: Id<'profiles'> | '',
): Promise<Set<string>> {
  if (viewerId === '') return new Set<string>();
  const blocked = new Set<string>();
  // Users I blocked.
  const asBlocker = await ctx.db
    .query('blocks')
    .withIndex('by_blocker', (q) => q.eq('blockerId', viewerId))
    .collect();
  for (const b of asBlocker) blocked.add(b.blockedId);
  // Users who blocked me (bidirectional — a block hides both ways, D32).
  const asBlocked = await ctx.db
    .query('blocks')
    .withIndex('by_blocked', (q) => q.eq('blockedId', viewerId))
    .collect();
  for (const b of asBlocked) blocked.add(b.blockerId);
  return blocked;
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
  const report = await ctx.db.get(reportId);
  if (report === null) return null;
  return canViewReport(report.moderationStatus) ? report : null;
}

/** Author, moderator or admin — the viewers who see a report's put-in regardless of the opt-out. */
export function canSeePutIn(
  viewer: Pick<Doc<'profiles'>, '_id' | 'role'> | null,
  report: Pick<Doc<'reports'>, 'authorId'>,
): boolean {
  return (
    (viewer !== null && viewer._id === report.authorId) ||
    viewer?.role === 'moderator' ||
    viewer?.role === 'admin'
  );
}

/**
 * The report as a viewer may see it: with `showPutIn === false` (Phase 04 decision #7), a non-author,
 * non-moderator gets the **body's** anchor point in place of the report's own `point`. The report row
 * is untouched — hide a marker, never scrub a location — but the served doc no longer carries the
 * launch, because every consumer of a served report (the detail drawer's camera, the profile's history
 * cards, a lake's report list) would otherwise fly straight to the spot the switch promised to keep
 * off the map. The coarse `place` label stays: it names a town, not a driveway.
 *
 * The substitute is `defaultSampleAnchor` — the same interior point every other "where is this
 * body" consumer uses, so a redacted report lands where the lake's own forecast does. A report whose
 * body is gone (a dangling ref) keeps its point: there is nothing to substitute, and the row is
 * unreachable from any surface anyway.
 */
export async function redactPutIn(
  ctx: QueryCtx,
  report: Doc<'reports'>,
  viewer: Pick<Doc<'profiles'>, '_id' | 'role'> | null,
  /** The report's body when the caller already holds it, so the substitute costs no second read. */
  loadedBody?: Doc<'waterBodies'> | null,
): Promise<Doc<'reports'>> {
  if (report.showPutIn !== false || canSeePutIn(viewer, report)) return report;
  const body = loadedBody !== undefined ? loadedBody : await ctx.db.get(report.waterBodyId);
  if (body === null) return report;
  return { ...report, point: defaultSampleAnchor(body) };
}
