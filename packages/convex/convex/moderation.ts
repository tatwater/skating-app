/**
 * Moderation functions (D32/D37) — the minimal founder takedown path. Role-gated
 * (each gated by a capability, D217); every action writes **exactly one** `moderationActions` audit row
 * (accountability for appeals/reversals). This is the inline hide/remove/restore + flag-resolution
 * surface; the full `/admin` work queues + email alerts are Phase 07 (D37/D38).
 *
 * Moderation applies to the UGC that carries a `moderationStatus` — **reports, comments and hazards**.
 * Hiding a report also hides its comments at read time (a comment on a hidden report is unreachable —
 * see `comments.listByReport`), so no cascade write is needed. Hazards are moderated through the same
 * mutation so the Phase 07 queue has a single takedown entry point, but they carry no contribution
 * counter and their hide is a *moderation* axis kept strictly separate from the community-archival
 * lifecycle `status` (D3) — see the hazards schema note.
 */

import { disputesReview } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { type MutationCtx, mutation, type QueryCtx, query } from './_generated/server';
import { writeAudit } from './lib/audit';
import { requireCapability } from './lib/auth';
import {
  AUTHOR_DELETE_REASON,
  AUTHOR_DELETED_RESTORE,
  authorDeletedAtOf,
  authorDeletedRefusal,
} from './lib/authorDeletion';
import { recomputeBodySummary } from './lib/bodySummary';
import {
  endVerdicts,
  recordUndoneVerdict,
  recordVerdict,
  standingVerdictsOn,
  subjectOf,
} from './lib/contentVerdicts';
import { bumpContributionCount, visibleDelta } from './lib/contributionCounts';
import { MODERATION_ACTIONS, MODERATION_STATUSES, MODERATION_TARGET_TYPES } from './lib/enums';
import { ERASABLE, refreshEraseClock, withdrawnAtOf } from './lib/eraseClock';
import { closeFlag } from './lib/flagResolution';
import { withoutLedgerGrantsFor } from './lib/ledgerEditors';
import { refreshPostLatestSkateEnd, refreshPostSearchText } from './lib/postSync';
import { mirrorReportSubAreas } from './lib/reportSubAreas';
import { type UndoState, undoState } from './lib/undo';
import { literals } from './lib/validators';

/** The audit action implied by a target moderation status (D37). */
const ACTION_FOR_STATUS = {
  visible: 'restore',
  hidden: 'hide',
  removed: 'remove',
} as const;

/**
 * Set a report's or comment's moderation status (D32/D37). `requireCapability('content.moderate')`; patches the
 * target and writes one `hide` / `remove` / `restore` audit row with the required reason. A no-op
 * status change (already at `status`) still records the action — the moderator asserted a decision.
 */
const MODERATION_TABLE = {
  report: 'reports',
  post: 'posts',
  comment: 'comments',
  hazard: 'hazards',
} as const;

type ModerationStatus = (typeof MODERATION_STATUSES)[number];

/**
 * One Report's verdict, and everything that has to move with it: the row, the author's visible
 * count, the body's map card (A06c §5 — a hidden report must leave the card, the one surface where
 * a stale number reads as a live condition), the bay join (A09 — the bay feed and the bay bounty
 * gate read the status off the join row, in-index) and the Post's sort key (A10 — over its visible
 * members). Shared by the `report` target and the Post cascade so the two can never disagree.
 */
async function applyReportStatus(
  ctx: MutationCtx,
  report: Doc<'reports'>,
  status: ModerationStatus,
  audit: { actorId: Id<'profiles'>; reason: string; now: number },
): Promise<void> {
  await ctx.db.patch(report._id, { moderationStatus: status });
  await bumpContributionCount(
    ctx,
    report.authorId,
    'reportCount',
    visibleDelta(report.moderationStatus, status),
  );
  await recomputeBodySummary(ctx, report.waterBodyId);
  await mirrorReportSubAreas(ctx, { ...report, moderationStatus: status });
  if (report.postId !== undefined) {
    await refreshPostLatestSkateEnd(ctx, report.postId);
    await refreshPostSearchText(ctx, report.postId);
    await derivePostVisibility(ctx, report.postId, report._id, status, audit);
  }
}

/**
 * "Zero visible Reports ⇒ the Post is not shown" (A10 §2.4), kept as a **stored** fact rather than
 * derived at read time, so the feed's moderation gate stays in the index (the `isDone: false`
 * lesson: a filter after `paginate` can hand back short pages for ever). Hiding the last visible
 * member hides the Post, with an audit row naming the member (`derivedFromReportId`); restoring a
 * member of a Post that was hidden *that* way restores the Post. A Post a moderator hid on its own
 * — no derivation on its latest action — stays hidden until they restore it.
 */
async function derivePostVisibility(
  ctx: MutationCtx,
  postId: Id<'posts'>,
  reportId: Id<'reports'>,
  status: ModerationStatus,
  audit: { actorId: Id<'profiles'>; reason: string; now: number },
): Promise<void> {
  const post = await ctx.db.get(postId);
  if (!post) return;
  if (status !== 'visible') {
    if (post.moderationStatus !== 'visible') return;
    for (const id of post.reportIds) {
      const member = await ctx.db.get(id);
      if (member && member.moderationStatus === 'visible') return;
    }
    await ctx.db.patch(postId, { moderationStatus: 'hidden' });
    await writeAudit(ctx, {
      actorId: audit.actorId,
      action: 'hide',
      targetType: 'post',
      targetId: postId,
      reason: audit.reason,
      metadata: { priorStatus: 'visible', newStatus: 'hidden', derivedFromReportId: reportId },
      createdAt: audit.now,
    });
  } else if (post.moderationStatus === 'hidden') {
    const last = await ctx.db
      .query('moderationActions')
      .withIndex('by_target', (q) => q.eq('targetType', 'post').eq('targetId', postId))
      .order('desc')
      .first();
    if (last?.metadata?.derivedFromReportId === undefined) return;
    await ctx.db.patch(postId, { moderationStatus: 'visible' });
    await writeAudit(ctx, {
      actorId: audit.actorId,
      action: 'restore',
      targetType: 'post',
      targetId: postId,
      reason: audit.reason,
      metadata: { priorStatus: 'hidden', newStatus: 'visible', derivedFromReportId: reportId },
      createdAt: audit.now,
    });
  }
}

/**
 * An author taking down their own Report (A10-3, founder call 2026-09-21: people control what
 * they shared). The same `removed` status and the same moves as a moderator's remove — counter,
 * body card, bay join, Post sort key — audited as `author_delete` with the author as actor, so a
 * moderator can see what left and when. Nothing is deleted from the table (D62 keeps and redacts).
 *
 * The last member gone takes the Post with it: a Post requires a Report (D186), so a Post whose
 * every member is removed is removed too, with its own audit row naming the member that emptied it.
 */
