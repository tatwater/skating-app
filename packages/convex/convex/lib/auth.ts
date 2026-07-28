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
  // `deleting` sits here rather than with the tombstone because it is a *live* account being taken
  // apart: the staged finalize job runs in several transactions, and anything this profile writes
  // between two of them would land in a table an earlier stage already drained and outlive its own
  // deletion (PR #29 review). Note this is the finalization lock, not the 30-day pending request —
  // a pending request deliberately gates nothing, so the person can still sign in and cancel.
  if (
    profile.status === 'banned' ||
    profile.status === 'deleting' ||
    profile.status === 'deleted'
  ) {
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

/**
 * The message a pending-deletion account gets when it tries to contribute. Exported so both clients
 * and the tests can match on it rather than on a duplicated literal.
 */
export const DELETION_PENDING_MESSAGE =
  'Your account is scheduled for deletion — cancel the deletion to post again';

/**
 * The caller's profile, or throw if they've asked to be deleted (D62 amendment, N5a).
 *
 * **Why a pending request is read-only, when the whole point of the 30 days is that the account still
 * works.** The window exists to keep *useful* content around while its author reconsiders — but a
 * report posted in hour 719 of that window is erased hours later while it's still the freshest thing
 * on the lake. Contributing and leaving are contradictory acts, and the app should make you pick one
 * rather than accept work it has already decided to throw away.
 *
 * The rule that falls out of it is worth stating, because it's what makes the deletion sweep simple:
 * **a departed user's newest `skateEndTime` can never be later than their deletion request**, so
 * everything they hold is already past the 30-day relevance window by the time finalization runs.
 * The grace window and the relevance window are the same 30 days *by construction*, not by
 * coincidence — see `accountDeletion.ts`.
 *
 * **This is not `requireProfile`, deliberately, and the seam is two-sided:**
 *
 * - It can't live *in* `requireProfile`, because that helper gates **queries** too. Someone in their
 *   grace window has to be able to read the app — that's most of what "you can still sign in and
 *   change your mind" means.
 * - It can't be the only gate either. What stays open is everything that isn't a contribution to the
 *   public record: **flagging** (a hazard is no less dangerous because the person who spotted it is
 *   leaving), **blocking** (self-protection outlives the account), **support**, **export**, private
 *   preferences, and — the load-bearing one — **cancelling the deletion**.
 *
 * Contrast the `deleting` status handled by `requireProfile`: that's the finalization lock, it gates
 * everything including the exemptions above, and it isn't reversible. This one is a fork in the road,
 * and the way back is a single button.
 */
export async function requireContributor(ctx: Ctx): Promise<Doc<'profiles'>> {
  const profile = await requireProfile(ctx);
  if (profile.deletionRequestedAt !== undefined) {
    throw new ConvexError(DELETION_PENDING_MESSAGE);
  }
  return profile;
}

/**
 * The caller's profile, or throw unless they hold at least `minRole` (D37).
 *
 * **Reads only.** This deliberately builds on `requireProfile`, so a departing operator can still
 * *see* the admin surfaces during their window — same reason the ghost gate isn't in `requireProfile`
 * at all. Every role-gated **mutation** takes {@link requireContributorRole} instead; see there for why
 * the split has to be explicit rather than implied.
 */
export async function requireRole(ctx: Ctx, minRole: UserRole): Promise<Doc<'profiles'>> {
  const profile = await requireProfile(ctx);
  assertRole(profile, minRole);
  return profile;
}

/**
 * The caller's profile, or throw unless they hold at least `minRole` **and** are not on their way out
 * (PR #30 review).
 *
 * **The hole this closes.** `requireContributor` is composed from `requireProfile`, and so was
 * `requireRole` — so the two gates sat *beside* each other rather than one inside the other, and a
 * moderator or admin who had asked to be deleted kept every privileged write: drawing a sub-area,
 * promoting a body feature, curating a put-in, resolving a flag, banning someone. Ordinary members
 * were read-only; the accounts with the most reach were not, which is exactly backwards.
 *
 * It matters for the same reason the member gate does, and one more besides. The content reason: a
 * sub-area or body feature authored in the window goes up attributed to an account that is about to
 * become a tombstone. The accountability reason, which is sharper: `moderationActions` is an audit
 * trail, and an action recorded against a moderator who is deleted three days later points at a row
 * with no person behind it. A ban is not a thing to be issued by someone who has already left.
 *
 * **Why this is a separate helper rather than a fix inside `requireRole`.** Fourteen role-gated
 * *queries* — the admin dashboards, the moderation queues, the analytics — must keep working, for the
 * same reason a ghost can still read the app: reading is most of what "you can still change your mind"
 * means, and an operator reviewing the damage before they go is a reasonable thing to be doing.
 */
export async function requireContributorRole(
  ctx: Ctx,
  minRole: UserRole,
): Promise<Doc<'profiles'>> {
  const profile = await requireContributor(ctx);
  assertRole(profile, minRole);
  return profile;
}

/** The rank comparison itself, shared so the two role gates can't drift on what "at least" means. */
function assertRole(profile: Doc<'profiles'>, minRole: UserRole): void {
  if (ROLE_RANK[profile.role] < ROLE_RANK[minRole]) {
    throw new ConvexError(`Requires ${minRole} role`);
  }
}

/**
 * Whether this profile should be *sent* anything (PR #30 review).
 *
 * Six call sites used to ask `status === 'active'`, which is the wrong question for a ghost by
 * construction: `status` stays `active` through the whole window on purpose, because it is what
 * `requireProfile` reads and a departing person has to keep being able to sign in and cancel. So every
 * notification path treated someone who had asked to be deleted as an ordinary recipient.
 *
 * That combined badly with two other correct decisions. Their reports are **kept**, so people go on
 * commenting on them and rating them; and `setNotificationPrefs` moved behind `requireContributor` with
 * every other profile field, so they could not turn any of it off. The app went quiet everywhere except
 * the one channel that reaches out and taps them.
 *
 * The fix is here rather than at the switch: a person who no longer exists on the platform shouldn't be
 * receiving mail about it, and reopening the preference would have let a ghost edit a profile field the
 * request had just cleared.
 */
export function canReceiveNotifications(profile: Doc<'profiles'>): boolean {
  return profile.status === 'active' && profile.deletionRequestedAt === undefined;
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

/**
 * `canPostComments` (D57 extension) — mute a toxic commenter *without* silencing their safety reports.
 * Same fail-open shape as the report/hazard gates: absent ⇒ allowed.
 */
export function assertCanPostComments(profile: Doc<'profiles'>): void {
  if (profile.canPostComments === false) {
    throw new ConvexError('Your comment posting has been restricted');
  }
}
