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

import {
  isBrowsableSeason,
  type PostCardData,
  seasonEndMs,
  seasonOf,
  seasonStartMs,
} from '@skating/core';
import { paginationOptsValidator } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, mutation, query } from './_generated/server';
import { requireContributor, requireProfile } from './lib/auth';
import { bodyInfoFor, loadFeedViewer, servedFeedSeason, toPostCard } from './lib/feedCards';
import { createPost, editPostWords, postArgs } from './lib/reportWrite';
import { authorRemovePost } from './moderation';

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
 * An author editing their Post's words (A10-3): the title and the prose, last-write-wins like
 * `reports.update` — an omitted field is a cleared one. What the Post said before goes to
 * `contentRevisions` first, in the same transaction (`editPostWords`). Members are edited through
 * `reports.update`, which takes the Post's words too, so the sheet's *Save changes* is one
 * transaction; a Post never gains a Report after it is created (founder call
 * 2026-09-21: new Reports come as new Posts — notifications fire at create, the sort key would
 * jump, and anything keyed on a Post later would muddy).
 */
export const update = mutation({
  args: { postId: v.id('posts'), title: v.optional(v.string()), body: v.optional(v.string()) },
  handler: async (ctx, { postId, title, body }) => {
    const profile = await requireContributor(ctx);
    await editPostWords(ctx, postId, { title, body }, profile, Date.now());
    return postId;
  },
});

/**
 * An author deleting their own Post (A10-3): the Post and every member Report, soft, each with
 * an `author_delete` audit row (see `authorRemovePost`).
 */
export const remove = mutation({
  args: { postId: v.id('posts') },
  handler: async (ctx, { postId }) => {
    const profile = await requireProfile(ctx);
    const existing = await ctx.db.get(postId);
    if (!existing) throw new ConvexError('Post not found');
    if (existing.authorId !== profile._id)
      throw new ConvexError('Only the author can delete a post');
    await authorRemovePost(ctx, existing, profile, Date.now());
    return postId;
  },
});

/**
 * The global cross-body **newsfeed** (Phase 05, D28; a Post feed since A10 / D186) — every visible
 * Post, freshest **skate-end time** first (`latestSkateEndTime`, the max over its visible members),
 * paginated (`usePaginatedQuery`). All reports are public (D13) and a **block never hides a report**
 * (D3, safety-first), so the gate is moderation-only; a blocked author's Post is still returned,
 * carrying `blocked: true` for author de-emphasis + the "Blocked" chip. Each page item is a
 * `PostCardData`: the author's title and prose over the member Reports as `FeedCardData` (survivor
 * body name + point-derived place, author, photo thumbnails) — bounded by page size × members.
 *
 * **Filters stay per-Report (A10 §2.4).** An optional `filters` blob narrows each Post's members via
 * the shared `reportMatchesFeed` (include-unknown for optional attributes; distance is hard and
 * favorites are exempt). A Post appears with only its matching Reports under the header, and not at
 * all when none match; the `posts` indexes carry no filter columns. Favorites are **boosted to the
 * top of the page** (a stable per-page reorder) and carry `isFavorite: true` for the badge. With no
 * filters + no favorites the result is exactly the Phase 05 feed, one Post per Report.
 *
 * Narrowing runs *after* `paginate`, so a heavily filtered page can come back short (even empty)
 * with `isDone: false` — `usePaginatedQuery` keeps loading; the client requests the next page. (The
 * moderation gate stays in-index precisely because *it* could empty every page; user filters can't
 * strand the same way since the cursor still advances through visible Posts. A Post whose every
 * member a moderator hid on its own is dropped here too — rare, and the cursor still advances.)
 */
export const listFeed = query({
  args: {
    paginationOpts: paginationOptsValidator,
    filters: v.optional(v.any()),
    /** Browse one season explicitly. Absent ⇒ {@link servedFeedSeason} decides — see its note. */
    season: v.optional(v.number()),
  },
  handler: async (ctx, { paginationOpts, filters: rawFilters, season }) => {
    const viewer = await loadFeedViewer(ctx, rawFilters);

    // Which season this page is actually serving (D63) — either the one asked for or the newest one
    // that has anything in it. Resolved before the read so every page of a scroll agrees.
    const current = seasonOf(viewer.now);
    const served =
      season !== undefined && isBrowsableSeason(season)
        ? season
        : await servedFeedSeason(ctx, current);

    // Moderation-only gate (D32), applied *in* the index rather than after `paginate`. The season
    // bound rides the same index's range field, so it narrows the read rather than filtering its
    // output — the one gate that could empty every page stays in-index for the documented reason.
    const result = await ctx.db
      .query('posts')
      .withIndex('by_moderation_and_latest_skate_end_time', (q) =>
        q
          .eq('moderationStatus', 'visible')
          .gte('latestSkateEndTime', seasonStartMs(served))
          .lt('latestSkateEndTime', seasonEndMs(served)),
      )
      .order('desc')
      .paginate(paginationOpts);

    const page: PostCardData[] = [];
    for (const post of result.page) {
      const card = await toPostCard(ctx, post, viewer);
      if (card) page.push(card);
    }
    // Boost favorites to the top of THIS page (stable sort keeps skate-end order within each group).
    page.sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite));
    // `season` + `isPastSeason` are what let the client label the fallback instead of silently mixing
    // two winters. Sent on every page so a client that started mid-scroll still knows what it's showing.
    return { ...result, page, season: served, isPastSeason: served !== current };
  },
});

/**
 * The Post a Report belongs to, as the report detail shows it (A10 §12.1): the author's title and
 * prose — the words the Report was posted with — and the other lakes in the same Post, so a reader
 * on one leg of a multi-lake day can step to the others. Moderation-gated like the Report itself:
 * a hidden Post (or one whose Report is hidden) is `null`, and hidden siblings are not listed. The
 * Report's own visibility is the caller's check (`reports.get`); this only adds to it.
 */
export const getForReport = query({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }) => {
    const report = await ctx.db.get(reportId);
    if (!report || report.postId === undefined) return null;
    // Gated here as well as on `reports.get`: this is its own public query, and a hidden Report's
    // id must not be a handle to the Post's words and its siblings.
    if (report.moderationStatus !== 'visible') return null;
    const post = await ctx.db.get(report.postId);
    if (post?.moderationStatus !== 'visible') return null;
    const siblings: { reportId: Id<'reports'>; bodyName: string; skateEndTime: number }[] = [];
    const bodyInfo = new Map();
    for (const id of post.reportIds) {
      if (id === reportId) continue;
      const sibling = await ctx.db.get(id);
      if (sibling?.moderationStatus !== 'visible') continue;
      const body = await bodyInfoFor(ctx, sibling.waterBodyId, bodyInfo);
      if (body.standing === 'removed') continue;
      siblings.push({ reportId: id, bodyName: body.name, skateEndTime: sibling.skateEndTime });
    }
    return {
      postId: post._id,
      ...(post.title !== undefined ? { title: post.title } : {}),
      ...(post.body !== undefined ? { body: post.body } : {}),
      siblings,
    };
  },
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
