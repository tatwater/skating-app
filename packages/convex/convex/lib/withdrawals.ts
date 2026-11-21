/**
 * **One small row per item its author took back** (B01-4m, D282) — the record sheet's Deleted list
 * and its count, read as one index range of `contentWithdrawals` rows instead of each kind's whole
 * documents. This module is the table's one writer:
 *
 * - **The row** follows the item: it exists exactly while the item is withdrawn by its author — a
 *   deletion (`authorDeletedAt`), or an access alert its author retracted with a time — and not
 *   erased (an erased comment's shell keeps its stamp but is no longer theirs). Every withdrawal
 *   writer calls {@link syncWithdrawal} with the item as it just wrote it; the eraser calls
 *   {@link dropWithdrawal}. `packages/guards`' `withdrawalWriters.test.ts` holds the list.
 * - **`held`** is whether a moderator's decision stands on the item — then it is Standing's, not
 *   Deleted's. It is the same question the Deleted list asked of each row before (a standing verdict
 *   on that item, by `contentVerdicts.by_target_standing`), asked once at each verdict write instead:
 *   {@link refreshWithdrawalHold} beside every write that stands a verdict up or ends one
 *   (`lib/contentVerdicts`, and the replay in `contentRecord`). A Post's decision, or an open flag,
 *   holds an item back from erasure (`lib/eraseClock`) but never moved it off the Deleted list, and
 *   doesn't here.
 *
 * Before the People backfill `peopleJobs:backfillWithdrawals` has concluded, rows may be missing:
 * the Deleted reads say `pending: ['withdrawals']` until then. Every read and write here is charged
 * against the caller's budget, or a fresh one.
 */
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { VerdictTargetType } from './contentVerdicts';
import { authorOf } from './ownContent';
import { ReadBudget, ROW_MAX } from './readBudget';
import {
  DELETED_KINDS,
  type Position,
  type RecordContentDoc,
  targetIdOf,
  withdrawnAt,
} from './recordReads';

export type Withdrawal = Doc<'contentWithdrawals'>;

/**
 * **The Deleted list's one rule**: their own withdrawal (an alert, their own retraction with a time),
 * and not an erased comment's shell — what a row exists for. A decision holding it then sends it to
 * Standing (`held`).
 */
export function isListedWithdrawal(kind: VerdictTargetType, doc: RecordContentDoc): boolean {
  return (
    withdrawnAt(kind, doc) !== null &&
    !(kind === 'comment' && (doc as Doc<'comments'>).erasedAt !== undefined)
  );
}

/** The kind's place in the list's tie-break, inverted so a descending read takes the list's order. */
export function kindRankOf(kind: VerdictTargetType): number {
  return DELETED_KINDS.length - 1 - DELETED_KINDS.indexOf(kind);
}

/** A row's place in the Deleted list's order — the cursor the list's pages carry. */
export function withdrawalKey(row: Withdrawal): Position {
  return {
    key: row.withdrawnAt,
    ct: row.targetCreatedAt,
    kind: DELETED_KINDS.indexOf(row.targetType),
  };
}

/** What keeping one item's row reads and writes at worst: its row, its hold, one write. */
export const WITHDRAWAL_SYNC_COST = 2 * ROW_MAX.withdrawal + ROW_MAX.verdict;

function rowOf(ctx: QueryCtx, reads: ReadBudget, kind: VerdictTargetType, targetId: string) {
  return reads.one('withdrawal', () =>
    ctx.db
      .query('contentWithdrawals')
      .withIndex('by_target', (q) => q.eq('targetType', kind).eq('targetId', targetId))
      .first(),
  );
}

/** Whether a moderator's decision stands on the item — the Deleted list's hold, one row. */
export async function heldOn(
  ctx: QueryCtx,
  reads: ReadBudget,
  kind: VerdictTargetType,
  targetId: string,
): Promise<boolean> {
  const standing = await reads.one('verdict', () =>
    ctx.db
      .query('contentVerdicts')
      .withIndex('by_target_standing', (q) =>
        q.eq('targetType', kind).eq('targetId', targetId).eq('standing', true),
      )
      .first(),
  );
  return standing !== null;
}