export async function authorRemoveReport(
  ctx: MutationCtx,
  report: Doc<'reports'>,
  author: Doc<'profiles'>,
  now: number,
): Promise<void> {
  if (report.authorDeletedAt !== undefined) return;
  const audit = { actorId: author._id, reason: AUTHOR_DELETE_REASON, now };
  const priorStatus = report.moderationStatus;
  // The withdrawal is the author's whatever a moderator did first (founder ruling, 2026-11-13): a
  // Report a moderator already removed is stamped too, so overturning that verdict later can never
  // republish it. Its status, the counters and the Post are already where a removal leaves them.
  await ctx.db.patch(report._id, { authorDeletedAt: now });
  // The 30 days start now, unless a verdict or an open flag holds it (D248).
  await refreshEraseClock(ctx, 'report', report._id, now);
  if (priorStatus === 'removed') {
    await writeAudit(ctx, {
      actorId: author._id,
      action: 'author_delete',
      targetType: 'report',
      targetId: report._id,
      reason: AUTHOR_DELETE_REASON,
      metadata: { priorStatus, newStatus: 'removed' },
      createdAt: now,
    });
    return;
  }

  // Whether this member empties its Post is decided — and the Post patched — **before** the
  // member's own status moves: `applyReportStatus` runs the derived-visibility rule, which would
  // otherwise find a Post with no visible member left, hide it, and write a `hide` row in the
  // author's name, and the takedown below would then be the Post's second row with the wrong
  // prior status. Removed first, the rule sees a Post that is not `visible` and leaves it alone.
  const post = report.postId !== undefined ? await ctx.db.get(report.postId) : null;
  let emptiesPost = post !== null && post.moderationStatus !== 'removed';
  if (post && emptiesPost) {
    for (const id of post.reportIds) {
      if (id === report._id) continue;
      const member = await ctx.db.get(id);
      if (member && member.moderationStatus !== 'removed') {
        emptiesPost = false;
        break;
      }
    }
    if (emptiesPost) await ctx.db.patch(post._id, { moderationStatus: 'removed' });
  }

  await applyReportStatus(ctx, report, 'removed', audit);
  await writeAudit(ctx, {
    actorId: author._id,
    action: 'author_delete',
    targetType: 'report',
    targetId: report._id,
    reason: AUTHOR_DELETE_REASON,
    metadata: { priorStatus, newStatus: 'removed' },
    createdAt: now,
  });
  if (post && emptiesPost) {
    await writeAudit(ctx, {
      actorId: author._id,
      action: 'author_delete',
      targetType: 'post',
      targetId: post._id,
      reason: AUTHOR_DELETE_REASON,
      metadata: {
        priorStatus: post.moderationStatus,
        newStatus: 'removed',
        derivedFromReportId: report._id,
      },
      createdAt: now,
    });
  }
}

/**
 * An author taking down their own Post: the Post and every member, each with its audit row naming
 * the cascade — the moderator's Post remove, with the author as actor. A member a moderator already
 * removed keeps its status and counters, but is withdrawn with the Post all the same (D248).
 */
export async function authorRemovePost(
  ctx: MutationCtx,
  post: Doc<'posts'>,
  author: Doc<'profiles'>,
  now: number,
): Promise<void> {
  if (post.authorDeletedAt !== undefined) return;
  const audit = { actorId: author._id, reason: AUTHOR_DELETE_REASON, now };
  const priorStatus = post.moderationStatus;
  // Everything in it is withdrawn, a member a moderator removed earlier included (founder ruling,
  // 2026-11-13): nothing inside a Post its author deleted can come back.
  await ctx.db.patch(post._id, { moderationStatus: 'removed', authorDeletedAt: now });
  // The 30 days start now for the Post and each member, unless something holds it (D248).
  await refreshEraseClock(ctx, 'post', post._id, now);
  for (const reportId of post.reportIds) {
    const report = await ctx.db.get(reportId);
    if (!report || report.authorDeletedAt !== undefined) continue;
    const memberPrior = report.moderationStatus;
    await ctx.db.patch(report._id, { authorDeletedAt: now });
    await refreshEraseClock(ctx, 'report', report._id, now);
    if (memberPrior !== 'removed') await applyReportStatus(ctx, report, 'removed', audit);
    await writeAudit(ctx, {
      actorId: author._id,
      action: 'author_delete',
      targetType: 'report',
      targetId: report._id,
      reason: AUTHOR_DELETE_REASON,
      metadata: { priorStatus: memberPrior, newStatus: 'removed', cascadedFromPostId: post._id },
      createdAt: now,
    });
  }
  await writeAudit(ctx, {
    actorId: author._id,
    action: 'author_delete',
    targetType: 'post',
    targetId: post._id,
    reason: AUTHOR_DELETE_REASON,
    metadata: { priorStatus, newStatus: 'removed' },
    createdAt: now,
  });
}

/** A forward restore that would bring the Post back with none of its Reports (founder, 2026-11-13). */
export const POST_RESTORE_NEEDS_A_CHOICE =
  'Every report in this post was hidden or removed on its own. Choose at least one report to restore with it.';
/** Every member is withdrawn by its author, or gone: nothing can come back, so the Post can't. */
export const POST_UNRESTORABLE =
  "Every report in this post was deleted by its author, so the post can't be restored.";
/** An undo that would do the same: undo never chooses, so it points at Restore. */
export const UNDO_LEAVES_POST_EMPTY =
  'Undoing this would show the post with none of its reports. Restore the post instead and choose which reports come back with it.';

/** The newest audit row on a Report — the last word on it. */
function newestRowOn(ctx: QueryCtx, reportId: Id<'reports'>) {
  return ctx.db
    .query('moderationActions')
    .withIndex('by_target', (q) => q.eq('targetType', 'report').eq('targetId', reportId))
    .order('desc')
    .first();
}

/**
 * Withdrawn by its author: stamped `authorDeletedAt` (D248), or — a deletion from before the stamp
 * that the backfill hasn't reached — removed with the author's own `author_delete` as the last word.
 * Never restorable through a Post's restore, nor at all since D248.
 */
function isAuthorWithdrawn(report: Doc<'reports'>, last: Doc<'moderationActions'> | null): boolean {
  return (
    report.authorDeletedAt !== undefined ||
    (report.moderationStatus === 'removed' && last?.action === 'author_delete')
  );
}

/**
 * What a restore of the Post does with one member: it is `visible` already; the plain restore
 * brings it back (`returns`, the Post's own takedown took it down); a moderator may `choose` it; or
 * it was `author_deleted` and never comes back through the Post.
 */
export type PostRestoreStanding = 'visible' | 'returns' | 'choose' | 'author_deleted';

/** One member as the plan read it: the Report, the last word on it (none read when visible). */
export interface PlannedMember {
  report: Doc<'reports'>;
  last: Doc<'moderationActions'> | null;
  standing: PostRestoreStanding;
}

/** What a Post restore would do, before it does any of it. */
export interface PostRestorePlan {
  /** Every member that exists, in the Post's order, with what the restore does with it. */
  members: PlannedMember[];
  /** Members the plain restore brings back: the ones the Post's own takedown took down. */
  revive: Doc<'reports'>[];
  /** Members chosen to come back with it, validated. */
  chosen: Doc<'reports'>[];
  /** How many down members a moderator could choose: not revived, not withdrawn by their author. */
  choosable: number;
  /** How many members would be visible after the restore. */
  visibleAfter: number;
}

/**
 * The one decision both Post writers share (founder call, 2026-11-13): which members a restore
 * brings back, and whether the Post would show any. Reads only — a refusal writes nothing. A
 * chosen id that isn't a member, isn't down, or was withdrawn by its author is refused.
 */
