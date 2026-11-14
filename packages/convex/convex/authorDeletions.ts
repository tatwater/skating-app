/**
 * Stamping `authorDeletedAt` on content its author deleted before the stamp existed (D248). Run once
 * on each deployment after this ships; both are self-chaining, idempotent (a stamp is never moved),
 * and page with a size seam so the continuation is testable.
 *
 * **Every answer is read whole.** Whether a deletion still stands ("not restored since") and what a
 * comment's last moderator word was are questions about an item's history, which has no length cap.
 * So each walk hands one item at a time to a job that reads that history a charged page per
 * transaction, as far as the answer needs (to the end, or to the first row that decides it), and then
 * hands the walk back where it left off. No history is too long to read, so nothing is left unknown,
 * and nothing is guessed. Every read is charged against `lib/readBudget`.
 */
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import {
  authorDeletedAtOf,
  isWithdrawable,
  WITHDRAWABLE_TABLE,
  type Withdrawable,
} from './lib/authorDeletion';
import { DOC_MAX, ReadBudget, ROW_MAX, sizePage, traced } from './lib/readBudget';
import { literals } from './lib/validators';

/** Rows per backfill page, at most; each page is its own transaction and schedules the next. */
const BACKFILL_PAGE = 200;

/** Where the audit walk resumes. A position on its page is stable: the audit log is append-only. */
const resumeValidator = v.object({ cursor: v.union(v.string(), v.null()), skip: v.number() });
type Resume = { cursor: string | null; skip: number };

/** The item one audit row is about, charged at its kind's worst case. */
async function loadWithdrawable(
  ctx: MutationCtx,
  reads: ReadBudget,
  targetType: Withdrawable,
  targetId: string,
) {
  const id = ctx.db.normalizeId(WITHDRAWABLE_TABLE[targetType], targetId);
  if (!id) return null;
  return reads.one(targetType, () => ctx.db.get(id));
}

/** Whether a historic deletion's item still answers to it: there, unstamped, and not shown. */
function stillDown(target: Awaited<ReturnType<typeof loadWithdrawable>>) {
  return (
    target !== null &&
    authorDeletedAtOf(target) === undefined &&
    target.moderationStatus !== 'visible'
  );
}

/**
 * One page of the audit log: hand every `author_delete` row whose item still answers to it to
 * `stampWithdrawal`, which decides from the item's history whether to stamp it at that row's own
 * instant. Self-chaining: `convex run authorDeletions:backfillFromAudit '{}'`.
 */
export const backfillFromAudit = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    skip: v.optional(v.number()),
    pageSize: v.optional(v.number()),
  },
  handler: (ctx, args) =>
    traced('authorDeletions.backfillFromAudit', args, async () => {
      const { cursor, skip = 0, pageSize } = args;
      const reads = new ReadBudget();
      const size = Math.min(Math.max(pageSize ?? BACKFILL_PAGE, 1), BACKFILL_PAGE);
      // A row and the item it names.
      const page = await reads.page(
        'moderationAction',
        // A row's work beside its read: the item it names, looked up on every `author_delete` row.
        sizePage(reads, 'moderationAction', { cap: size, work: DOC_MAX }),
        (numItems) =>
          ctx.db
            .query('moderationActions')
            .order('asc')
            .paginate({ cursor: cursor ?? null, numItems }),
      );
      const carry = pageSize !== undefined ? { pageSize } : {};
      for (let i = skip; i < page.page.length; i++) {
        const row = page.page[i] as Doc<'moderationActions'>;
        if (row.action !== 'author_delete' || !isWithdrawable(row.targetType)) continue;
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        // A Post its last Report's deletion emptied was not deleted by its author (the live writer
        // leaves it unstamped too).
        if (row.targetType === 'post' && meta.derivedFromReportId !== undefined) continue;
        const targetType = row.targetType;
        const target = await reads.row(DOC_MAX, () =>
          loadWithdrawable(ctx, reads, targetType, row.targetId),
        );
        if (!stillDown(target)) continue;
        await ctx.scheduler.runAfter(0, internal.authorDeletions.stampWithdrawal, {
          targetType: row.targetType,
          targetId: row.targetId,
          deletedAt: row.createdAt,
          after: row._creationTime,
          resume: { cursor: cursor ?? null, skip: i + 1 },
          ...carry,
        });
        return { handedOff: true, more: true };
      }
      if (!page.isDone) {
        await ctx.scheduler.runAfter(0, internal.authorDeletions.backfillFromAudit, {
          cursor: page.continueCursor,
          ...carry,
        });
      }
      return { handedOff: false, more: !page.isDone };
    }),
});

/**
 * Stamp the content one historic `author_delete` row withdrew, if it still answers to it: still
 * down, and not restored by a moderator since (which a moderator could do before D248 — the last
 * word was theirs); a restore that was itself undone put it back where its author left it. Down
 * includes hidden: a moderator who hid it after the deletion (before D248 they could) kept it down,
 * and their hide is a verdict on deleted content now, not a way back. A Post its author did delete
 * takes every member that is down with it — one a moderator removed first, and one a moderator hid
 * after the deletion, included: everything inside a deleted Post is withdrawn. A member a moderator
 * brought back up since is left as it stands, live.
 *
 * "Restored since" is every row after the deletion, read a page a transaction until a restore that
 * was not undone answers it or the history ends. The Post's members are stamped a few a transaction.
 */
