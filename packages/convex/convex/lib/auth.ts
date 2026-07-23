/**
 * Auth + authorization helpers.
 *
 * Identity split (D26): Clerk owns the auth user; we own a `profiles` row per user,
 * tied by `profiles.clerkUserId` (= Clerk `identity.subject`). The security boundary
 * is the Convex function, not the deployment (D37): every function resolves the
 * caller's profile from their Clerk identity and gates on `status`/`role`
 * server-side. Callers get a `ConvexError` they can branch on.
 */

import type { UserRole } from '@skating/core';
import { ConvexError } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

type Ctx = QueryCtx | MutationCtx;

/** Role precedence: admin ⊇ moderator ⊇ member (D37). */
const ROLE_RANK: Record<UserRole, number> = { member: 0, moderator: 1, admin: 2 };

/** The caller's profile, or `null` if unauthenticated / not yet provisioned. */
export async function getCurrentProfile(ctx: Ctx): Promise<Doc<'profiles'> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return ctx.db
    .query('profiles')
    .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', identity.subject))
    .unique();
}

/** The caller's profile, or throw if unauthenticated / provisioned-but-not-active (D37). */
export async function requireProfile(ctx: Ctx): Promise<Doc<'profiles'>> {
  const profile = await getCurrentProfile(ctx);
  if (!profile) throw new ConvexError('Not authenticated');
  if (profile.status === 'banned' || profile.status === 'deleted') {
    throw new ConvexError('Account is not active');
  }
  // A suspension blocks until it lapses (D37): an unset or future `suspendedUntil`
  // still gates; a past one is treated as active (the flip to `active` happens
  // separately). Compared at call time so the gate needs no scheduled cleanup.
  if (
    profile.status === 'suspended' &&
    (profile.suspendedUntil === undefined || profile.suspendedUntil > Date.now())
  ) {
    throw new ConvexError('Account is suspended');
  }
  return profile;
}

/** The caller's profile, or throw unless they hold at least `minRole` (D37). */
export async function requireRole(ctx: Ctx, minRole: UserRole): Promise<Doc<'profiles'>> {
  const profile = await requireProfile(ctx);
  if (ROLE_RANK[profile.role] < ROLE_RANK[minRole]) {
    throw new ConvexError(`Requires ${minRole} role`);
  }
  return profile;
}

/**
 * Granular posting permissions (D57) — a moderation lever finer than suspend/ban. A moderator can
 * revoke `canPostReports` / `canPostHazards` individually; **absent ⇒ allowed** (fail-open in the safe
 * direction, default-on for adults). Throws a branchable `ConvexError` when the surface is restricted.
 */
export function assertCanPostReports(profile: Doc<'profiles'>): void {
  if (profile.canPostReports === false) {
    throw new ConvexError('Your report posting has been restricted');
  }
}

export function assertCanPostHazards(profile: Doc<'profiles'>): void {
  if (profile.canPostHazards === false) {
    throw new ConvexError('Your hazard posting has been restricted');
  }
}