export async function planPostRestore(
  ctx: QueryCtx,
  post: Doc<'posts'>,
  { reviveRemoved = false, chosen = [] }: { reviveRemoved?: boolean; chosen?: Id<'reports'>[] },
): Promise<PostRestorePlan> {
  const memberIds = new Set<string>(post.reportIds);
  const chosenSet = new Set<string>(chosen);
  if (chosenSet.size !== chosen.length) throw new ConvexError('A report was chosen twice');
  for (const id of chosenSet) {
    if (!memberIds.has(id)) throw new ConvexError('A chosen report is not part of this post');
  }
  const plan: PostRestorePlan = {
    members: [],
    revive: [],
    chosen: [],
    choosable: 0,
    visibleAfter: 0,
  };
  for (const id of post.reportIds) {
    const report = await ctx.db.get(id);
    if (!report) {
      if (chosenSet.has(id)) throw new ConvexError('A chosen report no longer exists');
      continue;
    }
    if (report.moderationStatus === 'visible') {
      if (chosenSet.has(id)) throw new ConvexError('A chosen report is already visible');
      plan.members.push({ report, last: null, standing: 'visible' });
      plan.visibleAfter++;
      continue;
    }
    const last = await newestRowOn(ctx, report._id);
    // A member a moderator chose to bring back, then put back down by that restore's undo, is down
    // on its own decision again, though the row naming the Post is the last word on it.
    const revivable =
      report.authorDeletedAt === undefined &&
      (report.moderationStatus === 'hidden' || reviveRemoved) &&
      last?.metadata?.cascadedFromPostId === post._id &&
      last.metadata.chosen !== true &&
      last.action !== 'author_delete';
    if (revivable) {
      plan.members.push({ report, last, standing: 'returns' });
      plan.revive.push(report);
      plan.visibleAfter++;
      continue;
    }
    if (isAuthorWithdrawn(report, last)) {
      if (chosenSet.has(id)) {
        throw new ConvexError("A chosen report was deleted by its author and can't be restored");
      }
      plan.members.push({ report, last, standing: 'author_deleted' });
      continue;
    }
    plan.members.push({ report, last, standing: 'choose' });
    plan.choosable++;
    if (chosenSet.has(id)) {
      plan.chosen.push(report);
      plan.visibleAfter++;
    }
  }
  return plan;
}

export const setModerationStatus = mutation({
  args: {
    targetType: literals(['report', 'post', 'comment', 'hazard']),
    targetId: v.string(),
    status: literals(MODERATION_STATUSES),
    reason: v.string(),
    /** A Post restore only: members to restore with it (founder call, 2026-11-13). */
    withReportIds: v.optional(v.array(v.id('reports'))),
  },
  handler: async (ctx, args) => {
    const actor = await requireCapability(ctx, 'content.moderate');
    return setContentStatus(ctx, actor, args);
  },
});

export type ContentTargetType = keyof typeof MODERATION_TABLE;

/**
 * The body of {@link setModerationStatus}, callable by an undo (D226) so the restore runs the same
 * cascade the hide did — a Post brings back the reports *it* hid, and every count and card follows.
 * A Post row that lists the members it moved (`cascaded`) undoes through {@link revertPostVerdict}
 * instead; only a Post row from before that record comes back through here.
 */
export async function setContentStatus(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  args: {
    targetType: ContentTargetType;
    targetId: string;
    status: ModerationStatus;
    reason: string;
    /**
     * Bring back members this Post's own *removal* took down, too — set only by that removal's undo
     * (D226), and only for a removal row from before `cascaded` was recorded (a newer one undoes
     * through `revertPostVerdict`). A moderator's restore of a removed Post leaves them removed (the
     * stronger verdict); an undo puts back what the removal replaced, and without this it would
     * leave a visible Post with every Report in it gone.
     */
    reviveRemoved?: boolean;
    /**
     * Members of the Post to restore with it (founder call, 2026-11-13): a moderator's conscious
     * override of each member's own takedown, for a Post that would otherwise come back with none
     * of its Reports. Only on a Post restore; each must be a member that is down and not withdrawn
     * by its author.
     */
    withReportIds?: Id<'reports'>[];
    /** Set by an undo, to the row it undoes: an undo never chooses, so its refusals say so. */
    undoes?: Id<'moderationActions'>;
  },
): Promise<Id<'reports'> | Id<'posts'> | Id<'comments'> | Id<'hazards'>> {
  {
    if (args.reason.trim().length === 0) throw new ConvexError('A reason is required');
    const now = Date.now();

    const targetId = ctx.db.normalizeId(MODERATION_TABLE[args.targetType], args.targetId);
    if (!targetId) throw new ConvexError('Target not found');
    const target = await ctx.db.get(targetId);
    if (!target) throw new ConvexError('Target not found');

    const typedTarget = target as Doc<'reports'> | Doc<'posts'> | Doc<'comments'> | Doc<'hazards'>;
    const priorStatus = typedTarget.moderationStatus;
    const asUndo = args.undoes !== undefined;
    if (
      args.withReportIds !== undefined &&
      (args.targetType !== 'post' || args.status !== 'visible')
    ) {
      throw new ConvexError('Reports can only be chosen when restoring a post');
    }
    // Author-deleted content never comes back (D248, founder ruling 2026-11-13) — not by restore, not
    // by a Post's choice, not by undo — and nothing else moves it either: it stays as the deletion
    // left it.
    // Erased is gone (D248): nothing is left to judge, and a verdict on it would be a record of nothing.
    if (args.targetType === 'comment' && (typedTarget as Doc<'comments'>).erasedAt !== undefined) {
      throw new ConvexError(ERASED_ALREADY);
    }
    if (authorDeletedAtOf(typedTarget) !== undefined) {
      if (args.status === 'visible' || asUndo) {
        throw new ConvexError(authorDeletedRefusal(args.status, asUndo));
      }
      // A moderator's hide or remove on content its author already deleted (a flag that arrives
      // after the delete) is still their decision, and goes on the person's record as evidence
      // (D248) — the content stays exactly as the deletion left it, and the verdict holds it back
      // from erasure until a moderator overturns it.
      const actionId = await writeAudit(ctx, {
        actorId: actor._id,
        action: ACTION_FOR_STATUS[args.status],
        targetType: args.targetType,
        targetId: args.targetId,
        reason: args.reason,
        metadata: { priorStatus, newStatus: priorStatus, onAuthorDeleted: true },
        createdAt: now,
      });
      await recordVerdict(ctx, {
        subjectUserId: subjectOf(args.targetType, typedTarget),
        targetType: args.targetType,
        targetId: args.targetId,
        actionId,
        kind: args.status,
        at: now,
      });
      return targetId;
    }

    const audit = { actorId: actor._id, reason: args.reason, now };
    // Every member a Post's verdict moved, and from what to what — on the Post's own row, so its undo
    // can put each member back to its own prior status (founder call, 2026-11-13).
    const cascaded: PostCascade[] = [];
    if (args.targetType === 'report') {
      await applyReportStatus(ctx, target as Doc<'reports'>, args.status, audit);
    } else if (args.targetType === 'post') {
      // A Post's verdict reaches its members (A10 §2.4): hidden ⇒ every visible Report hidden, each
      // with its own audit row naming the cascade; restored ⇒ the Reports *this* hide took down come
      // back, plus any the moderator chose, so a member hidden on its own merits stays hidden unless
      // chosen. `removed` cascades the same way and is not restored by a plain Post restore — it is
      // the stronger verdict.
      const post = target as Doc<'posts'>;
      if (args.status !== 'visible') {
        await ctx.db.patch(post._id, { moderationStatus: args.status });
        for (const reportId of post.reportIds) {
          const report = await ctx.db.get(reportId);
          if (report === null || report.moderationStatus !== 'visible') continue;
          cascaded.push(await moveMember(ctx, post._id, report, args.status, audit));
        }
      } else {
        // A choice is for a Post coming back. On one that is up already, the chosen Reports would be
        // restored as the Post's, by a row whose undo has nothing to put the Post back to.
        if (args.withReportIds?.length && post.moderationStatus === 'visible') {
          throw new ConvexError('This post is already up. Restore its reports one at a time.');
        }
        // Decided before anything is written: a Post is never stored visible with none of its
        // Reports visible (D186; founder call, 2026-11-13).
        const plan = await planPostRestore(ctx, post, {
          reviveRemoved: args.reviveRemoved === true,
          ...(args.withReportIds !== undefined ? { chosen: args.withReportIds } : {}),
        });
        if (plan.visibleAfter === 0) {
          throw new ConvexError(
            asUndo
              ? UNDO_LEAVES_POST_EMPTY
              : plan.choosable === 0
                ? POST_UNRESTORABLE
                : POST_RESTORE_NEEDS_A_CHOICE,
          );
        }
        await ctx.db.patch(post._id, { moderationStatus: 'visible' });
        for (const report of plan.revive) {
          cascaded.push(await moveMember(ctx, post._id, report, 'visible', audit));
        }
        for (const report of plan.chosen) {
          cascaded.push(await moveMember(ctx, post._id, report, 'visible', audit, true));
        }
      }
    } else {
      await ctx.db.patch(targetId, { moderationStatus: args.status });
      // Comments carry a denormalized contribution counter to keep exact; hazards do not. Note we
      // touch ONLY `moderationStatus` — the hazard's lifecycle `status` is deliberately left alone,
      // so a moderator hide is never mistakable for the community archiving a healed hazard (D3).
      if (args.targetType === 'comment') {
        const comment = target as Doc<'comments'>;
        await bumpContributionCount(
          ctx,
          comment.authorId,
          'commentCount',
          visibleDelta(priorStatus, args.status),
        );
      }
      // A hidden hazard must leave the map card too (A06c §5).
      if (args.targetType === 'hazard') {
        await recomputeBodySummary(ctx, (target as Doc<'hazards'>).waterBodyId);
      }
    }

    const actionId = await writeAudit(ctx, {
      actorId: actor._id,
      action: ACTION_FOR_STATUS[args.status],
      targetType: args.targetType,
      targetId: args.targetId,
      reason: args.reason,
      metadata: {
        priorStatus,
        newStatus: args.status,
        ...(args.targetType === 'post' ? { cascaded } : {}),
      },
      createdAt: now,
    });
    // The person's record (D248): a restore reverses the standing verdict, a hide or remove puts one
    // on the record, and an undo back down puts back only what the undone row ended.
    if (args.status === 'visible') {
      await endVerdicts(ctx, args.targetType, args.targetId, { actionId, at: now });
    } else {
      const entry = {
        subjectUserId: subjectOf(args.targetType, typedTarget),
        targetType: args.targetType,
        targetId: args.targetId,
        actionId,
        kind: args.status,
        at: now,
      };
      if (args.undoes !== undefined) await recordUndoneVerdict(ctx, entry, args.undoes);
      else await recordVerdict(ctx, entry);
    }
    return targetId;
  }
}

