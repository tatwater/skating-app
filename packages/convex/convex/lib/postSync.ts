/**
 * The two denormalized Post fields and the one writer each has (A10 / D186).
 *
 * `posts.latestSkateEndTime` is the D28 sort key — `max(skateEndTime)` over the members — and
 * `posts.photoIds` is the album — the ordered union of the members' lists (`postPhotoIds`). Both
 * are derived from the Reports, so every writer that changes a member's end time or photo list
 * calls the matching sync in the same transaction (`reports.update`, `posts.create`, moderation,
 * the purge). Lives under `lib/` rather than in `posts.ts` because `reports.ts` needs it and
 * `posts.ts` needs `reports.ts` — the write path is one direction, the helpers sit below both.
 */

import { postPhotoIds } from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/**
 * Keep `posts.latestSkateEndTime` current: the max over the Post's **visible** members, so a Post
 * whose freshest Report a moderator hid sorts on the freshest one a reader can still see. Called
 * after a member's end time moves (`changed` carries the value about to be stored, so there is no
 * read-after-write) and after a member's verdict changes. With no visible member the key is left
 * alone — the Post is not shown then anyway (`visiblePostReports`). Reads the members, a handful.
 */
export async function refreshPostLatestSkateEnd(
  ctx: MutationCtx,
  postId: Id<'posts'>,
  changed?: { reportId: Id<'reports'>; skateEndTime: number },
): Promise<void> {
  const post = await ctx.db.get(postId);
  if (!post) return;
  let latest: number | undefined;
  for (const id of post.reportIds) {
    const member = await ctx.db.get(id);
    if (!member) continue;
    const skateEndTime =
      changed && id === changed.reportId ? changed.skateEndTime : member.skateEndTime;
    if (member.moderationStatus !== 'visible') continue;
    if (latest === undefined || skateEndTime > latest) latest = skateEndTime;
  }
  if (latest !== undefined && latest !== post.latestSkateEndTime)
    await ctx.db.patch(postId, { latestSkateEndTime: latest });
}

/**
 * Recompute `posts.photoIds` from the members after one member's list changed. `photos.reportId`
 * is the Report writer's job (`syncReportPhotoLinks`); this is the album over them. `changed`
 * is the member whose list is about to be stored, so the recompute sees the new list without a
 * read-after-write.
 */
export async function syncPostPhotos(
  ctx: MutationCtx,
  postId: Id<'posts'>,
  changed?: { reportId: Id<'reports'>; photoIds: readonly Id<'photos'>[] },
): Promise<void> {
  const post = await ctx.db.get(postId);
  if (!post) return;
  const members: { photoIds: readonly Id<'photos'>[] }[] = [];
  for (const id of post.reportIds) {
    if (changed && id === changed.reportId) {
      members.push({ photoIds: changed.photoIds });
      continue;
    }
    const member: Doc<'reports'> | null = await ctx.db.get(id);
    if (member) members.push({ photoIds: member.photoIds });
  }
  const next = postPhotoIds(members);
  const same =
    next.length === post.photoIds.length && next.every((id, i) => id === post.photoIds[i]);
  if (!same) await ctx.db.patch(postId, { photoIds: next });
}
