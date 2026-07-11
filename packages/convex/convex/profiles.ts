/**
 * Profile functions.
 *
 * Identity split (D26): Clerk authenticates the user; this module owns the mirroring
 * `profiles` row. `upsertFromClerk` is the provisioning bridge the client calls after
 * Clerk sign-in — create-or-update the profile keyed by the Clerk subject. Kept
 * idempotent so it's safe to call on every app launch.
 */

import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { getCurrentProfile } from './lib/auth'
import { NOTIFICATION_PREF_KEYS } from './lib/enums'

/** All notification types default on (D16); keys single-sourced with the schema. */
const DEFAULT_NOTIFICATION_PREFS = Object.fromEntries(
  NOTIFICATION_PREF_KEYS.map((key) => [key, true]),
) as Record<(typeof NOTIFICATION_PREF_KEYS)[number], boolean>

/** The signed-in user's own profile, or `null` if not signed in / not yet provisioned. */
export const current = query({
  args: {},
  handler: (ctx) => getCurrentProfile(ctx),
})

/** Create or update the caller's profile from their Clerk identity (idempotent). */
export const upsertFromClerk = mutation({
  args: {
    displayName: v.string(),
    username: v.string(),
    minAge16Attested: v.boolean(), // age gate at signup (D41)
    isMinor: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new ConvexError('Not authenticated')

    // Hard 16+ minimum (D41). Enforced server-side, not just at the client gate.
    if (!args.minAge16Attested) {
      throw new ConvexError('You must attest to being at least 16 years old')
    }

    // `username` is unique (06-data-model.md). Convex has no unique constraint, so
    // check the index and reject a name already held by a *different* profile.
    const usernameOwner = await ctx.db
      .query('profiles')
      .withIndex('by_username', (q) => q.eq('username', args.username))
      .first()
    if (usernameOwner && usernameOwner.clerkUserId !== identity.subject) {
      throw new ConvexError('Username is already taken')
    }

    const existing = await ctx.db
      .query('profiles')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', identity.subject))
      .unique()

    if (existing) {
      await ctx.db.patch(existing._id, {
        displayName: args.displayName,
        username: args.username,
      })
      return existing._id
    }

    const isMinor = args.isMinor ?? false
    return ctx.db.insert('profiles', {
      clerkUserId: identity.subject,
      displayName: args.displayName,
      username: args.username,
      driveTimePrefMinutes: 60,
      requireFollowApproval: isMinor, // minors default to approval-required (D41)
      notificationPrefs: DEFAULT_NOTIFICATION_PREFS,
      minAge16Attested: args.minAge16Attested,
      isMinor,
      reputationPoints: 0,
      role: 'member',
      status: 'active',
      createdAt: Date.now(),
    })
  },
})