/** One member a Post's verdict moved: the Report, the status it had, the status it was given. */
export interface PostCascade {
  id: Id<'reports'>;
  from: ModerationStatus;
  to: ModerationStatus;
  /**
   * Brought back by a moderator's choice, not by the Post's own takedown: carried through every
   * undo and redo, so when that undo puts it back down it is down on its own decision, which a
   * plain restore of the Post never revives.
   */
  chosen?: true;
}

/**
 * Move one member of a Post for the Post's verdict, or for that verdict's undo: the Report's status
 * and everything that follows it, and its own audit row naming the Post (which makes its undo the
 * Post's). Returns the entry the Post's own row records.
 *
 * A member the moderator **chose** is their own decision on it, so it moves the person's record
 * (D248): brought back, its verdict ends; put back down by the restore's undo (`undoing` is the
 * member's row that undo reverses), the verdict that choice ended is on the record again. A plain
 * cascade is the Post's verdict, not one of its own.
 */
async function moveMember(
  ctx: MutationCtx,
  postId: Id<'posts'>,
  report: Doc<'reports'>,
  to: ModerationStatus,
  audit: { actorId: Id<'profiles'>; reason: string; now: number },
  chosen = false,
  undoing?: Id<'moderationActions'>,
): Promise<PostCascade> {
  const from = report.moderationStatus;
  const mark = chosen ? ({ chosen: true } as const) : {};
  await applyReportStatus(ctx, report, to, audit);
  const actionId = await writeAudit(ctx, {
    actorId: audit.actorId,
    action: ACTION_FOR_STATUS[to],
    targetType: 'report',
    targetId: report._id,
    reason: audit.reason,
    metadata: { priorStatus: from, newStatus: to, cascadedFromPostId: postId, ...mark },
    createdAt: audit.now,
  });
  if (chosen && to === 'visible') {
    await endVerdicts(ctx, 'report', report._id, { actionId, at: audit.now });
  } else if (chosen && undoing !== undefined && to !== 'visible') {
    await recordUndoneVerdict(
      ctx,
      {
        subjectUserId: report.authorId,
        targetType: 'report',
        targetId: report._id,
        actionId,
        kind: to,
        at: audit.now,
      },
      undoing,
    );
  }
  return { id: report._id, from, to, ...mark };
}

/**
 * The undo of a Post's verdict (D226; founder call, 2026-11-13): the Post back to the status it had,
 * and **every member the verdict moved back to its own prior status** — whatever the Post returns
 * to. Not `setContentStatus` in reverse: its cascade only ever revives members on the way to
 * visible, so removing a hidden Post and undoing it left a Report the removal took down removed,
 * with its own undo refused as "followed from the Post".
 *
 * A member is put back only while the verdict is still the last word on it — the newest row on it
 * is this verdict's cascade row (same Post, same instant) and it still has the status the verdict
 * gave it. A member a moderator has acted on since keeps that later decision. The Post's own row is
 * written last, so it is the newest on the Post, and lists the members it moved, so its undo is
 * the exact inverse again.
 */
