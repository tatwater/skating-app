/**
 * Profile functions.
 *
 * Identity split (D26): Clerk authenticates the user; this module owns the mirroring
 * `profiles` row. `upsertFromClerk` is the provisioning bridge the client calls after
 * Clerk sign-in — create-or-update the profile keyed by the Clerk subject. Kept
 * idempotent so it's safe to call on every app launch.
 */

import {
  canSetProfilePublic,
  isCurrentRiskAckVersion,
  isMinor,
  isValidBio,
  isValidDisplayName,
  isValidTownLabel,
  isValidUsername,
  meetsMinimumAge,
  normalizeBio,
  normalizeDisplayName,
  normalizeTownLabel,
  normalizeUsername,
  PROFILE_VISIBILITIES,
} from '@skating/core'
import { ConvexError, v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation, mutation, query } from './_generated/server'
import { getCurrentProfile, requireProfile } from './lib/auth'
import { NOTIFICATION_PREF_KEYS } from './lib/enums'
import { loadBlockedAuthorIds } from './lib/reportVisibility'
import { literals } from './lib/validators'

/** All notification types default on (D16); keys single-sourced with the schema. */
const DEFAULT_NOTIFICATION_PREFS = Object.fromEntries(
  NOTIFICATION_PREF_KEYS.map((key) => [key, true]),
) as Record<(typeof NOTIFICATION_PREF_KEYS)[number], boolean>

/** The signed-in user's own profile, or `null` if not signed in / not yet provisioned. */
export const current = query({
  args: {},
  handler: (ctx) => getCurrentProfile(ctx),
})

/**
 * Public attribution for a set of profile ids — the *only* fields a report feed/detail needs to
 * name its authors (`username` + `displayName`), never the private profile (home coord, DOB, etc.).
 * Returned as a `_id → { username, displayName }` map keyed by id so the UI can look each author up
 * without ordering assumptions; missing/deleted ids are simply absent. Full public profiles (D47)
 * are a later phase; this is the minimal read the Phase 2 report loop consumes.
 */
export const publicByIds = query({
  args: { profileIds: v.array(v.id('profiles')) },
  handler: async (ctx, { profileIds }) => {
    const result: Record<string, { username: string; displayName: string }> = {}
    for (const profileId of [...new Set(profileIds)]) {
      const profile = await ctx.db.get(profileId)
      if (profile) {
        result[profileId] = { username: profile.username, displayName: profile.displayName }
      }
    }
    return result
  },
})

