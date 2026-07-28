/**
 * Comment functions (D21/D25/D41).
 *
 * All reports are public (D13), so comments are too — gated only by **moderation** (D32) and
 * **blocks** (D32): a blocked author's comment is hidden from the viewer (unlike their reports, which
 * always stay visible — D3). Threads cap at **2 levels** (D25); the pure rules
 * (`isValidCommentBody`, `buildCommentThread`) live in `@skating/core` and are re-enforced here at
 * the trust boundary (D37). **No notification delivery in this phase** — the `report_commented` type
 * exists (D21) but nothing is sent yet.
 */

import {
  buildCommentThread,
  canViewComment,
  type FeedAuthor,
  isMinor,
  isValidCommentBody,
  normalizeCommentBody,
  type ThreadComment,
  type ThreadNode,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import {
  assertCanPostComments,
  getCurrentProfile,
  requireContributor,
  requireProfile,
} from './lib/auth';
import { publicAuthor } from './lib/authorView';
import { bumpContributionCount, visibleDelta } from './lib/contributionCounts';
import { loadBlockedAuthorIds } from './lib/reportVisibility';

/**
 * Add a comment to a report (D21). `requireProfile`; **reject minors** (read-only, D41); the target
 * report must exist + be moderation-`visible`; validate the body; enforce the 2-level cap (D25) — a
 * reply's parent must exist, belong to the same report, and be **top-level** (the client flattens
 * deeper replies via `resolveReplyParentId`, and we re-enforce here). Delivery of the
 * `report_commented` notification is deferred.
 */
export const create = mutation({
  args: {
    reportId: v.id('reports'),
    parentCommentId: v.optional(v.id('comments')),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const profile = await requireContributor(ctx);
    const now = Date.now();

    // Minors are read-only (D41) — they can't comment, same as they can't post reports.
    if (isMinor(profile.dateOfBirth, now)) {
      throw new ConvexError('Users under 18 cannot post comments');
    }

    // D57 posting lever — a moderator can mute a toxic commenter while their safety reports stand.
    assertCanPostComments(profile);

    const report = await ctx.db.get(args.reportId);
    if (report?.moderationStatus !== 'visible') {
      throw new ConvexError('Report not found');
    }

    const body = normalizeCommentBody(args.body);
    if (!isValidCommentBody(body)) {
      throw new ConvexError('Comment must be between 1 and 2000 characters');
    }

    if (args.parentCommentId !== undefined) {
      const parent = await ctx.db.get(args.parentCommentId);
      if (!parent || parent.reportId !== args.reportId) {
        throw new ConvexError('Parent comment not found');
      }
      // 2-level cap (D25): a reply's parent must itself be top-level. A well-behaved client already
      // flattened via `resolveReplyParentId`; reject anything deeper defensively.
      if (parent.parentCommentId !== undefined) {
        throw new ConvexError('Replies can only be one level deep');
      }
    }

    const commentId = await ctx.db.insert('comments', {
      reportId: args.reportId,
      ...(args.parentCommentId !== undefined ? { parentCommentId: args.parentCommentId } : {}),
      authorId: profile._id,
      body,
      source: 'native',
      moderationStatus: 'visible',
      createdAt: now,
    });
    // Bump the author's denormalized comment counter (born visible) — see contributionCounts.ts.
    await bumpContributionCount(ctx, profile._id, 'commentCount', 1);
    return commentId;
  },
});

/**
 * Public author attribution for a comment (never the private profile — no coord/DOB). Aliased to the
 * feed's shape rather than redeclared: this was a near-identical copy, and the copy is precisely how a
 * deleted author ended up rendering differently here than on the card next to it (N3).
 */
type CommentAuthor = FeedAuthor;

/** A comment as the thread returns it. `comment` is `null` for a `[hidden]` placeholder (D25). */
interface CommentNodeView {
  id: string;
  hidden: boolean;
  comment: {
    body: string;
    authorId: string;
    author: CommentAuthor | null;
    isOwn: boolean;
    createdAt: number;
    editedAt?: number;
    /**
     * The author left and this comment's text was cleared (D62 second amendment). `body` is empty and
     * the client renders the standing-in line rather than a blank row.
     *
     * A **third** state alongside `hidden`, not a reuse of it. `hidden` means a moderator judged the
     * content or the viewer blocked its author, and both of those are about *this* comment; this one
     * is about a person who is no longer here, and it happened to every comment they ever wrote.
     * Collapsing them would make a departure look like a moderation action.
     */
    redacted?: true;
  } | null;
  replies: CommentNodeView[];
}

/**
 * A report's comment thread — 2-level (D25), moderation- + block-filtered (D32). A comment is
 * visible when it's moderation-`visible` AND the author isn't blocked; a hidden/blocked comment with
 * visible replies becomes a `[hidden]` placeholder so its children don't vanish. The report itself
 * must be visible (a comment on a hidden report is unreachable, so we short-circuit).
 */
export const listByReport = query({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }): Promise<CommentNodeView[]> => {
    const report = await ctx.db.get(reportId);
    if (report?.moderationStatus !== 'visible') return [];

    const viewer = await getCurrentProfile(ctx);
    const viewerId = viewer?._id ?? '';
    const blocked = await loadBlockedAuthorIds(ctx, viewerId);

    const comments = await ctx.db
      .query('comments')
      .withIndex('by_report', (q) => q.eq('reportId', reportId))
      .collect();

    const byId = new Map<string, Doc<'comments'>>();
    for (const c of comments) byId.set(c._id, c);

    // Structure + placeholder decisions come from the pure helper; `visible` is the block+moderation
    // gate computed here.
    const threadInput: ThreadComment[] = comments.map((c) => ({
      id: c._id,
      parentCommentId: c.parentCommentId,
      createdAt: c.createdAt,
      visible: canViewComment(viewerId, c.authorId, c.moderationStatus, blocked),
    }));
    const tree = buildCommentThread(threadInput);

    // Resolve author attribution once for every author that survives to a visible node.
    const now = Date.now();
    const authorCache = new Map<string, CommentAuthor | null>();
    const loadAuthor = async (authorId: string): Promise<CommentAuthor | null> => {
      const cached = authorCache.get(authorId);
      if (cached !== undefined) return cached;
      const author = await ctx.db.get(authorId as Doc<'comments'>['authorId']);
      // `null` when the row is genuinely gone — the thread omits the byline entirely rather than
      // printing 'Unknown'. A *deleted* author is not that case: they get a tombstone byline.
      const view: CommentAuthor | null = author ? publicAuthor(author, now) : null;
      authorCache.set(authorId, view);
      return view;
    };

    const toView = async (node: ThreadNode): Promise<CommentNodeView> => {
      const replies = await Promise.all(node.replies.map(toView));
      if (node.hidden) {
        return { id: node.id, hidden: true, comment: null, replies };
      }
      const doc = byId.get(node.id);
      // A non-hidden node always has a backing doc (it came from `comments`); guard for safety.
      if (!doc) return { id: node.id, hidden: true, comment: null, replies };
      return {
        id: node.id,
        hidden: false,
        comment: {
          body: doc.body,
          ...(doc.redactedAt !== undefined ? { redacted: true as const } : {}),
          authorId: doc.authorId,
          author: await loadAuthor(doc.authorId),
          isOwn: viewerId !== '' && doc.authorId === viewerId,
          createdAt: doc.createdAt,
          ...(doc.editedAt !== undefined ? { editedAt: doc.editedAt } : {}),
        },
        replies,
      };
    };

    return Promise.all(tree.map(toView));
  },
});