export async function revertPostVerdict(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  { row, reason }: { row: Doc<'moderationActions'>; reason: string },
): Promise<void> {
  const { priorStatus, cascaded } = row.metadata as {
    priorStatus: ModerationStatus;
    cascaded: PostCascade[];
  };
  const postId = ctx.db.normalizeId('posts', row.targetId);
  const post = postId ? await ctx.db.get(postId) : null;
  if (!post) throw new ConvexError('Target not found');
  // A Post its author deleted stays as the deletion left it, whatever the undo would put back to.
  if (post.authorDeletedAt !== undefined) {
    throw new ConvexError(authorDeletedRefusal(priorStatus, true));
  }
  const now = Date.now();
  const audit = { actorId: actor._id, reason, now };

  // Which members go back, decided before anything is written.
  const moves: {
    report: Doc<'reports'>;
    to: ModerationStatus;
    chosen: boolean;
    undoing: Id<'moderationActions'>;
  }[] = [];
  for (const member of cascaded) {
    const report = await ctx.db.get(member.id);
    if (!report || report.moderationStatus !== member.to) continue;
    // A member its author deleted stays where the deletion left it, whatever the Post's undo does.
    if (report.authorDeletedAt !== undefined) continue;
    const last = await newestRowOn(ctx, report._id);
    if (last?.metadata?.cascadedFromPostId !== post._id || last.createdAt !== row.createdAt) {
      continue;
    }
    moves.push({ report, to: member.from, chosen: member.chosen === true, undoing: last._id });
  }
  // An undo back to visible must leave a Report showing (D186; founder call, 2026-11-13). It never
  // chooses which — that is Restore's — so it refuses and says where the choice lives.
  if (priorStatus === 'visible') {
    const moving = new Map(moves.map((m) => [m.report._id as string, m.to]));
    let visibleAfter = 0;
    for (const id of post.reportIds) {
      const status = moving.get(id) ?? (await ctx.db.get(id))?.moderationStatus;
      if (status === 'visible') visibleAfter++;
    }
    if (visibleAfter === 0) throw new ConvexError(UNDO_LEAVES_POST_EMPTY);
  }

  // The Post first, so a member's change doesn't re-derive the Post's status from the old one.
  await ctx.db.patch(post._id, { moderationStatus: priorStatus });
  const reverted: PostCascade[] = [];
  for (const { report, to, chosen, undoing } of moves) {
    reverted.push(await moveMember(ctx, post._id, report, to, audit, chosen, undoing));
  }
  const actionId = await writeAudit(ctx, {
    actorId: actor._id,
    action: ACTION_FOR_STATUS[priorStatus],
    targetType: 'post',
    targetId: post._id,
    reason,
    metadata: { priorStatus: post.moderationStatus, newStatus: priorStatus, cascaded: reverted },
    createdAt: now,
  });
  // The undo reverses the Post's verdict, or (undoing a restore) puts back the verdict that restore
  // ended — none, for a Post that was down only because its Reports were.
  if (priorStatus === 'visible') {
    await endVerdicts(ctx, 'post', post._id, { actionId, at: now });
  } else {
    await recordUndoneVerdict(
      ctx,
      {
        subjectUserId: post.authorId,
        targetType: 'post',
        targetId: post._id,
        actionId,
        kind: priorStatus,
        at: now,
      },
      row._id,
    );
  }
}

/**
 * A Post its author emptied Report by Report (the clients delete Reports, never a whole Post): every
 * member deleted by its author, or already erased. Nothing in it can come back, so a verdict on it is
 * overturned like one on deleted content — a restore would be refused.
 */
async function everyMemberWithdrawn(ctx: QueryCtx, post: Doc<'posts'>): Promise<boolean> {
  for (const id of post.reportIds) {
    const member = await ctx.db.get(id);
    if (member && member.authorDeletedAt === undefined) return false;
  }
  return true;
}

/** Overturn refusals, worded once for the mutation and its tests. */
export const OVERTURN_NOT_DELETED =
  'Its author still has this up. Restore it to take the verdict off their record.';
export const OVERTURN_NOTHING_STANDING = 'There is no standing verdict on this to overturn.';
/** Anything a moderator tries on a comment the sweep erased. */
export const ERASED_ALREADY = 'This was erased, so there is nothing left to act on.';

/**
 * Overturn a verdict on content its author has since deleted (D248) — a mistake, or a successful
 * appeal. The verdict leaves the person's record; the content does not come back, and with nothing
 * else holding it, its erasure clock runs again. Content still the author's to show is reversed with
 * Restore instead.
 */
export const overturnVerdict = mutation({
  args: {
    // Only what an author can withdraw — and an alert its author retracted.
    targetType: literals(['report', 'post', 'comment', 'hazard', 'accessAlert']),
    targetId: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    // An alert's verdict is the alert lever's, as its retraction and pin are. Each gate is spelled
    // as a literal so the D217 guard (`capabilityGates.test.ts`) reads both.
    const actor =
      args.targetType === 'accessAlert'
        ? await requireCapability(ctx, 'access.alert')
        : await requireCapability(ctx, 'content.moderate');
    const reason = args.reason.trim();
    if (reason.length === 0) throw new ConvexError('A reason is required');
    const targetId = ctx.db.normalizeId(ERASABLE[args.targetType], args.targetId);
    const target = targetId ? await ctx.db.get(targetId) : null;
    if (!target) throw new ConvexError('Target not found');
    const withdrawn =
      args.targetType === 'accessAlert'
        ? withdrawnAtOf('accessAlert', target as Doc<'accessAlerts'>) !== undefined
        : authorDeletedAtOf(target as Exclude<typeof target, Doc<'accessAlerts'>>) !== undefined ||
          (args.targetType === 'post' && (await everyMemberWithdrawn(ctx, target as Doc<'posts'>)));
    if (!withdrawn) throw new ConvexError(OVERTURN_NOT_DELETED);
    if ((await standingVerdictsOn(ctx, args.targetType, args.targetId)).length === 0) {
      throw new ConvexError(OVERTURN_NOTHING_STANDING);
    }
    const now = Date.now();
    const actionId = await writeAudit(ctx, {
      actorId: actor._id,
      action: 'overturn_verdict',
      targetType: args.targetType,
      targetId: args.targetId,
      reason,
      createdAt: now,
    });
    await endVerdicts(ctx, args.targetType, args.targetId, { actionId, at: now });
    return targetId;
  },
});

