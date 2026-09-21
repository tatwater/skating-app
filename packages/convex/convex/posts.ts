/**
 * Posts (A10 / D186) — the narrative, the photo set, the ordering, and one or more Reports.
 *
 * A10-1 landed the table, the backfill that gives every existing Report a Post of its own, and the
 * shape backfill for the A10 report fields. A10-2 added the transactional `create` (Reports inline,
 * one Post key, per-Report idempotency keys — the path is `lib/reportWrite.ts`), the Post feed and
 * the profile history, and the moderation / purge / export paths — see
 * `plans/phases/A10-reporting-flow.md` §2.4.
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
import { internalMutation, mutation } from './_generated/server';
import { createPost, postArgs } from './lib/reportWrite';

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
 * The transactional Post create (A10 §2.4 / D186): the title, the prose and one or more Reports
 * inline, one Post key for the offline queue, a per-Report key beside each member. All in one
 * transaction — a Post-less Report can never exist, and "a Post requires a Report" is enforced
 * rather than hoped. The create-only rules (D189, D199) apply to every member; see
 * `lib/reportWrite.ts` for the path and `reports.create` for the one-Report form of it.
 */
export const create = mutation({
  args: postArgs,
  handler: (ctx, args) => createPost(ctx, args),
});

/**
 * One Post per Report that has none (A10-1 backfill). Paginated over the report table and
 * self-scheduling; idempotent, because a Report with a `postId` is skipped, so a re-run after a
 * partial pass finishes the rest and a run on a finished deployment is a no-op. Also stamps
 * `photos.reportId` on the Report's photos — the back-link `reports.create` and `reports.update`
 * write for every list they store (`syncReportPhotoLinks`).
 *
 * **A photo two legacy reports both list** cannot be back-linked to both. Nothing before A10 stopped
 * an author attaching one photo id to two of their reports, so the case is possible in principle,
 * though no deployment holds one (dev: two reports, no photos; prod: uninitialized). The pass does
 * not guess: the earlier report — table order is creation order — keeps the link, and the id is
 * returned in `photosShared` so the operator sees it rather than a silent skip. `reports.update`
 * refuses to add such a photo to a further report, so the set can only shrink.
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
    const photosShared: Id<'photos'>[] = [];
    for (const report of page.page) {
      if (report.postId !== undefined) continue;
      const postId: Id<'posts'> = await ctx.db.insert('posts', legacyPostFor(report));
      await ctx.db.patch(report._id, { postId });
      created++;
      for (const photoId of new Set(report.photoIds)) {
        const photo = await ctx.db.get(photoId);
        if (!photo) continue;
        if (photo.reportId === undefined) {
          await ctx.db.patch(photoId, { reportId: report._id });
          photosStamped++;
        } else if (photo.reportId !== report._id) {
          photosShared.push(photoId);
        }
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.posts.backfillFromReports, {
        cursor: page.continueCursor,
        ...(batchSize !== undefined ? { batchSize } : {}),
      });
    }
    return { scanned: page.page.length, created, photosStamped, photosShared, isDone: page.isDone };
  },
});
