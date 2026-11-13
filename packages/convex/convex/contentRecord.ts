/**
 * A person's moderation record on their content, for the People page (D248, the founder's rulings
 * of 2026-11-13), and the backfill that builds it from the audit log.
 *
 * Staff-only: gated like the other People reads, and nothing here reaches a skater-facing read or a
 * score (D17/D50 stay boost-only). The page itself mounts it with the People workstream.
 */
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx, query } from './_generated/server';
import { requireCapability } from './lib/auth';
import { authorDeletedAtOf } from './lib/authorDeletion';
import {
  REPLAY_START,
  type ReplayedVerdict,
  type ReplayState,
  replayStep,
  subjectOf,
  type VerdictTargetType,
} from './lib/contentVerdicts';
import { ERASABLE, HOLD_COST, holdMoved, withdrawnAtOf } from './lib/eraseClock';
import { DOC_MAX, ReadBudget, ROW_MAX, TX_BUDGET } from './lib/readBudget';
import { literals } from './lib/validators';

/** Rows per page of the record, at most — each page is also sized by what its rows can weigh. */
const RECORD_PAGE = 50;
/** Audit rows per backfill page, at most; each page is its own transaction and schedules the next. */
const BACKFILL_PAGE = 200;

type ContentDoc =
  | Doc<'reports'>
  | Doc<'posts'>
  | Doc<'comments'>
  | Doc<'hazards'>
  | Doc<'accessAlerts'>;

/** The item a verdict is on, charged at its kind's worst case. */
async function loadTarget(
  ctx: QueryCtx,
  reads: ReadBudget,
  targetType: VerdictTargetType,
  targetId: string,
): Promise<ContentDoc | null> {
  // A verdict's targets are what an author can withdraw (`lib/authorDeletion`), and an alert its
  // author retracted — every one of them erasable, so the erasure map names its table.
  const id = ctx.db.normalizeId(ERASABLE[targetType], targetId);
  if (!id) return null;
  return (await reads.one(targetType, () => ctx.db.get(id))) as ContentDoc | null;
}

/** When its author took it back, if they did — a deletion, or an alert's own retraction. */
function withdrawnAt(targetType: VerdictTargetType, doc: ContentDoc): number | null {
  if (targetType === 'accessAlert') return withdrawnAtOf('accessAlert', doc) ?? null;
  return authorDeletedAtOf(doc as Exclude<ContentDoc, Doc<'accessAlerts'>>) ?? null;
}

/** What staff read of an item on the record: the words still kept, and when it was made. */
function contentOf(targetType: VerdictTargetType, doc: ContentDoc) {
  switch (targetType) {
    case 'report': {
      const r = doc as Doc<'reports'>;
      return { at: r.skateEndTime, text: r.notes ?? null };
    }
    case 'post': {
      const p = doc as Doc<'posts'>;
      return { at: p.latestSkateEndTime, title: p.title ?? null, text: p.body ?? null };
    }
    case 'comment': {
      const c = doc as Doc<'comments'>;
      return { at: c.createdAt, text: c.body };
    }
    case 'hazard': {
      const h = doc as Doc<'hazards'>;
      return { at: h.firstReportedAt, title: h.type, text: h.description ?? null };
    }
    case 'accessAlert': {
      const a = doc as Doc<'accessAlerts'>;
      return { at: a.createdAt, title: a.reason, text: a.note ?? null };
    }
  }
}

/** The record's pages run beside the caller's own profile read (`requireCapability`). */
const recordBudget = () => new ReadBudget(TX_BUDGET - ROW_MAX.profile);

const VERDICT_TARGETS = ['report', 'post', 'comment', 'hazard', 'accessAlert'] as const;

/**
 * The person's standing verdicts, newest first, a page at a time — each with the content still
 * readable where it is kept, labeled when its author deleted it afterward. Each verdict reads its
 * action and its item, so a page is sized by what those can weigh: a short page is not the end,
 * `isDone` is. Staff only.
 */