/**
 * Author-only edit (D25): last-write-wins on the body + a fresh `editedAt`. Re-validates via
 * `@skating/core`. A moderated comment (hidden/removed) can't be edited back into view.
 */
export const update = mutation({
  args: { commentId: v.id('comments'), body: v.string() },
  handler: async (ctx, args) => {
    const profile = await requireContributor(ctx);
    const existing = await ctx.db.get(args.commentId);
    if (!existing) throw new ConvexError('Comment not found');
    if (existing.authorId !== profile._id) {
      throw new ConvexError('Only the author can edit a comment');
    }
    if (existing.moderationStatus !== 'visible') {
      throw new ConvexError('This comment has been moderated and can no longer be edited');
    }

    const body = normalizeCommentBody(args.body);
    if (!isValidCommentBody(body)) {
      throw new ConvexError('Comment must be between 1 and 2000 characters');
    }

    await ctx.db.patch(args.commentId, { body, editedAt: Date.now() });
    return args.commentId;
  },
});

/**
 * Author soft-removes their **own** comment (sets `moderationStatus: removed`) — distinct from a
 * moderator takedown (`moderation.setModerationStatus`). Idempotent. A removed comment with visible
 * replies still renders as a `[hidden]` placeholder (D25), so replies aren't orphaned.
 */
export const remove = mutation({
  args: { commentId: v.id('comments') },
  handler: async (ctx, { commentId }) => {
    const profile = await requireProfile(ctx);
    const existing = await ctx.db.get(commentId);
    if (!existing) throw new ConvexError('Comment not found');
    if (existing.authorId !== profile._id) {
      throw new ConvexError('Only the author can remove a comment');
    }
    if (existing.moderationStatus !== 'removed') {
      await ctx.db.patch(commentId, { moderationStatus: 'removed' });
      // Drop the author's visible-comment counter if this was still counting (visible → removed).
      await bumpContributionCount(
        ctx,
        existing.authorId,
        'commentCount',
        visibleDelta(existing.moderationStatus, 'removed'),
      );
    }
    return commentId;
  },
});
