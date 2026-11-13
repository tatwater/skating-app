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
  movesVerdict,
  replayVerdicts,
  subjectOf,
  type VerdictTargetType,
} from './lib/contentVerdicts';
import { ERASABLE, holdMoved, withdrawnAtOf } from './lib/eraseClock';

/** Rows per list on the record — a person's standing verdicts and recent deletions are a handful. */
const RECORD_LIMIT = 100;
/** Rows per backfill page; each page is its own transaction and schedules the next. */
const BACKFILL_PAGE = 200;
/**
 * An item's history read by the backfill, newest first. Far past any real item's (a handful of rows
 * each); an item that reaches it is left as it stands rather than replayed in part, and the
 * backfill says so.
 */
export const HISTORY_LIMIT = 100;

type ContentDoc =
  | Doc<'reports'>
  | Doc<'posts'>
  | Doc<'comments'>
  | Doc<'hazards'>
  | Doc<'accessAlerts'>;

async function loadTarget(
  ctx: QueryCtx,
  targetType: VerdictTargetType,
  targetId: string,
): Promise<ContentDoc | null> {
  // A verdict's targets are what an author can withdraw (`lib/authorDeletion`), and an alert its
  // author retracted — every one of them erasable, so the erasure map names its table.
  const id = ctx.db.normalizeId(ERASABLE[targetType], targetId);
  return id ? ((await ctx.db.get(id)) as ContentDoc | null) : null;
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

/**
 * The person's standing verdicts — each with the content still readable where it is kept, labeled
 * when its author deleted it afterward, and when it is due to be erased once the verdict ends — and
 * what they withdrew themselves, newest first, with when each is due to be erased.
 */
export const personContentRecord = query({
  args: { userId: v.id('profiles') },
  handler: async (ctx, { userId }) => {
    await requireCapability(ctx, 'people.read');
    const standing = await ctx.db
      .query('contentVerdicts')
      .withIndex('by_subject_standing', (q) => q.eq('subjectUserId', userId).eq('standing', true))
      .order('desc')
      .take(RECORD_LIMIT);
    const verdicts = await Promise.all(
      standing.map(async (verdict) => {
        const [action, target] = await Promise.all([
          ctx.db.get(verdict.actionId),
          loadTarget(ctx, verdict.targetType, verdict.targetId),
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

    // Their own withdrawals, newest first. Each range carries its lower bound: `authorDeletedAt` is
    // optional, and an absent value sorts first.
    const deleted: {
      targetType: VerdictTargetType;
      targetId: string;
      deletedAt: number;
      eraseAt: number | null;
      content: ReturnType<typeof contentOf>;
    }[] = [];
    const push = (targetType: VerdictTargetType, row: ContentDoc) => {
      // An erased comment's placeholder is no longer anything they wrote.
      if ('erasedAt' in row && row.erasedAt !== undefined) return;
      deleted.push({
        targetType,
        targetId: row._id,
        deletedAt: withdrawnAt(targetType, row) as number,
        eraseAt: row.eraseAt ?? null,
        content: contentOf(targetType, row),
      });
    };
    for (const row of await ctx.db
      .query('posts')
      .withIndex('by_author_deleted', (q) => q.eq('authorId', userId).gt('authorDeletedAt', 0))
      .order('desc')
      .take(RECORD_LIMIT))
      push('post', row);
    for (const row of await ctx.db
      .query('reports')
      .withIndex('by_author_deleted', (q) => q.eq('authorId', userId).gt('authorDeletedAt', 0))
      .order('desc')
      .take(RECORD_LIMIT))
      push('report', row);
    for (const row of await ctx.db
      .query('comments')
      .withIndex('by_author_deleted', (q) => q.eq('authorId', userId).gt('authorDeletedAt', 0))
      .order('desc')
      .take(RECORD_LIMIT))
      push('comment', row);
    for (const row of await ctx.db
      .query('hazards')
      .withIndex('by_author_deleted', (q) =>
        q.eq('createdByUserId', userId).gt('authorDeletedAt', 0),
      )
      .order('desc')
      .take(RECORD_LIMIT))
      push('hazard', row);
    // Alerts they retracted themselves (a moderator's retraction is not theirs to list).
    for (const row of await ctx.db
      .query('accessAlerts')
      .withIndex('by_author_status_expires_at', (q) =>
        q.eq('createdByUserId', userId).eq('status', 'retracted'),
      )
      .order('desc')
      .take(RECORD_LIMIT)) {
      if (withdrawnAtOf('accessAlert', row) !== undefined) push('accessAlert', row);
    }
    deleted.sort((a, b) => b.deletedAt - a.deletedAt);
    return { verdicts, deleted: deleted.slice(0, RECORD_LIMIT) };
  },
});

// ── The backfill (run once on each deployment after this ships) ──────────────────────────────────

const CONTENT_TYPES: ReadonlySet<string> = new Set([
  'report',
  'post',
  'comment',
  'hazard',
  'accessAlert',
]);

/** An item's audit rows, newest first, bounded — one more than the limit, to know it was reached. */
function historyOf(ctx: QueryCtx, targetType: VerdictTargetType, targetId: string) {
  return ctx.db
    .query('moderationActions')
    .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
    .order('desc')
    .take(HISTORY_LIMIT + 1);
}

/**
 * One page of the audit log: build the person's record by replaying each moderated item's history
 * through the live writers' rules (`replayVerdicts`) — every verdict since the audit log began,
 * including a takedown recorded on content its author had already deleted (written as history only
 * before the record existed). Idempotent: a verdict row is keyed by its action and brought to what
 * the replay says. When the last page is done it starts the erasure clocks' backfill, which must not
 * run before the verdicts that hold content back exist. Self-chaining; run once after deploy:
 * `convex run contentRecord:backfillVerdicts '{}'`.
 */
export const backfillVerdicts = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    pageSize: v.optional(v.number()),
    /** Test seam: stop after the record, without starting the clocks. */
    clocks: v.optional(v.boolean()),
  },
  handler: async (ctx, { cursor, pageSize, clocks }) => {
    const size = Math.min(Math.max(pageSize ?? BACKFILL_PAGE, 1), BACKFILL_PAGE);
    const page = await ctx.db
      .query('moderationActions')
      .order('asc')
      .paginate({ cursor: cursor ?? null, numItems: size });
    let verdicts = 0;
    const truncated: string[] = [];
    const replayed = new Set<string>();
    for (const row of page.page) {
      if (!CONTENT_TYPES.has(row.targetType) || !movesVerdict(row)) continue;
      const targetType = row.targetType as VerdictTargetType;
      const key = `${targetType}:${row.targetId}`;
      if (replayed.has(key)) continue;
      replayed.add(key);
      const result = await replayItem(ctx, targetType, row.targetId);
      verdicts += result.written;
      if (result.truncated) truncated.push(key);
    }
    if (truncated.length > 0) {
      console.error(
        `contentRecord: ${truncated.length} item(s) carry more than ${HISTORY_LIMIT} audit rows and were left untouched (their history can't be read whole here): ${truncated.join(', ')}`,
      );
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.contentRecord.backfillVerdicts, {
        cursor: page.continueCursor,
        ...(pageSize !== undefined ? { pageSize } : {}),
        ...(clocks !== undefined ? { clocks } : {}),
      });
    } else if (clocks !== false) {
      await ctx.scheduler.runAfter(0, internal.erasure.backfillClocks, {});
    }
    return { verdicts, truncated, more: !page.isDone };
  },
});

/**
 * Bring one item's verdict rows to what its history says: insert the missing, correct any whose
 * standing differs (a live write that ran before the backfill reached the history it supersedes),
 * and drop any the rules never make (one written by an earlier build). Returns how many rows it
 * wrote, and whether the history was longer than the read.
 */
async function replayItem(
  ctx: MutationCtx,
  targetType: VerdictTargetType,
  targetId: string,
): Promise<{ written: number; truncated: boolean }> {
  const target = await loadTarget(ctx, targetType, targetId);
  if (!target) return { written: 0, truncated: false };
  const read = await historyOf(ctx, targetType, targetId);
  const truncated = read.length > HISTORY_LIMIT;
  // A history longer than the read is not known whole, and a replay of part of it could end or drop
  // a verdict that stands (and so let the item be erased). Unknown is not "nothing there": leave its
  // rows exactly as they are, and say so.
  if (truncated) return { written: 0, truncated };
  const history = read.slice(0, HISTORY_LIMIT).reverse();
  const replayed = replayVerdicts(history);
  let written = 0;
  const made = new Set<string>(replayed.map((verdict) => verdict.actionId));
  const seen = new Set<string>(history.map((row) => row._id));
  const onItem = await ctx.db
    .query('contentVerdicts')
    .withIndex('by_target_standing', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
    .take(HISTORY_LIMIT);
  for (const row of onItem) {
    if (seen.has(row.actionId) && !made.has(row.actionId)) {
      await ctx.db.delete(row._id);
      written++;
    }
  }
  for (const verdict of replayed) {
    const existing = await ctx.db
      .query('contentVerdicts')
      .withIndex('by_action', (q) => q.eq('actionId', verdict.actionId))
      .first();
    if (!existing) {
      await ctx.db.insert('contentVerdicts', {
        subjectUserId: subjectOf(targetType, target),
        targetType,
        targetId,
        ...verdict,
      });
      written++;
    } else if (
      existing.standing !== verdict.standing ||
      existing.endedByActionId !== verdict.endedByActionId
    ) {
      await ctx.db.patch(existing._id, {
        standing: verdict.standing,
        endedAt: verdict.endedAt,
        endedByActionId: verdict.endedByActionId,
      });
      written++;
    }
  }
  // A verdict rebuilt here holds the item from erasure as a live one does.
  if (written > 0) await holdMoved(ctx, targetType, targetId);
  return { written, truncated };
}
