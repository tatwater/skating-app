/**
 * Admin-surface user lookup (Phase 07 / D37). Distinct from the member-facing `profiles.searchProfiles`
 * (D13): that one is filtered to **public** profiles and excludes blocked/deleted accounts because it
 * powers ordinary user browsing. Operators need the opposite — find **any** account (private,
 * suspended, banned, or deleted) by name or exact handle to act on it — so this query drops the
 * visibility filter and is gated by `requireCapability('people.read')` instead. Raw trust numbers are NOT returned
 * here (they're admin-only, D50, and live on `profiles.getAdmin`); this is just the search hit list.
 */

import { normalizeUsername, type TrustClass, type UserStatus } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type MutationCtx, mutation, query } from './_generated/server';
import { writeAudit } from './lib/audit';
import { requireCapability } from './lib/auth';
import { clearLedgerGrantOnDemotion } from './lib/ledgerEditors';
import { reasonFor, roleChangeTakesAway, writeRefusal } from './lib/peopleCan';
import { refreshPersonRow } from './lib/peopleRows';
import { trustClassFor } from './lib/reputation';
import { stampTenure } from './lib/staffTenure';
import { literals } from './lib/validators';
import { type PersonWriteResult, personWriteResult } from './moderation';

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
    await requireCapability(ctx, 'people.read');
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
 * Moving an admin down to moderator also clears their ledger editing (D227, `lib/ledgerEditors.ts`),
 * and is refused while they are the last person who can edit the ledger.
 *
 * Self-targeting is refused, same as `revokeRole` — `grantRole(self, 'moderator')` is a *demotion*
 * dressed as a grant, and it would let the last admin strip their own admin rights (locking support,
 * trust, and role management out of the app entirely). Another admin can always change your role.
 */
export const grantRole = mutation({
  args: {
    userId: v.id('profiles'),
    role: literals(['moderator', 'admin']),
    /** Asked only for a demotion (admin to moderator); a promotion takes an optional note (D226). */
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { userId, role, reason }) => {
    const actor = await requireCapability(ctx, 'people.role');
    return grantRoleImpl(ctx, actor, { userId, role, reason });
  },
});

export type ElevatedRole = 'moderator' | 'admin';

/** `grantRole`'s body, self-guard included — also what an undo that restores a role runs (D226). */
export async function grantRoleImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  { userId, role, reason: given }: { userId: Id<'profiles'>; role: ElevatedRole; reason?: string },
): Promise<PersonWriteResult> {
  const target = await ctx.db.get(userId);
  if (!target) throw new ConvexError('User not found');
  // The rule the People page's role menu reads (`lib/peopleCan`).
  const why = await writeRefusal(ctx, actor, target, { kind: 'role', role });
  if (why !== null) throw new ConvexError(why);
  const { reason, defaulted } = reasonFor(
    given,
    roleChangeTakesAway(target.role, role),
    role === 'admin' ? 'Made an admin' : 'Made a moderator',
  );

  // An admin moved down to moderator loses ledger editing with the role (D227), audited first.
  await clearLedgerGrantOnDemotion(ctx, actor, target, role);
  await ctx.db.patch(userId, { role });
  const actionId = await writeAudit(ctx, {
    actorId: actor._id,
    action: 'grant_role',
    targetType: 'user',
    targetId: userId,
    reason,
    metadata: { role, priorRole: target.role, ...(defaulted ? { reasonDefaulted: true } : {}) },
    createdAt: Date.now(),
  });
  await refreshPersonRow(ctx, userId);
  // The Staff lane's row carries the tenure this write just changed (`lib/staffTenure`).
  await stampTenure(ctx, userId);
  return personWriteResult(ctx, userId, actionId);
}

/**
 * Revoke all elevated roles back to `member` (D37 — **admin-only**). Guards against an admin revoking
 * **their own** role (which could lock the last admin out). Audits `revoke_role` with the prior role.
 * An admin's ledger editing goes with the role (D227), and the last editor can't be revoked.
 */
export const revokeRole = mutation({
  // A demotion asks why (D226); revoking from someone with no role takes nothing away.
  args: { userId: v.id('profiles'), reason: v.optional(v.string()) },
  handler: async (ctx, { userId, reason }) => {
    const actor = await requireCapability(ctx, 'people.role');
    return revokeRoleImpl(ctx, actor, { userId, reason });
  },
});

/** `revokeRole`'s body, self-guard included — also what an undo back to `member` runs (D226). */
export async function revokeRoleImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  { userId, reason: given }: { userId: Id<'profiles'>; reason?: string },
): Promise<PersonWriteResult> {
  if (userId === actor._id) throw new ConvexError('You cannot revoke your own role');
  const target = await ctx.db.get(userId);
  if (!target) throw new ConvexError('User not found');
  const why = await writeRefusal(ctx, actor, target, { kind: 'role', role: 'member' });
  if (why !== null) throw new ConvexError(why);
  const { reason, defaulted } = reasonFor(
    given,
    roleChangeTakesAway(target.role, 'member'),
    'No role to revoke',
  );

  // Leaving admin takes ledger editing with it (D227), audited first; refused for the last editor.
  await clearLedgerGrantOnDemotion(ctx, actor, target, 'member');
  await ctx.db.patch(userId, { role: 'member' });
  const actionId = await writeAudit(ctx, {
    actorId: actor._id,
    action: 'revoke_role',
    targetType: 'user',
    targetId: userId,
    reason,
    metadata: { priorRole: target.role, ...(defaulted ? { reasonDefaulted: true } : {}) },
    createdAt: Date.now(),
  });
  await refreshPersonRow(ctx, userId);
  // The Staff lane's row carries the tenure this write just changed (`lib/staffTenure`).
  await stampTenure(ctx, userId);
  return personWriteResult(ctx, userId, actionId);
}