export const stampWithdrawal = internalMutation({
  args: {
    targetType: literals([
      'report',
      'post',
      'comment',
      'hazard',
    ] as const satisfies readonly Withdrawable[]),
    targetId: v.string(),
    deletedAt: v.number(),
    /** The deletion row's creation time: the history read starts after it. */
    after: v.number(),
    phase: v.optional(literals(['history', 'members'] as const)),
    cursor: v.optional(v.string()),
    /** The members already looked at, in the members phase. */
    done: v.optional(v.array(v.id('reports'))),
    resume: resumeValidator,
    pageSize: v.optional(v.number()),
  },
  handler: (ctx, args) =>
    traced('authorDeletions.stampWithdrawal', args, async () => {
      const { targetType, targetId, deletedAt, after, phase = 'history', cursor, done = [] } = args;
      const reads = new ReadBudget();
      const carry = args.pageSize !== undefined ? { pageSize: args.pageSize } : {};
      const again = (next: {
        phase: 'history' | 'members';
        cursor?: string;
        done?: Id<'reports'>[];
      }) =>
        ctx.scheduler.runAfter(0, internal.authorDeletions.stampWithdrawal, {
          targetType,
          targetId,
          deletedAt,
          after,
          resume: args.resume,
          ...next,
          ...carry,
        });
      if (phase === 'members') {
        await stampMembers(
          ctx,
          reads,
          targetId,
          deletedAt,
          done,
          (next) => again({ phase: 'members', done: next }),
          args.resume,
          args.pageSize,
        );
        return { stamped: 0 };
      }
      // Each row after the deletion, and for a restore, whether an undo names it. Kept back: the
      // item, read and stamped.
      const page = await reads.page(
        'moderationAction',
        // A row's work beside its read: for a restore, whether an undo names it. Kept back: the item,
        // read and stamped.
        sizePage(reads, 'moderationAction', {
          cap: args.pageSize ?? BACKFILL_PAGE,
          work: ROW_MAX.moderationAction,
          reserve: 2 * DOC_MAX,
        }),
        (numItems) =>
          ctx.db
            .query('moderationActions')
            .withIndex('by_target', (q) =>
              q.eq('targetType', targetType).eq('targetId', targetId).gt('_creationTime', after),
            )
            .order('asc')
            .paginate({ cursor: cursor ?? null, numItems }),
      );
      for (const row of page.page) {
        if (row.action !== 'restore') continue;
        const undo = await reads.row(ROW_MAX.moderationAction, () =>
          reads.one('moderationAction', () =>
            ctx.db
              .query('moderationActions')
              .withIndex('by_undoes', (q) => q.eq('undoesActionId', row._id))
              .first(),
          ),
        );
        // Restored since, and the restore stands: the moderator's word was the last.
        if (!undo) return resumeWalk(ctx, args.resume, args.pageSize, 0);
      }
      if (!page.isDone) {
        await again({ phase: 'history', cursor: page.continueCursor });
        return { stamped: 0 };
      }
      const target = await loadWithdrawable(ctx, reads, targetType, targetId);
      if (!target || !stillDown(target)) return resumeWalk(ctx, args.resume, args.pageSize, 0);
      reads.touch(targetType);
      await ctx.db.patch(target._id, { authorDeletedAt: deletedAt });
      if (targetType === 'post' && (target as Doc<'posts'>).reportIds.length > 0) {
        await again({ phase: 'members' });
        return { stamped: 1 };
      }
      return resumeWalk(ctx, args.resume, args.pageSize, 1);
    }),
});

/** A deleted Post's members that are down, stamped a few a transaction; then the walk resumes. */
async function stampMembers(
  ctx: MutationCtx,
  reads: ReadBudget,
  postId: string,
  deletedAt: number,
  done: readonly Id<'reports'>[],
  again: (done: Id<'reports'>[]) => Promise<unknown>,
  resume: Resume,
  pageSize: number | undefined,
) {
  const id = ctx.db.normalizeId('posts', postId);
  const post = id ? await reads.one('post', () => ctx.db.get(id)) : null;
  // By id, never by position: a member erased between passes leaves `reportIds`, and a position
  // would then skip the member after it.
  const seen = new Set<string>(done);
  const todo = (post?.reportIds ?? []).filter((reportId) => !seen.has(reportId));
  const looked: Id<'reports'>[] = [];
  for (const reportId of todo) {
    if (!reads.affords(2 * ROW_MAX.report)) break;
    looked.push(reportId);
    await reads.row(2 * ROW_MAX.report, async () => {
      const report = await reads.one('report', () => ctx.db.get(reportId));
      if (!report || report.authorDeletedAt !== undefined) return;
      if (report.moderationStatus === 'visible') return;
      reads.touch('report');
      await ctx.db.patch(reportId, { authorDeletedAt: deletedAt });
    });
  }
  // The Post and one member always fit a fresh pass, so a pass that looked at none is a plan error.
  if (todo.length > 0 && looked.length === 0) {
    throw new Error('authorDeletions.stampMembers: a pass stamped no member');
  }
  if (looked.length < todo.length) await again([...done, ...looked]);
  else await resumeWalk(ctx, resume, pageSize, 0);
}

