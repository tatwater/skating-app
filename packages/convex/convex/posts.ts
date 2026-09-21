/**
 * Posts (A10 / D186) — the narrative, the photo set, the ordering, and one or more Reports.
 *
 * A10-1 lands the table, the backfill that gives every existing Report a Post of its own, and the
 * shape backfill for the A10 report fields. The transactional `posts.create` (Reports inline, one
 * Post key, per-Report idempotency keys), the Post feed, moderation, purge and export are A10-2
 * (§2.4) — see `plans/phases/A10-reporting-flow.md`.
 *
 * ## Why a Post per existing Report, rather than leaving `postId` absent
 *
 * The feed becomes a Post feed in A10-2. A Report with no Post would either need a second code
 * path on every reader ("or a bare Report") for ever, or would vanish from the feed the day it
 * flipped. One Post per legacy Report — no title, no body (the report's `notes` stays where it is,
 * as the per-body note D186 allows), the Report's photos as the set — is the shape `posts.create`
 * would have produced for a one-body post, so every reader after A10-2 has exactly one case.
 */

import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';

/**
 * The Post a legacy Report gets: the one-body Post `posts.create` would have written. Pure, so the
 * backfill and its test agree on the shape.
 */
export function legacyPostFor(report: Doc<'reports'>): Omit<Doc<'posts'>, '_id' | '_creationTime'> {
  return {
    authorId: report.authorId,
    reportIds: [report._id],
    photoIds: report.photoIds,
    latestSkateEndTime: report.skateEndTime,
    moderationStatus: report.moderationStatus,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    ...(report.editedAt !== undefined ? { editedAt: report.editedAt } : {}),
  };
}

/**
 * Keep `posts.latestSkateEndTime` — the D28 sort key — current after a member Report's end time
 * moves. Every writer that changes a Report's `skateEndTime` calls this with the value it is about
 * to store (`reports.update` today; `posts.create` and its editor in A10-2), so the Post never
 * sorts on a stale time. Reads the Post's other members — a handful — and takes the max.
 */
export async function refreshPostLatestSkateEnd(
  ctx: MutationCtx,
  postId: Id<'posts'>,
  changed: { reportId: Id<'reports'>; skateEndTime: number },
): Promise<void> {
  const post = await ctx.db.get(postId);
  if (!post) return;
  let latest = changed.skateEndTime;
  for (const id of post.reportIds) {
    if (id === changed.reportId) continue;
    const sibling = await ctx.db.get(id);
    if (sibling && sibling.skateEndTime > latest) latest = sibling.skateEndTime;
  }
  if (latest !== post.latestSkateEndTime)
    await ctx.db.patch(postId, { latestSkateEndTime: latest });
}

/**
 * One Post per Report that has none (A10-1 backfill). Paginated over the report table and
 * self-scheduling; idempotent, because a Report with a `postId` is skipped, so a re-run after a
 * partial pass finishes the rest and a run on a finished deployment is a no-op. Also stamps
 * `photos.reportId` on the Report's photos — the back-link `posts.create` writes for new ones.
 *
 * `pnpm exec convex run posts:backfillFromReports`.
 */
export const backfillFromReports = internalMutation({
  args: { cursor: v.optional(v.string()), batchSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, batchSize }) => {
    const page = await ctx.db
      .query('reports')
      .paginate({ cursor: cursor ?? null, numItems: Math.min(500, Math.max(1, batchSize ?? 100)) });
    let created = 0;
    let photosStamped = 0;
    for (const report of page.page) {
      if (report.postId !== undefined) continue;
      const postId: Id<'posts'> = await ctx.db.insert('posts', legacyPostFor(report));
      await ctx.db.patch(report._id, { postId });
      created++;
      for (const photoId of report.photoIds) {
        const photo = await ctx.db.get(photoId);
        if (!photo || photo.reportId !== undefined) continue;
        await ctx.db.patch(photoId, { reportId: report._id });
        photosStamped++;
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.posts.backfillFromReports, {
        cursor: page.continueCursor,
        ...(batchSize !== undefined ? { batchSize } : {}),
      });
    }
    return { scanned: page.page.length, created, photosStamped, isDone: page.isDone };
  },
});
