/**
 * Moderation functions (D32/D37) — the minimal founder takedown path. Role-gated
 * (`requireRole('moderator')`); every action writes **exactly one** `moderationActions` audit row
 * (accountability for appeals/reversals). This is the inline hide/remove/restore + flag-resolution
 * surface; the full `/admin` work queues + email alerts are Phase 7 (D37/D38).
 *
 * Moderation applies to the UGC that carries a `moderationStatus` — **reports, comments and hazards**.
 * Hiding a report also hides its comments at read time (a comment on a hidden report is unreachable —
 * see `comments.listByReport`), so no cascade write is needed. Hazards are moderated through the same
 * mutation so the Phase 7 queue has a single takedown entry point, but they carry no contribution
 * counter and their hide is a *moderation* axis kept strictly separate from the community-archival
 * lifecycle `status` (D3) — see the hazards schema note.
 */

import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, type QueryCtx, query } from './_generated/server';
import { requireRole } from './lib/auth';
import { bumpContributionCount, visibleDelta } from './lib/contributionCounts';
import { MODERATION_ACTIONS, MODERATION_STATUSES, MODERATION_TARGET_TYPES } from './lib/enums';
import { literals } from './lib/validators';

/** The audit action implied by a target moderation status (D37). */
const ACTION_FOR_STATUS = {
  visible: 'restore',
  hidden: 'hide',
  removed: 'remove',
} as const;

/**
 * Set a report's or comment's moderation status (D32/D37). `requireRole('moderator')`; patches the
 * target and writes one `hide` / `remove` / `restore` audit row with the required reason. A no-op
 * status change (already at `status`) still records the action — the moderator asserted a decision.
 */
const MODERATION_TABLE = {
  report: 'reports',
  comment: 'comments',
  hazard: 'hazards',
} as const;

export const setModerationStatus = mutation({
  args: {
    targetType: literals(['report', 'comment', 'hazard']),
    targetId: v.string(),
    status: literals(MODERATION_STATUSES),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireRole(ctx, 'moderator');
    if (args.reason.trim().length === 0) throw new ConvexError('A reason is required');

    const targetId = ctx.db.normalizeId(MODERATION_TABLE[args.targetType], args.targetId);
    if (!targetId) throw new ConvexError('Target not found');
    const target = await ctx.db.get(targetId);
    if (!target) throw new ConvexError('Target not found');

    const typedTarget = target as Doc<'reports'> | Doc<'comments'> | Doc<'hazards'>;
    const priorStatus = typedTarget.moderationStatus;
    await ctx.db.patch(targetId, { moderationStatus: args.status });

    // Reports and comments carry a denormalized contribution counter to keep exact; hazards do not.
    // Note we touch ONLY `moderationStatus` — the hazard's lifecycle `status` is deliberately left
    // alone, so a moderator hide is never mistakable for the community archiving a healed hazard (D3).
    if (args.targetType === 'report' || args.targetType === 'comment') {
      const authored = target as Doc<'reports'> | Doc<'comments'>;
      await bumpContributionCount(
        ctx,
        authored.authorId,
        args.targetType === 'report' ? 'reportCount' : 'commentCount',
        visibleDelta(priorStatus, args.status),
      );
    }

    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: ACTION_FOR_STATUS[args.status],
      targetType: args.targetType,
      targetId: args.targetId,
      reason: args.reason,
      metadata: { priorStatus, newStatus: args.status },
      createdAt: Date.now(),
    });
    return targetId;
  },
});

/**
 * Resolve a content flag (D32/D37). `requireRole('moderator')`; sets the flag terminal status
 * (`actioned` / `dismissed`) + `resolvedBy`/`resolvedAt` and writes one `resolve_flag` /
 * `dismiss_flag` audit row. Taking down the flagged content is a separate `setModerationStatus`
 * call (so the two decisions are each audited).
 */