async function resumeWalk(
  ctx: MutationCtx,
  resume: Resume,
  pageSize: number | undefined,
  stamped: number,
) {
  await ctx.scheduler.runAfter(0, internal.authorDeletions.backfillFromAudit, {
    cursor: resume.cursor,
    skip: resume.skip,
    ...(pageSize !== undefined ? { pageSize } : {}),
  });
  return { stamped };
}

/**
 * Comments deleted by their author before deletion was audited left no row: a removed comment whose
 * last moderator word is not a remove is the author's (a comment is removed by nothing else). Each
 * removed, unstamped comment is handed to `commentLastWord`, which reads its history newest first
 * until a word decides it, or to its end. Stamped at the backfill — the true instant is unknown, and a
 * clock never starts in the past. Self-chaining: `convex run authorDeletions:backfillCommentDeletions '{}'`.
 */
export const backfillCommentDeletions = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    /** When the comment last handed off from the page at `cursor` was created: the walk goes on after. */
    after: v.optional(v.number()),
    pageSize: v.optional(v.number()),
  },
  handler: (ctx, args) =>
    traced('authorDeletions.backfillCommentDeletions', args, async () => {
      const { cursor, after, pageSize } = args;
      const reads = new ReadBudget();
      const size = Math.min(Math.max(pageSize ?? BACKFILL_PAGE, 1), BACKFILL_PAGE);
      const page = await reads.page(
        'comment',
        sizePage(reads, 'comment', { cap: size }),
        (numItems) => ctx.db.query('comments').paginate({ cursor: cursor ?? null, numItems }),
      );
      const carry = pageSize !== undefined ? { pageSize } : {};
      for (const comment of page.page) {
        // Resumed by creation time, never by position: unlike the audit log, comments are deleted (the
        // sweep erases them), and one gone from earlier on the page would shift a position past the next.
        if (after !== undefined && comment._creationTime <= after) continue;
        if (comment.moderationStatus !== 'removed' || comment.authorDeletedAt !== undefined)
          continue;
        await ctx.scheduler.runAfter(0, internal.authorDeletions.commentLastWord, {
          commentId: comment._id,
          resume: { cursor: cursor ?? null, after: comment._creationTime },
          ...carry,
        });
        return { handedOff: true, more: true };
      }
      if (!page.isDone) {
        await ctx.scheduler.runAfter(0, internal.authorDeletions.backfillCommentDeletions, {
          cursor: page.continueCursor,
          ...carry,
        });
      }
      return { handedOff: false, more: !page.isDone };
    }),
});

/** One removed comment's last moderator word, read newest first a page at a time; then the walk. */
export const commentLastWord = internalMutation({
  args: {
    commentId: v.id('comments'),
    cursor: v.optional(v.string()),
    resume: v.object({ cursor: v.union(v.string(), v.null()), after: v.number() }),
    pageSize: v.optional(v.number()),
  },
  handler: (ctx, args) =>
    traced('authorDeletions.commentLastWord', args, async () => {
      const { commentId, cursor, resume, pageSize } = args;
      const reads = new ReadBudget();
      const carry = pageSize !== undefined ? { pageSize } : {};
      const page = await reads.page(
        'moderationAction',
        sizePage(reads, 'moderationAction', {
          cap: pageSize ?? BACKFILL_PAGE,
          reserve: 2 * ROW_MAX.comment,
        }),
        (numItems) =>
          ctx.db
            .query('moderationActions')
            .withIndex('by_target', (q) => q.eq('targetType', 'comment').eq('targetId', commentId))
            .order('desc')
            .paginate({ cursor: cursor ?? null, numItems }),
      );
      const lastWord = page.page.find((r) => ['hide', 'remove', 'restore'].includes(r.action));
      if (lastWord === undefined && !page.isDone) {
        await ctx.scheduler.runAfter(0, internal.authorDeletions.commentLastWord, {
          commentId,
          cursor: page.continueCursor,
          resume,
          ...carry,
        });
        return { stamped: false };
      }
      let stamped = false;
      // A moderator's remove is theirs; anything else — or no word at all, read to the end — the author's.
      if (lastWord?.action !== 'remove') {
        const comment = await reads.one('comment', () => ctx.db.get(commentId));
        if (
          comment &&
          comment.moderationStatus === 'removed' &&
          comment.authorDeletedAt === undefined
        ) {
          reads.touch('comment');
          await ctx.db.patch(commentId, { authorDeletedAt: Date.now() });
          stamped = true;
        }
      }
      await ctx.scheduler.runAfter(0, internal.authorDeletions.backfillCommentDeletions, {
        cursor: resume.cursor,
        after: resume.after,
        ...carry,
      });
      return { stamped };
    }),
});