/**
 * Bring one item's row to the item as it now stands — `doc` as the caller just wrote it, or `null`
 * when it is gone: inserted, rewritten or removed, and `held` read afresh. Writes only what changed;
 * `true` when it wrote. The one place a row is made.
 */
export async function syncWithdrawal(
  ctx: MutationCtx,
  kind: VerdictTargetType,
  targetId: string,
  doc: RecordContentDoc | null,
  reads: ReadBudget = new ReadBudget(),
): Promise<boolean> {
  const existing = await rowOf(ctx, reads, kind, targetId);
  const at = doc !== null && isListedWithdrawal(kind, doc) ? withdrawnAt(kind, doc) : null;
  const subject = doc === null ? null : authorOf(doc);
  if (at === null || subject === null || doc === null) {
    if (existing === null) return false;
    reads.touch('withdrawal');
    await ctx.db.delete(existing._id);
    return true;
  }
  const want = {
    subjectUserId: subject,
    targetType: kind,
    targetId,
    withdrawnAt: at,
    kindRank: kindRankOf(kind),
    targetCreatedAt: doc._creationTime,
    held: await heldOn(ctx, reads, kind, targetId),
  };
  if (existing === null) {
    reads.touch('withdrawal');
    await ctx.db.insert('contentWithdrawals', want);
    return true;
  }
  if (
    existing.subjectUserId === want.subjectUserId &&
    existing.withdrawnAt === want.withdrawnAt &&
    existing.kindRank === want.kindRank &&
    existing.targetCreatedAt === want.targetCreatedAt &&
    existing.held === want.held
  ) {
    return false;
  }
  reads.touch('withdrawal');
  await ctx.db.patch(existing._id, want);
  return true;
}

/** {@link syncWithdrawal} by id: the item is read first (charged at its kind's worst case). */
export async function syncWithdrawalById(
  ctx: MutationCtx,
  kind: VerdictTargetType,
  targetId: string,
  reads: ReadBudget = new ReadBudget(),
): Promise<boolean> {
  const id = targetIdOf(ctx, kind, targetId);
  const doc = id
    ? ((await reads.one(kind, () => ctx.db.get(id))) as RecordContentDoc | null)
    : null;
  return syncWithdrawal(ctx, kind, targetId, doc, reads);
}

/** What {@link refreshWithdrawalHold} reads and writes at worst. */
export const WITHDRAWAL_HOLD_COST = WITHDRAWAL_SYNC_COST;

/**
 * A verdict on the item was stood up or ended: its row's `held` follows. An item with no row (not
 * withdrawn, or not yet backfilled) has nothing to follow. `true` when it wrote.
 */
export async function refreshWithdrawalHold(
  ctx: MutationCtx,
  kind: VerdictTargetType,
  targetId: string,
  reads: ReadBudget = new ReadBudget(),
): Promise<boolean> {
  const existing = await rowOf(ctx, reads, kind, targetId);
  if (existing === null) return false;
  const held = await heldOn(ctx, reads, kind, targetId);
  if (existing.held === held) return false;
  reads.touch('withdrawal');
  await ctx.db.patch(existing._id, { held });
  return true;
}

/** What {@link dropWithdrawal} reads and writes at worst. */
export const WITHDRAWAL_DROP_COST = 2 * ROW_MAX.withdrawal;

/** The eraser took the item (or left a comment's shell): its row goes. */
export async function dropWithdrawal(
  ctx: MutationCtx,
  kind: VerdictTargetType,
  targetId: Id<'reports' | 'posts' | 'comments' | 'hazards' | 'accessAlerts'>,
  reads: ReadBudget,
): Promise<void> {
  const existing = await rowOf(ctx, reads, kind, targetId);
  if (existing === null) return;
  reads.touch('withdrawal');
  await ctx.db.delete(existing._id);
}

