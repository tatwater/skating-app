/**
 * Block functions (D32). A block is one bidirectional `blocks` row — "hide this person from me and
 * me from them" — with no follow graph to unwind (D13). Block == mute (one feature).
 *
 * What a block does (Phase 3, D3): it hides the other user's **profile** (both ways) and their
 * **comments**, and de-emphasizes their **report** author line with a "Blocked" chip — but it NEVER
 * hides their reports (a safety observation must stay in the commons). The block *set* is consumed by
 * `loadBlockedAuthorIds` (`lib/reportVisibility.ts`); this module owns the writes + the settings list.
 */

import { canBlock } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireProfile } from './lib/auth';
import { loadBlockedAuthorIds } from './lib/reportVisibility';

/**
 * Block a user (D32). `requireProfile`; reject self-block; idempotent — a re-block returns the
 * existing row rather than inserting a duplicate. The target must exist.
 */
export const block = mutation({
  args: { targetUserId: v.id('profiles') },
  handler: async (ctx, { targetUserId }) => {
    const profile = await requireProfile(ctx);
    if (!canBlock(profile._id, targetUserId)) throw new ConvexError('You cannot block yourself');

    const target = await ctx.db.get(targetUserId);
    if (!target) throw new ConvexError('User not found');

    const existing = await ctx.db
      .query('blocks')
      .withIndex('by_blocker', (q) => q.eq('blockerId', profile._id))
      .filter((q) => q.eq(q.field('blockedId'), targetUserId))
      .unique();
    if (existing) return existing._id;

    return ctx.db.insert('blocks', {
      blockerId: profile._id,
      blockedId: targetUserId,
      createdAt: Date.now(),
    });
  },
});

/**
 * Unblock a user (D32). Idempotent — removing a block that isn't there is a no-op. Only removes the
 * caller's *own* block edge; a block the other user placed on the caller is theirs to remove.
 */
export const unblock = mutation({
  args: { targetUserId: v.id('profiles') },
  handler: async (ctx, { targetUserId }) => {
    const profile = await requireProfile(ctx);
    const existing = await ctx.db
      .query('blocks')
      .withIndex('by_blocker', (q) => q.eq('blockerId', profile._id))
      .filter((q) => q.eq(q.field('blockedId'), targetUserId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});

/**
 * The caller's own block list for the settings screen — the users *they* blocked (their own edges,
 * not people who blocked them), with the minimal public attribution the list needs to render +
 * offer an unblock. Newest block first.
 */
export const myBlocks = query({
  args: {},
  handler: async (ctx) => {
    const profile = await requireProfile(ctx);
    const rows = await ctx.db
      .query('blocks')
      .withIndex('by_blocker', (q) => q.eq('blockerId', profile._id))
      .order('desc')
      .collect();
    const result: {
      userId: string;
      username: string;
      displayName: string;
      profileImageUrl?: string;
    }[] = [];
    for (const row of rows) {
      const target = await ctx.db.get(row.blockedId);
      if (!target) continue; // blocked user deleted — drop from the list
      result.push({
        userId: target._id,
        username: target.username,
        displayName: target.displayName,
        ...(target.profileImageUrl !== undefined
          ? { profileImageUrl: target.profileImageUrl }
          : {}),
      });
    }
    return result;
  },
});

/**
 * The viewer's full block set as an id array — unioned across **both** directions (I blocked them OR
 * they blocked me, D32), the very set `loadBlockedAuthorIds` builds for comment/profile hiding. The
 * report author-line "Blocked" chip reads this so it fires on an *incoming* block too, not just the
 * outgoing edges `myBlocks` (the Settings list) exposes — otherwise a viewer whose author blocked
 * *them* would see the author's comments hidden but no chip explaining why (a presentation gap).
 */
export const blockedUserIds = query({
  args: {},
  handler: async (ctx) => {
    const profile = await requireProfile(ctx);
    return [...(await loadBlockedAuthorIds(ctx, profile._id))];
  },
});