/** Create or update the caller's profile from their Clerk identity (idempotent). */
export const upsertFromClerk = mutation({
  args: {
    displayName: v.string(),
    username: v.string(),
    dateOfBirth: v.number(), // UTC-midnight epoch ms; gate + minor status derived (D41)
    riskAckVersion: v.string(), // must be the current version (D45); rejected otherwise
    // Note: the acceptance *time* is deliberately NOT a client arg — the server stamps it
    // (see `now` below) so a wrong/tampered device clock can't corrupt the audit record.
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new ConvexError('Not authenticated')

    // Avatar is Clerk-managed for v1 (Phase 3 decision #2): mirror the OIDC `picture` claim into
    // `profileImageUrl` — no upload pipeline. Absent if the Clerk `convex` JWT template doesn't map
    // `picture`; when absent we leave any existing mirror untouched rather than clearing it.
    const profileImageUrl = identity.pictureUrl

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

    // Normalize + validate the identity fields here too (D37): the client validates for
    // instant feedback, but the trust boundary can't trust it. We store the canonical
    // forms so `username` uniqueness is genuinely case-insensitive (06-data-model.md).
    const username = normalizeUsername(args.username)
    if (!isValidUsername(username)) {
      throw new ConvexError('Username must be 3–30 characters: letters, numbers, or underscores')
    }
    const displayName = normalizeDisplayName(args.displayName)
    if (!isValidDisplayName(displayName)) {
      throw new ConvexError('Display name is required')
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
      .withIndex('by_username', (q) => q.eq('username', username))
      .first()
    if (usernameOwner && usernameOwner.clerkUserId !== identity.subject) {
      throw new ConvexError('Username is already taken')
    }

    if (existing) {
      // Force a minor's profile private; never silently *widen* an adult's existing choice. So on
      // the 18th birthday (minor → false) an already-private profile stays private until the user
      // opts to make it public — nothing is auto-widened (D13/D41). Posting also unlocks at 18
      // separately (reports.create gates on age), since all reports are public (D13).
      // Keep the *original* acceptance time when the version is unchanged (a routine
      // app-launch re-sync); only stamp a new time when the user accepts a bumped version.
      const reAccepted = existing.riskAckVersion !== args.riskAckVersion
      await ctx.db.patch(existing._id, {
        displayName,
        username,
        dateOfBirth: args.dateOfBirth,
        profileVisibility: minor ? 'private' : existing.profileVisibility,
        ...(profileImageUrl !== undefined ? { profileImageUrl } : {}),
        riskAckVersion: args.riskAckVersion,
        // Server-stamped: freshly on a new acceptance (version bump), otherwise the
        // original time is preserved across routine re-syncs (never trust the client clock).
        riskAckAt: reAccepted ? now : (existing.riskAckAt ?? now),
      })
      return existing._id
    }

    return ctx.db.insert('profiles', {
      clerkUserId: identity.subject,
      displayName,
      username,
      ...(profileImageUrl !== undefined ? { profileImageUrl } : {}),
      dateOfBirth: args.dateOfBirth,
      riskAckVersion: args.riskAckVersion,
      riskAckAt: now, // server-stamped, not client-supplied
      driveTimePrefMinutes: 60,
      profileVisibility: minor ? 'private' : 'public', // minors forced private (D13/D41)
      notificationPrefs: DEFAULT_NOTIFICATION_PREFS,
      reputationPoints: 0,
      role: 'member',
      status: 'active',
      createdAt: now,
    })
  },
})

/**
 * Re-accept the *current* assumption-of-risk acknowledgment for an already-provisioned
 * profile (D45). The lightweight counterpart to `upsertFromClerk`: when we bump
 * `RISK_ACK_VERSION`, existing users are re-prompted for consent *only* — they don't
 * re-enter their profile fields. The acceptance time is stamped server-side (D37), and
 * `requireProfile` ensures a banned/suspended/deleted account can't re-ack its way in.
 */
export const acceptCurrentRiskAck = mutation({
  args: {
    // The client asserts the version it displayed; we reject anything but the current one
    // so a stale app build (still showing old copy) can't satisfy the gate.
    riskAckVersion: v.string(),
  },
  handler: async (ctx, args) => {
    const profile = await requireProfile(ctx)
    if (!isCurrentRiskAckVersion(args.riskAckVersion)) {
      throw new ConvexError('You must accept the current assumption-of-risk acknowledgment')
    }
    await ctx.db.patch(profile._id, {
      riskAckVersion: args.riskAckVersion,
      riskAckAt: Date.now(),
    })
    return profile._id
  },
})

/**
 * Edit the caller's own profile (D13) — bio, town label, and public↔private visibility. Each field
 * is optional (patch semantics: omit = leave unchanged); an empty bio/town clears it. `requireProfile`
 * gates the account; a **minor cannot set `public`** (D41), re-enforced from the stored DOB. All
 * normalization/validation is single-sourced in `@skating/core`.
 */
export const updateProfile = mutation({
  args: {
    bio: v.optional(v.string()),
    homeTownLabel: v.optional(v.string()),
    profileVisibility: v.optional(literals(PROFILE_VISIBILITIES)),
  },
  handler: async (ctx, args) => {
    const profile = await requireProfile(ctx)
    const now = Date.now()
    const patch: {
      bio?: string
      homeTownLabel?: string
      profileVisibility?: (typeof PROFILE_VISIBILITIES)[number]
    } = {}

    if (args.bio !== undefined) {
      const bio = normalizeBio(args.bio)
      if (!isValidBio(bio)) throw new ConvexError('Bio is too long')
      // Empty clears the field (stored as absent) rather than persisting an empty string.
      patch.bio = bio.length > 0 ? bio : undefined
    }
    if (args.homeTownLabel !== undefined) {
      const town = normalizeTownLabel(args.homeTownLabel)
      if (!isValidTownLabel(town)) throw new ConvexError('Town label is too long')
      patch.homeTownLabel = town.length > 0 ? town : undefined
    }
    if (args.profileVisibility !== undefined) {
      if (args.profileVisibility === 'public' && !canSetProfilePublic(profile.dateOfBirth, now)) {
        throw new ConvexError('Users under 18 must keep a private profile')
      }
      patch.profileVisibility = args.profileVisibility
    }

    await ctx.db.patch(profile._id, patch)
    return profile._id
  },
})

/** One entry in a public profile's report history — the report plus its lake name for the card. */
interface ProfileReport {
  report: Doc<'reports'>
  waterBodyName: string
}

/** The full public payload; `private: true` collapses it to name + avatar only (D13). */
type PublicProfile =
  | {
      userId: string
      username: string
      displayName: string
      profileImageUrl?: string
      isSelf: boolean
      private: true
    }
  | {
      userId: string
      username: string
      displayName: string
      profileImageUrl?: string
      isSelf: boolean
      private: false
      homeTownLabel?: string
      bio?: string
      reputationPoints: number // trust score (D50) — renders as 0 until Phase 6 computes it
      reportCount: number
      commentCount: number
      reports: ProfileReport[]
    }

/**
 * A viewable profile by username (D13). Resolves `by_username`; **bidirectional block hide** (viewer
 * blocked target OR target blocked viewer → treated as not-found); a `deleted` account is not shown.
 * A **public** profile (or the caller's own) returns the full payload — name, avatar, town, bio,
 * #reports/#comments, `reputationPoints` (0 until Phase 6), and visible report history. A **private**
 * profile returns name + avatar only. Never leaks the home coordinate, DOB, or tokens.
 */
export const getPublicProfile = query({
  args: { username: v.string() },
  handler: async (ctx, { username }): Promise<PublicProfile | null> => {
    const target = await ctx.db
      .query('profiles')
      .withIndex('by_username', (q) => q.eq('username', normalizeUsername(username)))
      .unique()
    if (!target || target.status === 'deleted') return null

    const viewer = await getCurrentProfile(ctx)
    const viewerId = viewer?._id ?? ''
    const isSelf = viewerId !== '' && viewerId === target._id
    if (!isSelf && viewerId !== '') {
      const blocked = await loadBlockedAuthorIds(ctx, viewerId)
      if (blocked.has(target._id)) return null // bidirectional hide → not found
    }

    const base = {
      userId: target._id,
      username: target.username,
      displayName: target.displayName,
      ...(target.profileImageUrl !== undefined ? { profileImageUrl: target.profileImageUrl } : {}),
      isSelf,
    }

    // Private profiles are name + avatar only, and not browsable — unless it's your own profile.
    if (target.profileVisibility === 'private' && !isSelf) {
      return { ...base, private: true }
    }

    // Visible report history (moderation-visible only), newest skate time first.
    const authored = await ctx.db
      .query('reports')
      .withIndex('by_author', (q) => q.eq('authorId', target._id))
      .collect()
    const visibleReports = authored
      .filter((r) => r.moderationStatus === 'visible')
      .sort((a, b) => b.skateTime - a.skateTime)
    const reports: ProfileReport[] = []
    for (const report of visibleReports.slice(0, 50)) {
      const body = await ctx.db.get(report.waterBodyId)
      reports.push({ report, waterBodyName: body?.name ?? 'Unknown water body' })
    }

    // Visible comment count (by_author).
    const authoredComments = await ctx.db
      .query('comments')
      .withIndex('by_author', (q) => q.eq('authorId', target._id))
      .collect()
    const commentCount = authoredComments.filter((c) => c.moderationStatus === 'visible').length

    return {
      ...base,
      private: false,
      ...(target.homeTownLabel !== undefined ? { homeTownLabel: target.homeTownLabel } : {}),
      ...(target.bio !== undefined ? { bio: target.bio } : {}),
      reputationPoints: target.reputationPoints,
      reportCount: visibleReports.length,
      commentCount,
      reports,
    }
  },
})

/**
 * Search **public** profiles by display name (D13). Private profiles are excluded in-index (they're
 * not searchable); `deleted` accounts and anyone in the viewer's block set are filtered out. Exact
 * `@handle` lookups use `getPublicProfile` instead. Empty query → no results.
 */
export const searchProfiles = query({
  args: { query: v.string() },
  handler: async (ctx, { query }) => {
    const term = query.trim()
    if (term.length === 0) return []

    const viewer = await getCurrentProfile(ctx)
    const viewerId = viewer?._id ?? ''
    const blocked = viewerId !== '' ? await loadBlockedAuthorIds(ctx, viewerId) : new Set<string>()

    const matches = await ctx.db
      .query('profiles')
      .withSearchIndex('search_profile', (s) =>
        s.search('displayName', term).eq('profileVisibility', 'public'),
      )
      .take(20)

    return matches
      .filter((p) => p.status !== 'deleted' && !blocked.has(p._id))
      .map((p) => ({
        userId: p._id,
        username: p.username,
        displayName: p.displayName,
        ...(p.profileImageUrl !== undefined ? { profileImageUrl: p.profileImageUrl } : {}),
        ...(p.homeTownLabel !== undefined ? { homeTownLabel: p.homeTownLabel } : {}),
      }))
  },
})

/**
 * One-time backfill (Phase 3): add the new `reportCommented` notification pref (default-on, D16) to
 * every existing profile. Required because `notificationPrefs` is `boolFlags(NOTIFICATION_PREF_KEYS)`
 * (every key required), so a profile row missing the new key would fail schema validation on its
 * next write. New profiles get it automatically via `DEFAULT_NOTIFICATION_PREFS`. Run once after
 * deploy (`convex run profiles:backfillNotificationPrefs`); cheap — prod is uninitialized and dev has
 * a handful of users.
 */
export const backfillNotificationPrefs = internalMutation({
  args: {},
  handler: async (ctx) => {
    const profiles = await ctx.db.query('profiles').collect()
    let patched = 0
    for (const p of profiles) {
      const prefs = p.notificationPrefs as Record<string, boolean>
      if (prefs.reportCommented === undefined) {
        await ctx.db.patch(p._id, {
          notificationPrefs: { ...p.notificationPrefs, reportCommented: true },
        })
        patched++
      }
    }
    return { patched, total: profiles.length }
  },
})
