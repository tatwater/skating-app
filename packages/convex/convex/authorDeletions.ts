/**
 * Stamping `authorDeletedAt` on content its author deleted before the stamp existed (D248). Run once
 * on each deployment after this ships; both are self-chaining, idempotent (a stamp is never moved),
 * and page with a size seam so the continuation is testable.
 */
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import {
  authorDeletedAtOf,
  isWithdrawable,
  WITHDRAWABLE_TABLE,
  type Withdrawable,
} from './lib/authorDeletion';

/** Rows per backfill page; each page is its own transaction and schedules the next. */
const BACKFILL_PAGE = 200;

/** An item's audit rows, newest first, bounded. */
function historyOf(ctx: QueryCtx, targetType: Withdrawable, targetId: string) {
  return ctx.db
    .query('moderationActions')
    .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
    .order('desc')
    .take(100);
}

/**
 * Stamp the content one historic `author_delete` row withdrew, if it still answers to it: still
 * removed, and not restored by a moderator since (which a moderator could do before D248 — the
 * last word was theirs); a restore that was itself undone put it back where its author left it. A
 * Post its last Report's deletion emptied was not deleted by its author (the live writer leaves it
 * unstamped too); a Post its author did delete takes every removed member with it, a member a
 * moderator removed first included, as `authorRemovePost` does now.
 */
async function stampFromRow(ctx: MutationCtx, row: Doc<'moderationActions'>): Promise<number> {
  const targetType = row.targetType;
  if (!isWithdrawable(targetType)) return 0;
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  if (targetType === 'post' && meta.derivedFromReportId !== undefined) return 0;
  const id = ctx.db.normalizeId(WITHDRAWABLE_TABLE[targetType], row.targetId);
  const target = id ? await ctx.db.get(id) : null;
  if (!target || authorDeletedAtOf(target) !== undefined) return 0;
  if (target.moderationStatus !== 'removed') return 0;
  const history = await historyOf(ctx, targetType, row.targetId);
  const undone = new Set(history.flatMap((r) => (r.undoesActionId ? [r.undoesActionId] : [])));
  const restoredSince = history.some(
    (r) => r._creationTime > row._creationTime && r.action === 'restore' && !undone.has(r._id),
  );
  if (restoredSince) return 0;
  await ctx.db.patch(target._id, { authorDeletedAt: row.createdAt });
  let stamped = 1;
  if (targetType === 'post') {
    for (const reportId of (target as Doc<'posts'>).reportIds) {
      const report = await ctx.db.get(reportId);
      if (!report || report.authorDeletedAt !== undefined) continue;
      if (report.moderationStatus !== 'removed') continue;
      await ctx.db.patch(reportId, { authorDeletedAt: row.createdAt });
      stamped++;
    }
  }
  return stamped;
}

/**
 * One page of the audit log: stamp the content every `author_delete` row withdrew, at that row's own
 * instant. Self-chaining: `convex run authorDeletions:backfillFromAudit '{}'`.
 */
export const backfillFromAudit = internalMutation({
  args: { cursor: v.optional(v.string()), pageSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, pageSize }) => {
    const size = Math.min(Math.max(pageSize ?? BACKFILL_PAGE, 1), BACKFILL_PAGE);
    const page = await ctx.db
      .query('moderationActions')
      .order('asc')
      .paginate({ cursor: cursor ?? null, numItems: size });
    let stamped = 0;
    for (const row of page.page) {
      if (row.action === 'author_delete') stamped += await stampFromRow(ctx, row);
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.authorDeletions.backfillFromAudit, {
        cursor: page.continueCursor,
        ...(pageSize !== undefined ? { pageSize } : {}),
      });
    }
    return { stamped, more: !page.isDone };
  },
});

/**
 * Comments deleted by their author before deletion was audited left no row: a removed comment whose
 * last moderator word is not a remove is the author's (a comment is removed by nothing else). Stamped
 * at the backfill — the true instant is unknown, and a clock never starts in the past.
 * Self-chaining: `convex run authorDeletions:backfillCommentDeletions '{}'`.
 */
export const backfillCommentDeletions = internalMutation({
  args: { cursor: v.optional(v.string()), pageSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, pageSize }) => {
    const size = Math.min(Math.max(pageSize ?? BACKFILL_PAGE, 1), BACKFILL_PAGE);
    const now = Date.now();
    const page = await ctx.db
      .query('comments')
      .paginate({ cursor: cursor ?? null, numItems: size });
    let stamped = 0;
    for (const comment of page.page) {
      if (comment.moderationStatus !== 'removed' || comment.authorDeletedAt !== undefined) continue;
      const history = await historyOf(ctx, 'comment', comment._id);
      const lastWord = history.find((r) => ['hide', 'remove', 'restore'].includes(r.action));
      if (lastWord?.action === 'remove') continue;
      await ctx.db.patch(comment._id, { authorDeletedAt: now });
      stamped++;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.authorDeletions.backfillCommentDeletions, {
        cursor: page.continueCursor,
        ...(pageSize !== undefined ? { pageSize } : {}),
      });
    }
    return { stamped, more: !page.isDone };
  },
});