export const resolveFlag = mutation({
  args: {
    flagId: v.id('contentFlags'),
    resolution: literals(['actioned', 'dismissed']),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireRole(ctx, 'moderator');
    if (args.reason.trim().length === 0) throw new ConvexError('A reason is required');

    const flag = await ctx.db.get(args.flagId);
    if (!flag) throw new ConvexError('Flag not found');

    const now = Date.now();
    await ctx.db.patch(args.flagId, {
      status: args.resolution,
      resolvedByUserId: actor._id,
      resolvedAt: now,
    });

    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: args.resolution === 'actioned' ? 'resolve_flag' : 'dismiss_flag',
      targetType: 'contentFlag',
      targetId: args.flagId,
      reason: args.reason,
      createdAt: now,
    });
    return args.flagId;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin queue queries (Phase 7 read side). Every one gates `requireRole('moderator')`,
// reads off an index, and is bounded — a queue read never `.collect()`s a whole table.
// ─────────────────────────────────────────────────────────────────────────────

/** Cap on how many rows any single queue read returns — queues drain oldest-first, so this is a page. */
const QUEUE_LIMIT = 100;

/** Minimal public attribution for a related profile (never private state) — for queue context. */
interface QueueUser {
  userId: string;
  username: string;
  displayName: string;
}

async function loadQueueUser(
  ctx: QueryCtx,
  userId: Id<'profiles'> | undefined,
): Promise<QueueUser | null> {
  if (!userId) return null;
  const p = await ctx.db.get(userId);
  return p ? { userId: p._id, username: p.username, displayName: p.displayName } : null;
}

/** The resolved subject of a flag — enough to triage without opening the item. */
interface FlagTarget {
  exists: boolean;
  /** The author/owner of the flagged content (or the accused, for a `user` flag). */
  author: QueueUser | null;
  /** A short human label for the queue row. */
  summary: string;
  /** Present for content that carries a moderation axis (report/comment/hazard) — lets the queue show
   *  whether it's already hidden. */
  moderationStatus?: string;
}

/** Truncate free text to a queue-friendly snippet without splitting mid-surrogate awkwardly. */
function snippet(text: string | undefined, max = 100): string {
  if (!text) return '';
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Resolve a flag's target to just enough context to triage it in the queue (D37). `targetId` is a
 * string on the flag; we normalize it against the right table and read the one doc. Never fans out.
 */
async function resolveFlagTarget(
  ctx: QueryCtx,
  targetType: Doc<'contentFlags'>['targetType'],
  rawTargetId: string,
): Promise<FlagTarget> {
  const notFound: FlagTarget = { exists: false, author: null, summary: '(deleted)' };
  switch (targetType) {
    case 'report': {
      const id = ctx.db.normalizeId('reports', rawTargetId);
      const doc = id ? await ctx.db.get(id) : null;
      if (!doc) return notFound;
      return {
        exists: true,
        author: await loadQueueUser(ctx, doc.authorId),
        summary: snippet(doc.notes) || 'Ice report',
        moderationStatus: doc.moderationStatus,
      };
    }
    case 'comment': {
      const id = ctx.db.normalizeId('comments', rawTargetId);
      const doc = id ? await ctx.db.get(id) : null;
      if (!doc) return notFound;
      return {
        exists: true,
        author: await loadQueueUser(ctx, doc.authorId),
        summary: snippet(doc.body) || 'Comment',
        moderationStatus: doc.moderationStatus,
      };
    }
    case 'hazard': {
      const id = ctx.db.normalizeId('hazards', rawTargetId);
      const doc = id ? await ctx.db.get(id) : null;
      if (!doc) return notFound;
      return {
        exists: true,
        author: await loadQueueUser(ctx, doc.createdByUserId),
        summary: `Hazard: ${doc.type}`,
        moderationStatus: doc.moderationStatus,
      };
    }
    case 'photo': {
      const id = ctx.db.normalizeId('photos', rawTargetId);
      const doc = id ? await ctx.db.get(id) : null;
      if (!doc) return notFound;
      return {
        exists: true,
        author: await loadQueueUser(ctx, doc.uploaderId),
        summary: snippet(doc.caption) || 'Photo',
      };
    }
    case 'user': {
      const id = ctx.db.normalizeId('profiles', rawTargetId);
      const doc = id ? await ctx.db.get(id) : null;
      if (!doc) return notFound;
      // The accused *is* the target — the "author" slot doubles as the subject for a user flag.
      const subject = { userId: doc._id, username: doc.username, displayName: doc.displayName };
      return { exists: true, author: subject, summary: `User: @${doc.username}` };
    }
    default:
      return notFound;
  }
}

/** A flag as the queue presents it — the row, who filed it, and the resolved subject. */
interface FlagView {
  id: string;
  targetType: Doc<'contentFlags'>['targetType'];
  targetId: string;
  reason: Doc<'contentFlags'>['reason'];
  note?: string;
  status: Doc<'contentFlags'>['status'];
  createdAt: number;
  flagger: QueueUser | null;
  target: FlagTarget;
}

async function toFlagView(ctx: QueryCtx, flag: Doc<'contentFlags'>): Promise<FlagView> {
  return {
    id: flag._id,
    targetType: flag.targetType,
    targetId: flag.targetId,
    reason: flag.reason,
    ...(flag.note !== undefined ? { note: flag.note } : {}),
    status: flag.status,
    createdAt: flag.createdAt,
    flagger: await loadQueueUser(ctx, flag.flaggerId),
    target: await resolveFlagTarget(ctx, flag.targetType, flag.targetId),
  };
}

/**
 * The moderator flag queue (D37/D3). Open + reviewing flags off `by_status`, oldest-first (a queue
 * drains front-to-back so nothing rots), split into a **priority lane** — `unsafe_false_report` is a
 * *safety* incident, not FIFO spam (D3) — and a standard lane. Each row carries its resolved subject
 * so a moderator can triage without opening every item. Bounded to `QUEUE_LIMIT` per status.
 */
export const listFlags = query({
  args: {},
  handler: async (ctx): Promise<{ priority: FlagView[]; standard: FlagView[] }> => {
    await requireRole(ctx, 'moderator');
    const open = await ctx.db
      .query('contentFlags')
      .withIndex('by_status', (q) => q.eq('status', 'open'))
      .take(QUEUE_LIMIT);
    const reviewing = await ctx.db
      .query('contentFlags')
      .withIndex('by_status', (q) => q.eq('status', 'reviewing'))
      .take(QUEUE_LIMIT);
    // Oldest first across both statuses so the queue is a true work order.
    const rows = [...open, ...reviewing].sort((a, b) => a.createdAt - b.createdAt);
    const views = await Promise.all(rows.map((f) => toFlagView(ctx, f)));
    return {
      priority: views.filter((v) => v.reason === 'unsafe_false_report'),
      standard: views.filter((v) => v.reason !== 'unsafe_false_report'),
    };
  },
});

/** An audit row as the dashboard/history panel presents it — the action plus who took it. */
interface ActionView {
  id: string;
  action: Doc<'moderationActions'>['action'];
  targetType: Doc<'moderationActions'>['targetType'];
  targetId: string;
  reason: string;
  metadata?: unknown;
  createdAt: number;
  actor: QueueUser | null;
}

async function toActionView(ctx: QueryCtx, a: Doc<'moderationActions'>): Promise<ActionView> {
  return {
    id: a._id,
    action: a.action,
    targetType: a.targetType,
    targetId: a.targetId,
    reason: a.reason,
    ...(a.metadata !== undefined ? { metadata: a.metadata } : {}),
    createdAt: a.createdAt,
    actor: await loadQueueUser(ctx, a.actorId),
  };
}

/**
 * The moderation audit trail (D37) — newest first. Filter by `targetType`+`targetId` (a user/report's
 * full history, off `by_target`), by `actorId` (one moderator's actions, off `by_actor`), or neither
 * (the dashboard's recent-actions panel, off the implicit creation-time order). Always bounded.
 */
export const listActions = query({
  args: {
    targetType: v.optional(literals(MODERATION_TARGET_TYPES)),
    targetId: v.optional(v.string()),
    actorId: v.optional(v.id('profiles')),
    action: v.optional(literals(MODERATION_ACTIONS)),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ActionView[]> => {
    await requireRole(ctx, 'moderator');
    const limit = Math.min(args.limit ?? QUEUE_LIMIT, QUEUE_LIMIT);

    const { targetType, targetId, actorId } = args;
    let rows: Doc<'moderationActions'>[];
    if (targetType !== undefined && targetId !== undefined) {
      rows = await ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
        .order('desc')
        .take(limit);
    } else if (actorId !== undefined) {
      rows = await ctx.db
        .query('moderationActions')
        .withIndex('by_actor', (q) => q.eq('actorId', actorId))
        .order('desc')
        .take(limit);
    } else {
      rows = await ctx.db.query('moderationActions').order('desc').take(limit);
    }

    const filtered =
      args.action !== undefined ? rows.filter((r) => r.action === args.action) : rows;
    return Promise.all(filtered.map((a) => toActionView(ctx, a)));
  },
});
