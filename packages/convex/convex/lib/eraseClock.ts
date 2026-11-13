/**
 * The erasure clock (D248): when a withdrawn item is due to be erased, decided **at the writes**.
 *
 * "An author's deletion is honored for real after 30 days if no moderator action is taken during
 * that time." Every item a person can take back carries an `eraseAt`; this file is its one writer.
 * It is set when the item is withdrawn (an author's deletion, a filer's retraction), cleared while
 * something holds the item, and set again when the hold clears — so the sweep's `by_erase_at` range
 * holds nothing but due work, and the sweep never filters a page after reading it.
 *
 * **What holds an item:** a moderator's standing verdict on it (`contentVerdicts`), or an open flag
 * on it — a complaint that has not been decided. A verdict on withdrawn content is the evidence the
 * founder's second ruling keeps; a pending flag is the complaint that "arrives after a harasser
 * deletes their comment" and still has to be assessable.
 *
 * **Who calls it:** every write that withdraws an item or moves a hold — the author's delete, a
 * verdict recorded or ended (`lib/contentVerdicts`), a flag filed, closed or retracted, a request or
 * alert retracted — and the sweep itself, which re-reads the hold at the moment of erasure anyway.
 * The rule itself is `nextEraseAt` in `@skating/core`.
 */

import { nextEraseAt, WITHDRAWN_ERASE_MS } from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

/** Everything a person can take back, by its audit target type, with its table. */
export const ERASABLE = {
  report: 'reports',
  post: 'posts',
  comment: 'comments',
  hazard: 'hazards',
  contentFlag: 'contentFlags',
  waterBodyRequest: 'waterBodyRequests',
  accessAlert: 'accessAlerts',
} as const;
export type Erasable = keyof typeof ERASABLE;
export type ErasableDoc =
  | Doc<'reports'>
  | Doc<'posts'>
  | Doc<'comments'>
  | Doc<'hazards'>
  | Doc<'contentFlags'>
  | Doc<'waterBodyRequests'>
  | Doc<'accessAlerts'>;

export function isErasable(targetType: string): targetType is Erasable {
  return Object.hasOwn(ERASABLE, targetType);
}

/**
 * Whether an access alert's own author took it back — who retracted it, whatever the row says about
 * when (a retraction from before `retractedAt` existed is theirs all the same; the clocks backfill
 * gives it its time). A moderator's retraction is a moderator's verdict on the claim, not this.
 */
export function authorRetracted(alert: Doc<'accessAlerts'>): boolean {
  return alert.status === 'retracted' && alert.retractedByUserId === alert.createdByUserId;
}

/**
 * When the item was withdrawn, if it was: its author's deletion, or its filer's retraction. An
 * access alert counts only when its author retracted it ({@link authorRetracted}). An erased item
 * has no clock left to run.
 */
export function withdrawnAtOf(type: Erasable, doc: ErasableDoc): number | undefined {
  switch (type) {
    case 'report':
    case 'hazard':
      return (doc as Doc<'reports'> | Doc<'hazards'>).authorDeletedAt;
    case 'post': {
      const post = doc as Doc<'posts'>;
      if (post.authorDeletedAt !== undefined) return post.authorDeletedAt;
      // A Post every member of which its author deleted and the sweep has since erased: the author
      // withdrew all of it, Report by Report (the clients delete Reports, never a whole Post), and
      // each waited out its own 30 days and its own holds. What is left is the Post's own words, due
      // now unless the Post itself is held. Members leave `reportIds` only by erasure, and an
      // emptied Post is down (its last member's deletion took it down); a shown one never reads as
      // withdrawn, whatever its list says.
      return post.reportIds.length === 0 && post.moderationStatus !== 'visible'
        ? EMPTIED
        : undefined;
    }
    case 'comment': {
      const comment = doc as Doc<'comments'>;
      return comment.erasedAt === undefined ? comment.authorDeletedAt : undefined;
    }
    case 'contentFlag': {
      const flag = doc as Doc<'contentFlags'>;
      return flag.status === 'retracted' ? flag.retractedAt : undefined;
    }
    case 'waterBodyRequest': {
      const request = doc as Doc<'waterBodyRequests'>;
      return request.status === 'retracted' ? request.retractedAt : undefined;
    }
    case 'accessAlert': {
      const alert = doc as Doc<'accessAlerts'>;
      return authorRetracted(alert) ? alert.retractedAt : undefined;
    }
  }
}

/**
 * The withdrawal time an emptied Post reads as: far enough back that `nextEraseAt` answers "now".
 * Its members' own clocks already ran; see {@link withdrawnAtOf}.
 */
const EMPTIED = -WITHDRAWN_ERASE_MS;