/**
 * Resolve a content flag (D32/D37). `requireCapability('inbox.flag')`; sets the flag terminal status
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
    const actor = await requireCapability(ctx, 'inbox.flag');
    if (args.reason.trim().length === 0) throw new ConvexError('A reason is required');

    const flag = await ctx.db.get(args.flagId);
    if (!flag) throw new ConvexError('Flag not found');
    // Resolution is terminal and single-shot. Guard it so a stale queue view — two moderators acting
    // on the same open flag, or a re-submit of an already-closed one — can't patch it twice, write a
    // second audit row, or (worse) double-count the disposition metric below and even record the flag
    // under *both* outcomes, poisoning the tuning signal. Convex's OCC makes this race-safe: a
    // concurrent second resolver re-reads the now-terminal status on retry and lands here.
    if (flag.status === 'actioned' || flag.status === 'dismissed') {
      throw new ConvexError('This flag has already been resolved');
    }
    // The filer's withdrawal is final (D248): no moderator decides it after.
    if (flag.status === 'retracted') {
      throw new ConvexError(
        'The person who filed this withdrew it, so there is nothing to resolve.',
      );
    }

    const now = Date.now();
    // The status, the Phase 07-2 disposition metric, and the A08 verdict notification — shared with
    // `waterBodies.setPublicAccess`, which closes flags as a side effect of ruling on a lake.
    await closeFlag(ctx, flag, args.resolution, actor._id, now);

    await writeAudit(ctx, {
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
// Admin queue queries (Phase 07 read side). Every one gates on a read capability (D217),
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
    case 'post': {
      // A10 (D186). The prose is the Post's; the summary leads with the title, then the body.
      const id = ctx.db.normalizeId('posts', rawTargetId);
      const doc = id ? await ctx.db.get(id) : null;
      if (!doc) return notFound;
      return {
        exists: true,
        author: await loadQueueUser(ctx, doc.authorId),
        summary: doc.title || snippet(doc.body) || 'Post',
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
    case 'accessAlert': {
      // A06d (D73). Without this case the switch falls through to `notFound`, and every access-alert
      // flag renders in the queue as "(deleted)" with no author and no note — a moderator looking at
      // a report about nothing. Adding the target type to `FLAG_TARGET_TYPES` made filing work; this
      // is what makes *triaging* work, and the two are easy to ship apart.
      const id = ctx.db.normalizeId('accessAlerts', rawTargetId);
      const doc = id ? await ctx.db.get(id) : null;
      if (!doc) return notFound;
      return {
        exists: true,
        author: await loadQueueUser(ctx, doc.createdByUserId),
        // The reason is the claim and the note is the evidence for it; a bogus alert is usually only
        // recognizable from the second, so it leads where there is one.
        summary: snippet(doc.note) || `Access alert: ${doc.reason}`,
      };
    }
    case 'waterbody': {
      // A06f — the same trap the `accessAlert` case above documents, and the reason that note is worth
      // its length: without this the switch falls through to `notFound` and every access report shows
      // as "(deleted)".
      const id = ctx.db.normalizeId('waterBodies', rawTargetId);
      const doc = id ? await ctx.db.get(id) : null;
      if (!doc) return notFound;
      return {
        exists: true,
        // **No author, and that is not a gap.** Every other flag target was written by somebody who
        // can be warned or banned; a lake has no author, and the `createdByUserId` on a user-drawn
        // body is the wrong person entirely — they drew the outline, they did not claim it was
        // private. Leaving it null keeps the queue's per-author affordances from pointing at them.
        author: null,
        summary: doc.name ? `Lake: ${doc.name}` : 'Unnamed water body',
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
  /**
   * Auto-flag bundling (A02). `occurrences` is how many times this problem has been recorded — the
   * count a stream of identical rows was hiding, and the moderator's actual input to the D57 lever.
   * `priorResolvedAt`/`priorResolution` come from the superseded terminal row, so the queue can say
   * "4th occurrence · last dismissed 6d ago" rather than making someone go looking.
   */
  occurrences: number;
  lastOccurrenceAt?: number;
  priorResolvedAt?: number;
  priorResolution?: Doc<'contentFlags'>['status'];
}

async function toFlagView(ctx: QueryCtx, flag: Doc<'contentFlags'>): Promise<FlagView> {
  // One `get` on the superseded row, and only for a flag that actually supersedes one — which is the
  // rare case, since most flags are somebody's first.
  const prior = flag.supersedesFlagId ? await ctx.db.get(flag.supersedesFlagId) : null;
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
    // Absent reads as 1: every flag filed before bundling shipped is its own single occurrence.
    occurrences: flag.occurrences ?? 1,
    ...(flag.lastOccurrenceAt !== undefined ? { lastOccurrenceAt: flag.lastOccurrenceAt } : {}),
    ...(prior?.resolvedAt !== undefined ? { priorResolvedAt: prior.resolvedAt } : {}),
    ...(prior ? { priorResolution: prior.status } : {}),
  };
}

/**
 * One lake's worth of "no public access" reports, collapsed (A06f).
 *
 * **The only flag reason the queue groups**, because it is the only one many people can independently
 * make about the same target: five people reporting one lake is one job, not five, and the count is
 * the signal rather than noise to page past. Every other reason is a claim about one thing somebody
 * wrote, where five flags on one comment really are five opinions about one object.
 */
export interface AccessReportGroup {
  waterBodyId: string;
  name: string;
  /** Distinct reporters — `contentFlags` dedups per (flagger, target), so the rows *are* the people. */
  count: number;
  firstReportedAt: number;
  /** What the reporters said, newest first. The evidence a moderator actually rules on. */
  notes: string[];
  /**
   * Set when these reports post-date a prior `open` ruling — "disputes a review from March 2026".
   *
   * Derived from the two timestamps rather than stored on the flag: a stored copy would keep naming a
   * decision that a later re-ruling had already replaced.
   */
  disputesReviewFrom?: number;
}

/** One member of a Post, as the restore chooser shows it. */
export interface PostRestoreMember {
  reportId: Id<'reports'>;
  status: ModerationStatus;
  waterBodyName: string | null;
  skateEndTime: number;
  /** Why it is down: the last word on it. Absent for a visible member. */
  down?: { action: string; by: QueueUser | null; at: number; reason: string };
  standing: PostRestoreStanding;
}

/**
 * What the Post-restore chooser needs (founder call, 2026-11-13): each member — what it is, why it
 * is down, and whether it can be chosen — and whether a plain restore would bring a Report back on
 * its own (then no chooser is needed). Bounded by the Post's member cap, which the Post's write
 * enforces; the members are the plan's own reads, so the list and the verdict can't disagree.
 */
export const postRestoreChoices = query({
  args: { postId: v.id('posts') },
  handler: async (ctx, { postId }) => {
    // `content.read`, the read half of `content.moderate`: hidden content, read in full. A query
    // can't take a write capability (a departing moderator still reads), and the restore it feeds
    // is gated on `content.moderate` itself.
    await requireCapability(ctx, 'content.read');
    const post = await ctx.db.get(postId);
    if (!post) return null;
    const plan = await planPostRestore(ctx, post, {});
    const members: PostRestoreMember[] = [];
    for (const { report, last, standing } of plan.members) {
      const body = await ctx.db.get(report.waterBodyId);
      members.push({
        reportId: report._id,
        status: report.moderationStatus,
        waterBodyName: body?.name ?? null,
        skateEndTime: report.skateEndTime,
        ...(last
          ? {
              down: {
                action: last.action,
                by: await loadQueueUser(ctx, last.actorId),
                at: last.createdAt,
                reason: last.reason,
              },
            }
          : {}),
        standing,
      });
    }
    // A Post its author deleted never comes back, whatever is in it (founder ruling, 2026-11-13).
    const withdrawn = post.authorDeletedAt !== undefined;
    const plainRestoreBringsBack = !withdrawn && plan.visibleAfter > 0;
    return {
      postStatus: post.moderationStatus,
      /** A plain restore shows the Post with at least one Report: no choice is needed. */
      plainRestoreBringsBack,
      /** Something can bring the Post back — the plain restore, or a choice. */
      restorable: !withdrawn && (plainRestoreBringsBack || plan.choosable > 0),
      /**
       * What the chooser says when a plain restore isn't enough, in the words the restore's own
       * refusal uses: why a choice is needed, or why the Post can't come back.
       */
      prompt: withdrawn
        ? AUTHOR_DELETED_RESTORE
        : plainRestoreBringsBack
          ? null
          : plan.choosable > 0
            ? POST_RESTORE_NEEDS_A_CHOICE
            : POST_UNRESTORABLE,
      members,
    };
  },
});

