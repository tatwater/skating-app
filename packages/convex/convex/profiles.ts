/**
 * Profile functions.
 *
 * Identity split (D26): Clerk authenticates the user; this module owns the mirroring
 * `profiles` row. `upsertFromClerk` is the provisioning bridge the client calls after
 * Clerk sign-in — create-or-update the profile keyed by the Clerk subject. Kept
 * idempotent so it's safe to call on every app launch.
 */

import { isCurrentRiskAckVersion, isMinor, meetsMinimumAge } from '@skating/core'
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
    dateOfBirth: v.number(), // UTC-midnight epoch ms; gate + minor status derived (D41)
    riskAckVersion: v.string(), // must be the current version (D45); rejected otherwise
    riskAckAt: v.number(), // when the user accepted (client-supplied epoch ms)
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new ConvexError('Not authenticated')

    // Hard 16+ minimum (D41), derived from DOB and enforced server-side. Minor status
    // is likewise derived, so it self-corrects on the user's 18th birthday with no
    // re-attestation or scheduled job (same pattern as suspension lapse).
    const now = Date.now()
    if (!meetsMinimumAge(args.dateOfBirth, now)) {
      throw new ConvexError('You must be at least 16 years old')
    }
    const minor = isMinor(args.dateOfBirth, now)

    // Assumption-of-risk acknowledgment (D45). The Convex function is the trust boundary
    // (D37), so a profile can't be created OR kept in sync without a *current* recorded
    // acceptance — never trust a client-side gate. Bumping the version re-prompts users.
    if (!isCurrentRiskAckVersion(args.riskAckVersion)) {
      throw new ConvexError('You must accept the current assumption-of-risk acknowledgment')
    }

    const existing = await ctx.db
      .query('profiles')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', identity.subject))
      .unique()

    // An inactive account must not mutate its identity via this app-launch sync:
    //  - a banned/suspended user could squat a new username or rename to evade
    //    moderation (D37);
    //  - a *deleted* user would un-scrub the PII that deletion cleared (displayName →
    //    "deleted user", dropped handle — D33).
    // Idempotent sync still succeeds (returns the profile); it just applies no edits.
    if (existing && existing.status !== 'active') {
      return existing._id
    }

    // `username` is unique (06-data-model.md). Convex has no unique constraint, so
    // check the index and reject a name already held by a *different* profile. (Only
    // reached for new or active profiles — i.e. only when we're about to write it.)
    const usernameOwner = await ctx.db
      .query('profiles')
      .withIndex('by_username', (q) => q.eq('username', args.username))
      .first()
    if (usernameOwner && usernameOwner.clerkUserId !== identity.subject) {
      throw new ConvexError('Username is already taken')
    }

    if (existing) {
      // Re-assert follow-approval while the account is a minor; never silently *remove*
      // an existing requirement. So on the 18th birthday (minor → false) protection
      // persists — the public options simply become available for the user to choose (D41).
      // Keep the *original* acceptance time when the version is unchanged (a routine
      // app-launch re-sync); only stamp a new time when the user accepts a bumped version.
      const reAccepted = existing.riskAckVersion !== args.riskAckVersion
      await ctx.db.patch(existing._id, {
        displayName: args.displayName,
        username: args.username,
        dateOfBirth: args.dateOfBirth,
        requireFollowApproval: minor || existing.requireFollowApproval,
        riskAckVersion: args.riskAckVersion,
        riskAckAt: reAccepted ? args.riskAckAt : (existing.riskAckAt ?? args.riskAckAt),
      })
      return existing._id
    }

    return ctx.db.insert('profiles', {
      clerkUserId: identity.subject,
      displayName: args.displayName,
      username: args.username,
      dateOfBirth: args.dateOfBirth,
      riskAckVersion: args.riskAckVersion,
      riskAckAt: args.riskAckAt,
      driveTimePrefMinutes: 60,
      requireFollowApproval: minor, // minors default to approval-required (D41)
      notificationPrefs: DEFAULT_NOTIFICATION_PREFS,
      reputationPoints: 0,
      role: 'member',
      status: 'active',
      createdAt: now,
    })
  },
})
