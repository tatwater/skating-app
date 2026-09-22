/**
 * What an author changed (D205) — the moderator's read of `contentRevisions`.
 *
 * `posts.update` and `reports.update` write what a row used to say before they patch it
 * (`lib/revisions.ts`). This is the only thing that reads those rows back other than the author's
 * own data export: a **moderator-only** query returning the stored snapshots alongside the live
 * content block, so the console can show what each edit moved (`@skating/core`'s `revisionHistory`
 * does the comparing — pure, and tested without a database).
 *
 * `requireRole`, not `requireContributorRole`: this is a read, and an operator reviewing the state
 * of things on their way out is the case that helper's docstring exists for.
 *
 * Nothing here is shown to a skater. A card says *Edited* off `editedAt` and no more (D205); the
 * history is a moderation tool, and the author's own copy is in their export (D62).
 */

import { ConvexError, v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { type QueryCtx, query } from './_generated/server';
import { requireRole } from './lib/auth';
import { postSnapshotOf, reportSnapshotOf } from './lib/revisions';
import { literals } from './lib/validators';

/**
 * One row's edit history, oldest first, with the live content block to compare the last snapshot
 * against. `revisions` is empty for a row that has never been edited, and `live` is `null` only if
 * the row is gone — a hard delete, which today nothing does.
 */
export const listForTarget = query({
  args: {
    targetType: literals(['post', 'report']),
    targetId: v.string(),
  },
  handler: async (ctx, { targetType, targetId }) => {
    await requireRole(ctx, 'moderator');

    const rows = await ctx.db
      .query('contentRevisions')
      .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
      .collect();

    // The author is the same on every row (only the author can edit), but the name is read once
    // per distinct id rather than assumed, so a moderator sees who rather than infers it.
    const names = new Map<string, string | undefined>();
    for (const row of rows) {
      if (names.has(row.authorId)) continue;
      const profile = await ctx.db.get(row.authorId);
      names.set(row.authorId, profile?.username);
    }

    const live = await liveBlock(ctx, targetType, targetId);
    if (live === null) throw new ConvexError('That content is no longer there');

    return {
      live: live.snapshot,
      /** When the row was last edited, `undefined` for one that never has been. */
      editedAt: live.editedAt,
      revisions: rows
        .sort((a, b) => a.replacedAt - b.replacedAt)
        .map((row) => ({
          replacedAt: row.replacedAt,
          snapshot: row.snapshot as Record<string, unknown>,
          authorId: row.authorId,
          authorUsername: names.get(row.authorId),
        })),
    };
  },
});

async function liveBlock(
  ctx: QueryCtx,
  targetType: 'post' | 'report',
  targetId: string,
): Promise<{ snapshot: Record<string, unknown>; editedAt?: number } | null> {
  if (targetType === 'post') {
    const post = await ctx.db.get(targetId as Id<'posts'>);
    if (!post) return null;
    return {
      snapshot: postSnapshotOf(post) as Record<string, unknown>,
      ...(post.editedAt !== undefined ? { editedAt: post.editedAt } : {}),
    };
  }
  const report = await ctx.db.get(targetId as Id<'reports'>);
  if (!report) return null;
  return {
    snapshot: reportSnapshotOf(report) as Record<string, unknown>,
    ...(report.editedAt !== undefined ? { editedAt: report.editedAt } : {}),
  };
}

/** Has this row been edited at all? A cheap existence check for the console's *History* affordance. */
export const countForTarget = query({
  args: {
    targetType: literals(['post', 'report']),
    targetId: v.string(),
  },
  handler: async (ctx, { targetType, targetId }) => {
    await requireRole(ctx, 'moderator');
    const rows = await ctx.db
      .query('contentRevisions')
      .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
      .collect();
    return rows.length;
  },
});
