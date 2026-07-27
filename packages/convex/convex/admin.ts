/**
 * Admin-surface user lookup (Phase 7 / D37). Distinct from the member-facing `profiles.searchProfiles`
 * (D13): that one is filtered to **public** profiles and excludes blocked/deleted accounts because it
 * powers ordinary user browsing. Operators need the opposite — find **any** account (private,
 * suspended, banned, or deleted) by name or exact handle to act on it — so this query drops the
 * visibility filter and is `requireRole('moderator')`-gated instead. Raw trust numbers are NOT returned
 * here (they're admin-only, D50, and live on `profiles.getAdmin`); this is just the search hit list.
 */

import { normalizeUsername, type TrustClass, type UserStatus } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { requireRole } from './lib/auth';
import { trustClassFor } from './lib/reputation';
import { literals } from './lib/validators';

interface UserHit {
  userId: string;
  username: string;
  displayName: string;
  profileImageUrl?: string;
  role: 'member' | 'moderator' | 'admin';
  status: UserStatus; // the enum, not a copy of it — see PR #29's `deleting` addition
  trustClass: TrustClass | null;
}

/**
 * Search users for the operator surface (D37). Tries an exact `by_username` hit first (an operator
 * often pastes a handle), then the `search_profile` display-name index — WITHOUT the public-only
 * filter so private/suspended/banned accounts still surface. Bounded to 20 hits; empty query ⇒ no
 * results.
 */
export const userSearch = query({
  args: { query: v.string() },
  handler: async (ctx, { query: raw }): Promise<UserHit[]> => {
    await requireRole(ctx, 'moderator');
    const term = raw.trim();
    if (term.length === 0) return [];
    const now = Date.now();

    const toHit = (p: Doc<'profiles'>): UserHit => ({
      userId: p._id,
      username: p.username,
      displayName: p.displayName,
      ...(p.profileImageUrl !== undefined ? { profileImageUrl: p.profileImageUrl } : {}),
      role: p.role,
      status: p.status,
      trustClass: trustClassFor(p, now),
    });

    // Exact handle first — the fast path when an operator pastes `@someone`.
    const byHandle = await ctx.db
      .query('profiles')
      .withIndex('by_username', (q) => q.eq('username', normalizeUsername(term.replace(/^@/, ''))))
      .unique();

    const matches = await ctx.db
      .query('profiles')
      .withSearchIndex('search_profile', (s) => s.search('displayName', term))
      .take(20);

    const seen = new Set<string>();
    const hits: UserHit[] = [];
    for (const p of [...(byHandle ? [byHandle] : []), ...matches]) {
      if (seen.has(p._id)) continue;
      seen.add(p._id);
      hits.push(toHit(p));
    }
    return hits;
  },
});

/**
 * Grant a `moderator` or `admin` role (D37 — **admin-only**, the keys to the app's identity). Patches
 * `role` and audits `grant_role` with the prior role. Idempotent (re-granting the same role still
 * records the decision).
 *
 * Self-targeting is refused, same as `revokeRole` — `grantRole(self, 'moderator')` is a *demotion*
 * dressed as a grant, and it would let the last admin strip their own admin rights (locking support,
 * trust, and role management out of the app entirely). Another admin can always change your role.
 */
export const grantRole = mutation({
  args: { userId: v.id('profiles'), role: literals(['moderator', 'admin']), reason: v.string() },
  handler: async (ctx, { userId, role, reason }) => {
    const actor = await requireRole(ctx, 'admin');
    if (reason.trim().length === 0) throw new ConvexError('A reason is required');
    if (userId === actor._id) throw new ConvexError('You cannot change your own role');
    const target = await ctx.db.get(userId);
    if (!target) throw new ConvexError('User not found');

    await ctx.db.patch(userId, { role });
    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'grant_role',
      targetType: 'user',
      targetId: userId,
      reason,
      metadata: { role, priorRole: target.role },
      createdAt: Date.now(),
    });
    return userId;
  },
});

/**
 * Revoke all elevated roles back to `member` (D37 — **admin-only**). Guards against an admin revoking
 * **their own** role (which could lock the last admin out). Audits `revoke_role` with the prior role.
 */
export const revokeRole = mutation({
  args: { userId: v.id('profiles'), reason: v.string() },
  handler: async (ctx, { userId, reason }) => {
    const actor = await requireRole(ctx, 'admin');
    if (reason.trim().length === 0) throw new ConvexError('A reason is required');
    if (userId === actor._id) throw new ConvexError('You cannot revoke your own role');
    const target = await ctx.db.get(userId);
    if (!target) throw new ConvexError('User not found');

    await ctx.db.patch(userId, { role: 'member' });
    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'revoke_role',
      targetType: 'user',
      targetId: userId,
      reason,
      metadata: { priorRole: target.role },
      createdAt: Date.now(),
    });
    return userId;
  },
});