/** Whether an undecided flag — open, or picked up — stands on this target. Two `first()` reads. */
export async function hasOpenFlag(
  ctx: QueryCtx,
  targetType: Doc<'contentFlags'>['targetType'],
  targetId: string,
): Promise<boolean> {
  for (const status of ['open', 'reviewing'] as const) {
    const flag = await ctx.db
      .query('contentFlags')
      .withIndex('by_target_status_reason', (q) =>
        q.eq('targetType', targetType).eq('targetId', targetId).eq('status', status),
      )
      .first();
    if (flag) return true;
  }
  return false;
}

/** Whether a moderator's verdict stands on this item — the evidence a deletion can't take away. */
export async function hasStandingVerdictOn(
  ctx: QueryCtx,
  targetType: Doc<'contentVerdicts'>['targetType'],
  targetId: string,
): Promise<boolean> {
  const verdict = await ctx.db
    .query('contentVerdicts')
    .withIndex('by_target_standing', (q) =>
      q.eq('targetType', targetType).eq('targetId', targetId).eq('standing', true),
    )
    .first();
  return verdict !== null;
}

/** Whether a verdict or an undecided flag stands on the Post a Report belongs to. */
async function reportsPostIsHeld(ctx: QueryCtx, reportId: string): Promise<boolean> {
  const id = ctx.db.normalizeId('reports', reportId);
  const report = id ? await ctx.db.get(id) : null;
  if (report?.postId === undefined) return false;
  return (
    (await hasStandingVerdictOn(ctx, 'post', report.postId)) ||
    (await hasOpenFlag(ctx, 'post', report.postId))
  );
}

/** What holds a withdrawn item back from erasure: a standing verdict, or an undecided flag. */
export async function isHeld(ctx: QueryCtx, type: Erasable, targetId: string): Promise<boolean> {
  switch (type) {
    case 'post': {
      // A Post goes after its members: one still stored is held by its own clock, and the Post's
      // words wait for it (the member's erasure refreshes the Post's clock).
      const id = ctx.db.normalizeId('posts', targetId);
      const post = id ? await ctx.db.get(id) : null;
      if (post && post.reportIds.length > 0) return true;
      return (
        (await hasStandingVerdictOn(ctx, 'post', targetId)) ||
        (await hasOpenFlag(ctx, 'post', targetId))
      );
    }
    case 'report': {
      // A verdict or a complaint on its Post is about what the Post shows — this Report's words and
      // photos among them — so it holds the member as evidence too (the cascade is the Post's
      // verdict, not one of the member's own).
      if (await reportsPostIsHeld(ctx, targetId)) return true;
      return (
        (await hasStandingVerdictOn(ctx, 'report', targetId)) ||
        (await hasOpenFlag(ctx, 'report', targetId))
      );
    }
    case 'comment':
    case 'hazard':
      return (
        (await hasStandingVerdictOn(ctx, type, targetId)) ||
        (await hasOpenFlag(ctx, type, targetId))
      );
    case 'accessAlert':
      return (
        (await hasStandingVerdictOn(ctx, 'accessAlert', targetId)) ||
        (await hasOpenFlag(ctx, 'accessAlert', targetId))
      );
    case 'contentFlag':
    case 'waterBodyRequest':
      // Nothing files a verdict or a flag on a flag or a request.
      return false;
  }
}

/**
 * Bring one item's clock to what its withdrawal and its holds say now, and return it. Idempotent:
 * a running clock is never pushed later, and a write happens only when the value changes.
 */
export async function refreshEraseClock(
  ctx: MutationCtx,
  type: Erasable,
  targetId: string,
  now: number = Date.now(),
): Promise<number | undefined> {
  const id = ctx.db.normalizeId(ERASABLE[type], targetId);
  const doc = id ? ((await ctx.db.get(id)) as ErasableDoc | null) : null;
  if (!doc) return undefined;
  const withdrawnAt = withdrawnAtOf(type, doc);
  const held = withdrawnAt !== undefined && (await isHeld(ctx, type, targetId));
  const next = nextEraseAt({ withdrawnAt, held, current: doc.eraseAt, now });
  if (next !== doc.eraseAt) {
    await ctx.db.patch(doc._id as Id<(typeof ERASABLE)[Erasable]>, { eraseAt: next });
  }
  return next;
}

/**
 * A hold on something moved — a flag filed, closed or retracted on it, a verdict recorded or ended.
 * If that something is an item a person can withdraw, its clock follows. Targets nothing can
 * withdraw (a lake, a photo, a person) are left alone.
 */
export async function holdMoved(
  ctx: MutationCtx,
  targetType: string,
  targetId: string,
  now: number = Date.now(),
): Promise<void> {
  if (!isErasable(targetType)) return;
  await refreshEraseClock(ctx, targetType, targetId, now);
  // A Post's hold is its members' too (`isHeld`), so they follow it.
  if (targetType === 'post') {
    const id = ctx.db.normalizeId('posts', targetId);
    const post = id ? await ctx.db.get(id) : null;
    for (const reportId of post?.reportIds ?? []) {
      await refreshEraseClock(ctx, 'report', reportId, now);
    }
  }
}
