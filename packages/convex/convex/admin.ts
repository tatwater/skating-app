/**
 * Admin-surface user lookup (Phase 7 / D37). Distinct from the member-facing `profiles.searchProfiles`
 * (D13): that one is filtered to **public** profiles and excludes blocked/deleted accounts because it
 * powers ordinary user browsing. Operators need the opposite — find **any** account (private,
 * suspended, banned, or deleted) by name or exact handle to act on it — so this query drops the
 * visibility filter and is `requireRole('moderator')`-gated instead. Raw trust numbers are NOT returned
 * here (they're admin-only, D50, and live on `profiles.getAdmin`); this is just the search hit list.
 */

import { normalizeUsername, type TrustClass } from '@skating/core';
import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { query } from './_generated/server';
import { requireRole } from './lib/auth';
import { trustClassFor } from './lib/reputation';

interface UserHit {
  userId: string;
  username: string;
  displayName: string;
  profileImageUrl?: string;
  role: 'member' | 'moderator' | 'admin';
  status: 'active' | 'suspended' | 'banned' | 'deleted';
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
