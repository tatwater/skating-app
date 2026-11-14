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
 *
 * **What it reads is bounded and charged** (`lib/readBudget`): a hold is a handful of `first()`
 * existence checks on exact index prefixes — complete answers, at most {@link HOLD_COST} — and a
 * caller that already holds the row passes it in (`refreshClockOf`) rather than reading it again. A
 * Post's members, whose hold is the Post's too, follow in `erasure.refreshMemberClocks`.
 */

import { nextEraseAt, WITHDRAWN_ERASE_MS } from '@skating/core';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { type AttemptState, MAX_ATTEMPTS, nextAttemptState } from './attempts';
import { ReadBudget, ROW_MAX } from './readBudget';

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

/**
 * What deciding an item's hold reads, at worst: a standing-verdict check and two flag checks per
 * target it consults (a Report consults its Post's too). Only `first()` existence checks on an exact
 * index prefix — complete answers, each one row.
 */
const DIRECT_HOLD = ROW_MAX.verdict + 2 * ROW_MAX.contentFlag;
export const HOLD_COST: Record<Erasable, number> = {
  report: 2 * DIRECT_HOLD,
  post: DIRECT_HOLD,
  comment: DIRECT_HOLD,
  hazard: DIRECT_HOLD,
  accessAlert: DIRECT_HOLD,
  contentFlag: 0,
  waterBodyRequest: 0,
};

/** A standing verdict or an undecided flag (open, or picked up) on this target. Complete. */
async function directHold(
  ctx: QueryCtx,
  budget: ReadBudget,
  targetType: Doc<'contentVerdicts'>['targetType'],
  targetId: string,
): Promise<boolean> {
  const verdict = await budget.one('verdict', () =>
    ctx.db
      .query('contentVerdicts')
      .withIndex('by_target_standing', (q) =>
        q.eq('targetType', targetType).eq('targetId', targetId).eq('standing', true),
      )
      .first(),
  );
  if (verdict) return true;
  for (const status of ['open', 'reviewing'] as const) {
    const flag = await budget.one('contentFlag', () =>
      ctx.db
        .query('contentFlags')
        .withIndex('by_target_status_reason', (q) =>
          q.eq('targetType', targetType).eq('targetId', targetId).eq('status', status),
        )
        .first(),
    );
    if (flag) return true;
  }
  return false;
}

/**
 * What holds a withdrawn item back from erasure: a standing verdict, or an undecided flag. Reads at
 * most {@link HOLD_COST} for its kind; `postHeld` passes in a Report's Post's hold when the caller
 * already has it.
 */
export async function isHeld(
  ctx: QueryCtx,
  budget: ReadBudget,
  type: Erasable,
  doc: ErasableDoc,
  known: { postHeld?: boolean } = {},
): Promise<boolean> {
  switch (type) {
    case 'post': {
      // A Post goes after its members: one still listed is held by its own clock, and the Post's
      // words wait for it (the member's erasure refreshes the Post's clock).
      if ((doc as Doc<'posts'>).reportIds.length > 0) return true;
      return directHold(ctx, budget, 'post', doc._id);
    }
    case 'report': {
      // A verdict or a complaint on its Post is about what the Post shows — this Report's words and
      // photos among them — so it holds the member as evidence too (the cascade is the Post's
      // verdict, not one of the member's own).
      const postId = (doc as Doc<'reports'>).postId;
      if (postId !== undefined) {
        const postHeld = known.postHeld ?? (await directHold(ctx, budget, 'post', postId));
        if (postHeld) return true;
      }
      return directHold(ctx, budget, 'report', doc._id);
    }
    case 'comment':
    case 'hazard':
    case 'accessAlert':
      return directHold(ctx, budget, type, doc._id);
    case 'contentFlag':
    case 'waterBodyRequest':
      // Nothing files a verdict or a flag on a flag or a request.
      return false;
  }
}

/** A Post's own hold as its members read it — a verdict or an undecided flag on the Post. */
export function postHoldOf(ctx: QueryCtx, budget: ReadBudget, postId: Id<'posts'>) {
  return directHold(ctx, budget, 'post', postId);
}

/** The clock `doc` should carry now, given what holds it. Writes nothing. */
export async function clockOf(
  ctx: QueryCtx,
  budget: ReadBudget,
  type: Erasable,
  doc: ErasableDoc,
  now: number,
  known: { postHeld?: boolean } = {},
): Promise<number | undefined> {
  // Parked after failing too often: off the clock until `erasure.retryParked` releases it, whatever
  // its holds do meanwhile — so nothing retries it but that.
  if (doc.eraseParkedAt !== undefined) return undefined;
  const withdrawnAt = withdrawnAtOf(type, doc);
  const held = withdrawnAt !== undefined && (await isHeld(ctx, budget, type, doc, known));
  return nextEraseAt({ withdrawnAt, held, current: doc.eraseAt, now });
}

/**
 * Bring one item's clock (as `doc` holds it, read in this transaction) to what its withdrawal and its
 * holds say now, and return it. Idempotent: a running clock is never pushed later, and a write happens
 * only when the value changes. `alongside` rides in the same patch — a caller re-deriving the row's
 * other fields writes once.
 */