/**
 * The person's unheld rows strictly after `after` in the Deleted list's order (withdrawal desc, the
 * kind's place, creation desc), up to `n` — every kind, or one with `targetType`. In three parts at
 * most — the rest of the cursor's own tie, the kinds after it at its time, then earlier times — each
 * a `take` charged at `n` rows. Every field in the ranges is required, so no bound is needed below.
 */
export async function withdrawalsAfter(
  ctx: QueryCtx,
  reads: ReadBudget,
  userId: Id<'profiles'>,
  targetType: VerdictTargetType | undefined,
  after: Position | null,
  n: number,
): Promise<Withdrawal[]> {
  if (n <= 0) return [];
  if (targetType !== undefined) {
    const base = () =>
      ctx.db
        .query('contentWithdrawals')
        .withIndex('by_subject_held_type', (q) =>
          q.eq('subjectUserId', userId).eq('held', false).eq('targetType', targetType),
        );
    if (after === null) return reads.take('withdrawal', n, (k) => base().order('desc').take(k));
    const ownTie = DELETED_KINDS.indexOf(targetType) === after.kind;
    const [tie, rest] = await Promise.all([
      ownTie
        ? reads.take('withdrawal', n, (k) =>
            ctx.db
              .query('contentWithdrawals')
              .withIndex('by_subject_held_type', (q) =>
                q
                  .eq('subjectUserId', userId)
                  .eq('held', false)
                  .eq('targetType', targetType)
                  .eq('withdrawnAt', after.key)
                  .lt('targetCreatedAt', after.ct),
              )
              .order('desc')
              .take(k),
          )
        : Promise.resolve([]),
      reads.take('withdrawal', n, (k) =>
        ctx.db
          .query('contentWithdrawals')
          .withIndex('by_subject_held_type', (q) => {
            const b = q.eq('subjectUserId', userId).eq('held', false).eq('targetType', targetType);
            // A cursor from another kind's tie (the merged tab's) keeps its own time's rows after it.
            return ownTie || DELETED_KINDS.indexOf(targetType) < (after.kind ?? 0)
              ? b.lt('withdrawnAt', after.key)
              : b.lte('withdrawnAt', after.key);
          })
          .order('desc')
          .take(k),
      ),
    ]);
    return [...tie, ...rest].slice(0, n);
  }
  if (after === null)
    return reads.take('withdrawal', n, (k) =>
      ctx.db
        .query('contentWithdrawals')
        .withIndex('by_subject_held', (q) => q.eq('subjectUserId', userId).eq('held', false))
        .order('desc')
        .take(k),
    );
  const rank = DELETED_KINDS.length - 1 - (after.kind ?? 0);
  const [tie, laterKinds, earlier] = await Promise.all([
    reads.take('withdrawal', n, (k) =>
      ctx.db
        .query('contentWithdrawals')
        .withIndex('by_subject_held', (q) =>
          q
            .eq('subjectUserId', userId)
            .eq('held', false)
            .eq('withdrawnAt', after.key)
            .eq('kindRank', rank)
            .lt('targetCreatedAt', after.ct),
        )
        .order('desc')
        .take(k),
    ),
    reads.take('withdrawal', n, (k) =>
      ctx.db
        .query('contentWithdrawals')
        .withIndex('by_subject_held', (q) =>
          q
            .eq('subjectUserId', userId)
            .eq('held', false)
            .eq('withdrawnAt', after.key)
            .lt('kindRank', rank),
        )
        .order('desc')
        .take(k),
    ),
    reads.take('withdrawal', n, (k) =>
      ctx.db
        .query('contentWithdrawals')
        .withIndex('by_subject_held', (q) =>
          q.eq('subjectUserId', userId).eq('held', false).lt('withdrawnAt', after.key),
        )
        .order('desc')
        .take(k),
    ),
  ]);
  return [...tie, ...laterKinds, ...earlier].slice(0, n);
}