/**
 * The moderator flag queue (D37/D3). Open + reviewing flags off `by_status`, oldest-first (a queue
 * drains front-to-back so nothing rots), split into a **priority lane** — `unsafe_false_report` is a
 * *safety* incident, not FIFO spam (D3) — a standard lane, and the A06f **access lane**, which is
 * grouped by lake and ranked by how many people agree rather than by age. Each row carries its
 * resolved subject so a moderator can triage without opening every item. Bounded to `QUEUE_LIMIT` per
 * status.
 */
export const listFlags = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    priority: FlagView[];
    standard: FlagView[];
    accessReports: AccessReportGroup[];
  }> => {
    await requireCapability(ctx, 'inbox.read');
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

    const accessRows = rows.filter(
      (f) => f.targetType === 'waterbody' && f.reason === 'no_public_access',
    );
    // The access rows leave the flat lanes entirely — showing a lake in both places would put the
    // same job in front of a moderator twice, once collapsed and once not.
    const flat = rows.filter((f) => !accessRows.includes(f));
    const views = await Promise.all(flat.map((f) => toFlagView(ctx, f)));

    return {
      priority: views.filter((v) => v.reason === 'unsafe_false_report'),
      standard: views.filter((v) => v.reason !== 'unsafe_false_report'),
      accessReports: await groupAccessReports(ctx, accessRows),
    };
  },
});

/** Collapse per-reporter rows into one job per lake, most-corroborated first. */
async function groupAccessReports(
  ctx: QueryCtx,
  rows: Doc<'contentFlags'>[],
): Promise<AccessReportGroup[]> {
  const byBody = new Map<string, Doc<'contentFlags'>[]>();
  for (const row of rows) {
    const held = byBody.get(row.targetId);
    if (held) held.push(row);
    else byBody.set(row.targetId, [row]);
  }

  const groups: AccessReportGroup[] = [];
  for (const [targetId, flags] of byBody) {
    const id = ctx.db.normalizeId('waterBodies', targetId);
    const body = id ? await ctx.db.get(id) : null;
    // A body deleted out from under its reports has no job left to do; the rows stay for the record.
    if (!body) continue;
    const newestFirst = [...flags].sort((a, b) => b.createdAt - a.createdAt);
    const firstReportedAt = Math.min(...flags.map((f) => f.createdAt));
    const disputed = disputesReview(body.publicAccess, Math.max(...flags.map((f) => f.createdAt)));
    groups.push({
      waterBodyId: targetId,
      name: body.name || 'Unnamed water body',
      count: flags.length,
      firstReportedAt,
      notes: newestFirst.map((f) => f.note?.trim()).filter((n): n is string => Boolean(n)),
      ...(disputed ? { disputesReviewFrom: disputed.decidedAt } : {}),
    });
  }

  // Most-corroborated first — the founder's "the more users, the higher it rises". Age breaks ties so
  // two lakes with one report each still drain front-to-back.
  return groups.sort((a, b) => b.count - a.count || a.firstReportedAt - b.firstReportedAt);
}

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
  /** Set on the row an undo wrote: the row it undid (D226). */
  undoesActionId?: string;
  /** Whether the viewer can undo this row now, and if not, why (D226). */
  undo: UndoState;
}

async function toActionView(
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  a: Doc<'moderationActions'>,
): Promise<ActionView> {
  return {
    ...(a.undoesActionId !== undefined ? { undoesActionId: a.undoesActionId } : {}),
    undo: await undoState(ctx, viewer, a),
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
    const viewer = await requireCapability(ctx, 'audit.read');
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

    // Who holds ledger editing is for holders only (D227), in History as on the People row.
    const visible = withoutLedgerGrantsFor(viewer, rows);
    const filtered =
      args.action !== undefined ? visible.filter((r) => r.action === args.action) : visible;
    return Promise.all(filtered.map((a) => toActionView(ctx, viewer, a)));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// User-lifecycle + posting-permission mutations (Phase 07 write side). All moderator-level per the
// D37 refinement (2026-07-23) — a moderator handling a hateful account can act without escalating.
// Each writes exactly one `moderationActions` row; role-grant/revoke live in `admin.ts` (admin-only).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load a user a moderator is about to act on, with two safety guards: a moderator can't act on
 * **their own** account (no self-ban lockout) and can't act on an **admin** unless they're an admin
 * themselves (a volunteer/compromised moderator can never touch the app owner — D37 draws the trust
 * line at admin).
 */
async function loadModeratableUser(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  userId: Id<'profiles'>,
): Promise<Doc<'profiles'>> {
  const target = await ctx.db.get(userId);
  if (!target) throw new ConvexError('User not found');
  if (target._id === actor._id) throw new ConvexError('You cannot moderate your own account');
  if (target.role === 'admin' && actor.role !== 'admin') {
    throw new ConvexError('Only an admin can moderate an admin');
  }
  return target;
}

async function auditUser(
  ctx: MutationCtx,
  actorId: Id<'profiles'>,
  action: 'ban' | 'suspend' | 'unban' | 'set_posting_permission',
  userId: Id<'profiles'>,
  reason: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await writeAudit(ctx, {
    actorId,
    action,
    targetType: 'user',
    targetId: userId,
    reason,
    ...(metadata !== undefined ? { metadata } : {}),
    createdAt: Date.now(),
  });
}

/**
 * Ban a user indefinitely (D37). Patches `status: banned` + reason + `moderatedByUserId`, clears any
 * suspension window, audits `ban`, and — belt + suspenders — locks the Clerk user so no new session
 * issues. The Convex `status` gate (`requireProfile`) is the real boundary; the Clerk lock just stops
 * fresh sign-ins. A ban preserves the account for appeal/reversal (distinct from D33 deletion).
 */
export const banUser = mutation({
  args: { userId: v.id('profiles'), reason: v.string() },
  handler: async (ctx, { userId, reason }) => {
    const actor = await requireCapability(ctx, 'people.discipline');
    return banImpl(ctx, actor, { userId, reason });
  },
});

/** What a lifecycle action replaced — the whole status, so its undo puts back exactly that (D226). */
function statusPrev(target: Doc<'profiles'>) {
  return {
    status: target.status,
    statusReason: target.statusReason ?? null,
    suspendedUntil: target.suspendedUntil ?? null,
  };
}

export async function banImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  { userId, reason }: { userId: Id<'profiles'>; reason: string },
): Promise<Id<'profiles'>> {
  {
    if (reason.trim().length === 0) throw new ConvexError('A reason is required');
    const target = await loadModeratableUser(ctx, actor, userId);

    await ctx.db.patch(userId, {
      status: 'banned',
      statusReason: reason,
      suspendedUntil: undefined,
      moderatedByUserId: actor._id,
    });
    await auditUser(ctx, actor._id, 'ban', userId, reason, { prev: statusPrev(target) });
    // Fire-and-forget: a mutation can't fetch. Permanent bans only touch Clerk (founder decision).
    await ctx.scheduler.runAfter(0, internal.clerkAdmin.setBanned, {
      clerkUserId: target.clerkUserId,
      banned: true,
    });
    return userId;
  }
}

/**
 * Temporarily suspend a user until `suspendedUntil` (D37). The Convex gate (`requireProfile`) rejects
 * while the window is open and **auto-lifts** with no cron — so, per the founder decision (2026-07-23),
 * a suspension deliberately never locks Clerk (that would leave the user locked out of sign-in after
 * the window naturally expired), and one that replaces a ban lifts the ban's lock. Audits `suspend`
 * with the window in metadata.
 */
export const suspendUser = mutation({
  args: { userId: v.id('profiles'), reason: v.string(), suspendedUntil: v.number() },
  handler: async (ctx, { userId, reason, suspendedUntil }) => {
    const actor = await requireCapability(ctx, 'people.discipline');
    return suspendImpl(ctx, actor, { userId, reason, suspendedUntil });
  },
});

export async function suspendImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  {
    userId,
    reason,
    suspendedUntil,
  }: { userId: Id<'profiles'>; reason: string; suspendedUntil: number },
): Promise<Id<'profiles'>> {
  {
    if (reason.trim().length === 0) throw new ConvexError('A reason is required');
    if (suspendedUntil <= Date.now()) {
      throw new ConvexError('Suspension must end in the future');
    }
    const target = await loadModeratableUser(ctx, actor, userId);

    await ctx.db.patch(userId, {
      status: 'suspended',
      statusReason: reason,
      suspendedUntil,
      moderatedByUserId: actor._id,
    });
    await auditUser(ctx, actor._id, 'suspend', userId, reason, {
      suspendedUntil,
      prev: statusPrev(target),
    });
    // A suspension that replaces a ban — softened on appeal, or a ban's undo back to the suspension
    // it replaced (D226) — has to lift the ban's Clerk lock too: a suspension never holds one, so
    // left in place it would outlive the window and lock the person out for good (the reason above).
    if (target.status === 'banned') {
      await ctx.scheduler.runAfter(0, internal.clerkAdmin.setBanned, {
        clerkUserId: target.clerkUserId,
        banned: false,
      });
    }
    return userId;
  }
}