export const personVerdicts = query({
  args: { userId: v.id('profiles'), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { userId, cursor }) => {
    await requireCapability(ctx, 'people.read');
    const reads = recordBudget();
    const perRow = ROW_MAX.verdict + ROW_MAX.moderationAction + DOC_MAX;
    const page = await reads.page(
      'verdict',
      reads.rows('verdict', RECORD_PAGE, 0, perRow),
      (numItems) =>
        ctx.db
          .query('contentVerdicts')
          .withIndex('by_subject_standing', (q) =>
            q.eq('subjectUserId', userId).eq('standing', true),
          )
          .order('desc')
          .paginate({ cursor: cursor ?? null, numItems }),
    );
    const verdicts = await Promise.all(
      page.page.map(async (verdict) => {
        const [action, target] = await Promise.all([
          reads.one('moderationAction', () => ctx.db.get(verdict.actionId)),
          loadTarget(ctx, reads, verdict.targetType, verdict.targetId),
        ]);
        return {
          targetType: verdict.targetType,
          targetId: verdict.targetId,
          kind: verdict.kind,
          at: verdict.at,
          reason: action?.reason ?? null,
          byUserId: action?.actorId ?? null,
          content: target ? contentOf(verdict.targetType, target) : null,
          authorDeletedAt: target ? withdrawnAt(verdict.targetType, target) : null,
        };
      }),
    );
    return { page: verdicts, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/**
 * What the person withdrew themselves, of one kind, newest first, a page at a time — with when each is
 * due to be erased. Each range carries its lower bound: `authorDeletedAt` is optional, and an absent
 * value sorts first. An alert counts only when its author retracted it (a moderator's retraction is
 * not theirs to list). Staff only.
 */
export const personWithdrawals = query({
  args: {
    userId: v.id('profiles'),
    kind: literals(VERDICT_TARGETS),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { userId, kind, cursor }) => {
    await requireCapability(ctx, 'people.read');
    const reads = recordBudget();
    const opts = (numItems: number) => ({ cursor: cursor ?? null, numItems });
    const n = reads.rows(kind, RECORD_PAGE);
    const page = await (async () => {
      switch (kind) {
        case 'post':
          return reads.page(kind, n, (numItems) =>
            ctx.db
              .query('posts')
              .withIndex('by_author_deleted', (q) =>
                q.eq('authorId', userId).gt('authorDeletedAt', 0),
              )
              .order('desc')
              .paginate(opts(numItems)),
          );
        case 'report':
          return reads.page(kind, n, (numItems) =>
            ctx.db
              .query('reports')
              .withIndex('by_author_deleted', (q) =>
                q.eq('authorId', userId).gt('authorDeletedAt', 0),
              )
              .order('desc')
              .paginate(opts(numItems)),
          );
        case 'comment':
          return reads.page(kind, n, (numItems) =>
            ctx.db
              .query('comments')
              .withIndex('by_author_deleted', (q) =>
                q.eq('authorId', userId).gt('authorDeletedAt', 0),
              )
              .order('desc')
              .paginate(opts(numItems)),
          );
        case 'hazard':
          return reads.page(kind, n, (numItems) =>
            ctx.db
              .query('hazards')
              .withIndex('by_author_deleted', (q) =>
                q.eq('createdByUserId', userId).gt('authorDeletedAt', 0),
              )
              .order('desc')
              .paginate(opts(numItems)),
          );
        case 'accessAlert':
          return reads.page(kind, n, (numItems) =>
            ctx.db
              .query('accessAlerts')
              .withIndex('by_author_status_expires_at', (q) =>
                q.eq('createdByUserId', userId).eq('status', 'retracted'),
              )
              .order('desc')
              .paginate(opts(numItems)),
          );
      }
    })();
    const rows = (page.page as ContentDoc[]).filter(
      // An erased comment's placeholder is no longer anything they wrote; a moderator's retraction
      // of their alert is not their withdrawal.
      (row) =>
        !('erasedAt' in row && row.erasedAt !== undefined) && withdrawnAt(kind, row) !== null,
    );
    return {
      page: rows.map((row) => ({
        targetType: kind,
        targetId: row._id as string,
        deletedAt: withdrawnAt(kind, row) as number,
        eraseAt: row.eraseAt ?? null,
        content: contentOf(kind, row),
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

// ── The backfill (run once on each deployment after this ships) ──────────────────────────────────

const CONTENT_TYPES: ReadonlySet<string> = new Set(VERDICT_TARGETS);

const replayStateValidator = v.object({
  standing: v.union(
    v.null(),
    v.object({
      actionId: v.id('moderationActions'),
      kind: literals(['hidden', 'removed', 'retracted'] as const),
      at: v.number(),
    }),
  ),
  previousEnded: v.boolean(),
});
const resumeValidator = v.object({ cursor: v.union(v.string(), v.null()), skip: v.number() });

/**
 * Walk the audit log and rebuild every item's record from its **whole** history, through the live
 * writers' rules (`replayStep`): every verdict since the audit log began, including a takedown recorded
 * on content its author had already deleted (written as history only before the record existed).
 * Idempotent: a verdict row is keyed by its action and brought to what the replay says.
 *
 * Each item is replayed once, when the walk reaches its newest audit row, by
 * `replayVerdictHistory` — a job that reads the item's history to its end a page at a time, however
 * long, and hands the walk back where it left off. Nothing is guessed: there is no history too long to
 * read, so there is no fallback. The walk is one chain, so when its last page is done every item is
 * replayed, and only then does it start the erasure clocks' backfill, which must not run before the
 * verdicts that hold content back exist. Run once after deploy:
 * `convex run contentRecord:backfillVerdicts '{}'`.
 */
export const backfillVerdicts = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    /** Rows of the page at `cursor` already walked (a replay hands the walk back mid-page). */
    skip: v.optional(v.number()),
    pageSize: v.optional(v.number()),
    /** Test seam: stop after the record, without starting the clocks. */
    clocks: v.optional(v.boolean()),
  },
  handler: async (ctx, { cursor, skip = 0, pageSize, clocks }) => {
    const reads = new ReadBudget();
    const size = Math.min(Math.max(pageSize ?? BACKFILL_PAGE, 1), BACKFILL_PAGE);
    // A row, its item's newest row; and once, the item itself.
    const perRow = 2 * ROW_MAX.moderationAction;
    const page = await reads.page(
      'moderationAction',
      reads.rows('moderationAction', size, DOC_MAX, perRow),
      (numItems) =>
        ctx.db
          .query('moderationActions')
          .order('asc')
          .paginate({ cursor: cursor ?? null, numItems }),
    );
    const carry = {
      ...(pageSize !== undefined ? { pageSize } : {}),
      ...(clocks !== undefined ? { clocks } : {}),
    };
    for (let i = skip; i < page.page.length; i++) {
      const row = page.page[i] as Doc<'moderationActions'>;
      if (!CONTENT_TYPES.has(row.targetType)) continue;
      const targetType = row.targetType as VerdictTargetType;
      const newest = await reads.one('moderationAction', () =>
        ctx.db
          .query('moderationActions')
          .withIndex('by_target', (q) =>
            q.eq('targetType', targetType).eq('targetId', row.targetId),
          )
          .order('desc')
          .first(),
      );
      if (newest?._id !== row._id) continue;
      const target = await loadTarget(ctx, reads, targetType, row.targetId);
      if (!target) continue;
      await ctx.scheduler.runAfter(0, internal.contentRecord.replayVerdictHistory, {
        targetType,
        targetId: row.targetId,
        subjectUserId: subjectOf(targetType, target),
        pass: 'scan' as const,
        resume: { cursor: cursor ?? null, skip: i + 1 },
        ...carry,
      });
      return { replaying: `${targetType}:${row.targetId}`, more: true };
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.contentRecord.backfillVerdicts, {
        cursor: page.continueCursor,
        ...carry,
      });
      return { replaying: null, more: true };
    }
    if (clocks !== false) await ctx.scheduler.runAfter(0, internal.erasure.backfillClocks, {});
    return { replaying: null, more: false };
  },
});

/** What finishing a pass reads: the final verdict's row, and the item's clock (`holdMoved`). */
const FINISH = 2 * ROW_MAX.verdict + 2 * DOC_MAX + HOLD_COST.report;

/**
 * Replay one item's whole history, oldest first, a page a transaction, carrying the replay's small
 * state (`ReplayState`) between them — then hand the audit walk back. Two passes, so no reader ever
 * sees the item less held than its history leaves it:
 *
 * 1. **scan** reads to the end and makes the verdict the history leaves standing stand (inserting it,
 *    or standing it up again), and moves the item's clock — only ever adding a hold.
 * 2. **write** reads it again and brings every other row to the history: a verdict the history ended
 *    is ended (inserted ended, if it was missing), and a row keyed by an action that mints nothing (an
 *    earlier build's) is deleted. The standing one is never touched here, so the item stays held
 *    throughout if its history holds it. Rows a moderator adds meanwhile are read too, at the end.
 */
export const replayVerdictHistory = internalMutation({
  args: {
    targetType: literals(VERDICT_TARGETS),
    targetId: v.string(),
    subjectUserId: v.id('profiles'),
    pass: literals(['scan', 'write'] as const),
    cursor: v.optional(v.string()),
    state: v.optional(replayStateValidator),
    resume: resumeValidator,
    pageSize: v.optional(v.number()),
    clocks: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { targetType, targetId, subjectUserId, pass, cursor, resume, pageSize, clocks } = args;
    const reads = new ReadBudget();
    // A row; in the write pass, the row keyed by it and the one it ends, each looked up and written.
    const perRow = ROW_MAX.moderationAction + 4 * ROW_MAX.verdict;
    const page = await reads.page(
      'moderationAction',
      reads.rows('moderationAction', pageSize ?? BACKFILL_PAGE, FINISH, perRow),
      (numItems) =>
        ctx.db
          .query('moderationActions')
          .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
          .order('asc')
          .paginate({ cursor: cursor ?? null, numItems }),
    );
    const upsert = async (verdict: ReplayedVerdict) => {
      const existing = await reads.one('verdict', () =>
        ctx.db
          .query('contentVerdicts')
          .withIndex('by_action', (q) => q.eq('actionId', verdict.actionId))
          .first(),
      );
      if (!existing) {
        await ctx.db.insert('contentVerdicts', { subjectUserId, targetType, targetId, ...verdict });
        return 1;
      }
      if (
        existing.standing === verdict.standing &&
        existing.endedByActionId === verdict.endedByActionId
      ) {
        return 0;
      }
      reads.touch('verdict');
      await ctx.db.patch(existing._id, {
        standing: verdict.standing,
        endedAt: verdict.endedAt,
        endedByActionId: verdict.endedByActionId,
      });
      return 1;
    };
    let state: ReplayState = args.state ?? REPLAY_START;
    let written = 0;
    for (const row of page.page) {
      const step = replayStep(state, row);
      if (pass === 'write') {
        if (!step.minted) {
          // A row keyed by an action that mints nothing is not what the rules make.
          const stray = await reads.one('verdict', () =>
            ctx.db
              .query('contentVerdicts')
              .withIndex('by_action', (q) => q.eq('actionId', row._id))
              .first(),
          );
          if (stray) {
            reads.touch('verdict');
            await ctx.db.delete(stray._id);
            written++;
          }
        }
        if (step.ended) written += await upsert(step.ended);
      }
      state = step.state;
    }
    const base = {
      targetType,
      targetId,
      subjectUserId,
      resume,
      ...(pageSize !== undefined ? { pageSize } : {}),
      ...(clocks !== undefined ? { clocks } : {}),
    };
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.contentRecord.replayVerdictHistory, {
        ...base,
        pass,
        cursor: page.continueCursor,
        state,
      });
      return { written, more: true };
    }
    // The end of its history: what it leaves standing stands, and the clock follows.
    if (state.standing) written += await upsert({ ...state.standing, standing: true });
    await holdMoved(ctx, targetType, targetId, Date.now(), reads);
    if (pass === 'scan') {
      await ctx.scheduler.runAfter(0, internal.contentRecord.replayVerdictHistory, {
        ...base,
        pass: 'write' as const,
      });
    } else {
      await ctx.scheduler.runAfter(0, internal.contentRecord.backfillVerdicts, {
        cursor: resume.cursor,
        skip: resume.skip,
        ...(pageSize !== undefined ? { pageSize } : {}),
        ...(clocks !== undefined ? { clocks } : {}),
      });
    }
    return { written, more: pass === 'scan' };
  },
});
