/**
 * The three denormalized Post fields and the one writer each has (A10 / D186, B03 §11).
 *
 * `posts.latestSkateEndTime` is the D28 sort key — `max(skateEndTime)` over the members —
 * `posts.photoIds` is the album — the ordered union of the members' lists (`postPhotoIds`) — and
 * `posts.searchText` is what a search of Latest reads. All three are derived from the Reports, so
 * every writer that changes a member's end time, photo list, words or verdict calls the matching
 * sync in the same transaction (`reports.update`, `posts.create`, moderation, the purge). Lives under `lib/` rather than in `posts.ts` because `reports.ts` needs it and
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

/**
 * What a search of Latest can find in one Post: its title and prose, and the words typed on its
 * **visible** members — the report's notes, each thickness reading's note, each ice, surface and
 * sighting chip's note (the same five places `reportRedaction` clears, so a purge takes every word
 * this reads). A hidden member is out because a match on its words would hand back a Post whose card
 * doesn't show them, which says what the hidden Report said. Lake and bay names are out on purpose:
 * the top bar's search finds places, and a rename would have to re-stamp every Post on the lake.
 */
export function postSearchText(
  post: Pick<Doc<'posts'>, 'title' | 'body'>,
  members: readonly Doc<'reports'>[],
): string | undefined {
  const words: (string | undefined)[] = [post.title, post.body];
  for (const member of members) {
    if (member.moderationStatus !== 'visible') continue;
    words.push(member.notes);
    for (const reading of member.iceThickness?.readings ?? []) words.push(reading.note);
    for (const chip of member.iceTypes) words.push(chip.note);
    for (const chip of member.surfaceTags) words.push(chip.note);
    for (const chip of member.sightings ?? []) words.push(chip.note);
  }
  const text = words.filter((word) => word !== undefined && word !== '').join('\n');
  return text === '' ? undefined : text;
}

/**
 * Keep `posts.searchText` current, after the words or a member's verdict have been written (a read in
 * this transaction sees them). A Post whose words did not change writes nothing. Reads the members, a
 * handful (`POST_MAX_REPORTS`).
 */
export async function refreshPostSearchText(ctx: MutationCtx, postId: Id<'posts'>): Promise<void> {
  const post = await ctx.db.get(postId);
  if (!post) return;
  const members: Doc<'reports'>[] = [];
  for (const id of post.reportIds) {
    const member = await ctx.db.get(id);
    if (member) members.push(member);
  }
  const searchText = postSearchText(post, members);
  if (searchText !== post.searchText) await ctx.db.patch(postId, { searchText });
}