/**
 * Lift a ban or suspension (D37) — returns the account to `active`, clears the suspension window +
 * reason, audits `unban`, and unlocks the Clerk user (reverses a prior ban; harmless if they were only
 * suspended). Idempotent: unbanning an already-active account still records the moderator's decision.
 */
export const unbanUser = mutation({
  args: { userId: v.id('profiles'), reason: v.string() },
  handler: async (ctx, { userId, reason }) => {
    const actor = await requireCapability(ctx, 'people.discipline');
    return unbanImpl(ctx, actor, { userId, reason });
  },
});

export async function unbanImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  { userId, reason }: { userId: Id<'profiles'>; reason: string },
): Promise<Id<'profiles'>> {
  {
    if (reason.trim().length === 0) throw new ConvexError('A reason is required');
    const target = await loadModeratableUser(ctx, actor, userId);

    await ctx.db.patch(userId, {
      status: 'active',
      statusReason: undefined,
      suspendedUntil: undefined,
      moderatedByUserId: actor._id,
    });
    await auditUser(ctx, actor._id, 'unban', userId, reason, { prev: statusPrev(target) });
    await ctx.scheduler.runAfter(0, internal.clerkAdmin.setBanned, {
      clerkUserId: target.clerkUserId,
      banned: false,
    });
    return userId;
  }
}

/**
 * Set (or clear) a requester's **open-bounty cap** (D57's deferred bounty lever, built in A02).
 *
 * A sibling of `setPostingPermission` rather than an argument on it, and the reason is mechanical:
 * that mutation's shape is `permission: 'reports' | 'hazards' | 'comments'` × `allowed: boolean`,
 * patched through a field map. A nullable *int* doesn't fit it. What is reusable gets reused — the
 * same `loadModeratableUser` guard and the same `set_posting_permission` audit action — so the
 * moderation log still reads as one story rather than growing a parallel vocabulary for one field.
 *
 * `undefined` clears back to the global cap; `0` blocks bounty posting outright while leaving reports
 * and hazards untouched, which is the proportionality the whole D57 family exists for.
 */
export const setBountyPostLimit = mutation({
  args: {
    userId: v.id('profiles'),
    /** Absent ⇒ back to the global cap. */
    limit: v.optional(v.number()),
    reason: v.string(),
  },
  handler: async (ctx, { userId, limit, reason }) => {
    const actor = await requireCapability(ctx, 'people.discipline');
    return setBountyLimitImpl(ctx, actor, { userId, limit, reason });
  },
});

export async function setBountyLimitImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  { userId, limit, reason }: { userId: Id<'profiles'>; limit?: number; reason: string },
): Promise<Id<'profiles'>> {
  if (reason.trim().length === 0) throw new ConvexError('A reason is required');
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new ConvexError('A bounty limit has to be a whole number, zero or more');
  }
  const target = await loadModeratableUser(ctx, actor, userId);

  await ctx.db.patch(userId, { activeBountyPostLimit: limit });
  await auditUser(ctx, actor._id, 'set_posting_permission', userId, reason, {
    permission: 'bounties',
    limit: limit ?? null,
    prev: { limit: target.activeBountyPostLimit ?? null },
  });
  return userId;
}

/** Which `profiles` boolean each posting surface maps to (D57). */
const POSTING_PERMISSION_FIELD = {
  reports: 'canPostReports',
  hazards: 'canPostHazards',
  comments: 'canPostComments',
} as const;

/**
 * Restrict or restore a single posting right (D57) — the lever finer than suspend/ban. A user who
 * abuses one surface loses *that* surface (proportionate, appealable, reversible) while their other
 * contributions stand. Stores the boolean (`false` = restricted; `true` = explicitly allowed), audits
 * `set_posting_permission` with which right + direction.
 */
export const setPostingPermission = mutation({
  args: {
    userId: v.id('profiles'),
    permission: literals(['reports', 'hazards', 'comments']),
    allowed: v.boolean(),
    reason: v.string(),
  },
  handler: async (ctx, { userId, permission, allowed, reason }) => {
    const actor = await requireCapability(ctx, 'people.discipline');
    return setPostingPermissionImpl(ctx, actor, { userId, permission, allowed, reason });
  },
});

export type PostingPermission = keyof typeof POSTING_PERMISSION_FIELD;

export async function setPostingPermissionImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  {
    userId,
    permission,
    allowed,
    reason,
  }: { userId: Id<'profiles'>; permission: PostingPermission; allowed: boolean; reason: string },
): Promise<Id<'profiles'>> {
  if (reason.trim().length === 0) throw new ConvexError('A reason is required');
  const target = await loadModeratableUser(ctx, actor, userId);

  const field = POSTING_PERMISSION_FIELD[permission];
  await ctx.db.patch(userId, { [field]: allowed });
  await auditUser(ctx, actor._id, 'set_posting_permission', userId, reason, {
    permission,
    allowed,
    // Missing means allowed (D57), so the prior value is always a boolean.
    prev: { allowed: target[field] !== false },
  });
  return userId;
}