export async function refreshClockOf(
  ctx: MutationCtx,
  budget: ReadBudget,
  type: Erasable,
  doc: ErasableDoc,
  now: number,
  known: { postHeld?: boolean } = {},
  alongside?: Record<string, unknown>,
): Promise<number | undefined> {
  const next = await clockOf(ctx, budget, type, doc, now, known);
  if (next !== doc.eraseAt || alongside !== undefined) {
    budget.touch(type);
    await ctx.db.patch(doc._id as Id<(typeof ERASABLE)[Erasable]>, {
      ...alongside,
      eraseAt: next,
    });
  }
  return next;
}

/** The same, by id: reads the row first. */
export async function refreshEraseClock(
  ctx: MutationCtx,
  type: Erasable,
  targetId: string,
  now: number = Date.now(),
  budget: ReadBudget = new ReadBudget(),
): Promise<number | undefined> {
  const id = ctx.db.normalizeId(ERASABLE[type], targetId);
  if (!id) return undefined;
  const doc = (await budget.one(type, () => ctx.db.get(id))) as ErasableDoc | null;
  if (!doc) return undefined;
  return refreshClockOf(ctx, budget, type, doc, now);
}

/**
 * A hold on something moved — a flag filed, closed or retracted on it, a verdict recorded or ended.
 * If that something is an item a person can withdraw, its clock follows. Targets nothing can
 * withdraw (a lake, a photo, a person) are left alone.
 *
 * A Post's hold is its members' too (`isHeld`), and up to ten members' checks don't fit beside the
 * caller's own reads, so they follow in `erasure.refreshMemberClocks`, a few a transaction. Until it
 * runs nothing is unsafe: the sweep re-reads every hold, the Post's included, before it erases.
 */
export async function holdMoved(
  ctx: MutationCtx,
  targetType: string,
  targetId: string,
  now: number = Date.now(),
  budget: ReadBudget = new ReadBudget(),
): Promise<void> {
  if (!isErasable(targetType)) return;
  if (targetType !== 'post') {
    await refreshEraseClock(ctx, targetType, targetId, now, budget);
    return;
  }
  const id = ctx.db.normalizeId('posts', targetId);
  const post = id ? await budget.one('post', () => ctx.db.get(id)) : null;
  if (!post) return;
  await refreshClockOf(ctx, budget, 'post', post, now);
  if (post.reportIds.length > 0) {
    await ctx.scheduler.runAfter(0, internal.erasure.refreshMemberClocks, { postId: post._id });
  }
}

/** Failed erasures in a row an item gets before it is parked (the one rule, `lib/attempts`). */
export const MAX_ERASE_ATTEMPTS = MAX_ATTEMPTS;

/** An item's attempt state, read off its row. */
export function attemptsOfItem(doc: ErasableDoc): AttemptState {
  return {
    attempts: doc.eraseAttempts,
    errorClass: doc.eraseErrorClass,
    parkedAt: doc.eraseParkedAt,
    retriedAt: doc.eraseRetriedAt,
  };
}

/** The same, as the row's fields. */
export function itemAttemptFields(state: AttemptState) {
  return {
    eraseAttempts: state.attempts,
    eraseErrorClass: state.errorClass,
    eraseParkedAt: state.parkedAt,
    eraseRetriedAt: state.retriedAt,
  };
}

/**
 * An item's erasure failed (its nested transaction rolled back): the rule's next state on the row,
 * written in the sweep's own transaction. Not yet parked, its clock moves to just past this run's
 * cutoff (`runCutoff + 1`) — still due, but not again in this run, so it is tried once a run and
 * three failures mean three runs. Parked, it is off the clock and out of the range until the daily
 * retry or `erasure.retryParked`. Parking erases nothing and changes nothing else about the item.
 */
export async function recordEraseFailure(
  ctx: MutationCtx,
  budget: ReadBudget,
  type: Erasable,
  doc: ErasableDoc,
  errorClass: string,
  now: number,
  { runCutoff, byDailyRetry = false }: { runCutoff: number; byDailyRetry?: boolean },
): Promise<'retry' | 'parked'> {
  const next = nextAttemptState(
    attemptsOfItem(doc),
    { kind: 'failed', errorClass, byDailyRetry },
    now,
  ) as AttemptState;
  const parked = next.parkedAt !== undefined;
  budget.touch(type);
  await ctx.db.patch(doc._id as Id<(typeof ERASABLE)[Erasable]>, {
    ...itemAttemptFields(next),
    eraseAt: parked ? undefined : runCutoff + 1,
  });
  return parked ? 'parked' : 'retry';
}

/** Release a parked item: its attempts cleared, and its clock what its withdrawal and holds say now. */
export async function releaseParkedErasure(
  ctx: MutationCtx,
  budget: ReadBudget,
  type: Erasable,
  doc: ErasableDoc,
  now: number,
): Promise<number | undefined> {
  const released = itemAttemptFields(
    nextAttemptState(attemptsOfItem(doc), { kind: 'progress' }, now) ?? {},
  );
  return refreshClockOf(
    ctx,
    budget,
    type,
    { ...doc, ...released } as ErasableDoc,
    now,
    {},
    released,
  );
}
