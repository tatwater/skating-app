/**
 * Profile functions.
 *
 * Identity split (D26): Clerk authenticates the user; this module owns the mirroring
 * `profiles` row. `upsertFromClerk` is the provisioning bridge the client calls from the
 * onboarding screen — create-or-update the profile keyed by the Clerk subject. Kept
 * idempotent, but it is *not* the launch-time path: both clients call it at onboarding only.
 * What runs on every app open is the pair beside it, `setTimezone` and `syncFromClerk`
 * (the Clerk mirrors — email and avatar).
 */

import {
  canSetProfilePublic,
  effectiveChannelPrefs,
  isCurrentRiskAckVersion,
  isDriveTimeBand,
  isKnownTimeZone,
  isLeaving,
  isMinor,
  isValidBio,
  isValidCoord,
  isValidDisplayName,
  isValidTownLabel,
  isValidTravelBaseUntil,
  isValidUsername,
  meetsMinimumAge,
  normalizeBio,
  normalizeDisplayName,
  normalizeTownLabel,
  normalizeUsername,
  type PostCardData,
  PROFILE_VISIBILITIES,
  sanitizeFeedFilters,
  TRAVEL_BASE_MAX_MS,
  type TrustClass,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server';
import {
  canReceiveNotifications,
  getCurrentProfile,
  hasCapability,
  requireCapability,
  requireContributor,
  requireProfile,
} from './lib/auth';
import { publicAuthor } from './lib/authorView';
import { NOTIFICATION_PREF_DEFAULTS, NOTIFICATION_PREF_KEYS } from './lib/enums';
import { loadFeedViewer, toPostCard } from './lib/feedCards';
import { isLastLedgerEditor, seesLedgerGrants, withoutLedgerGrantsFor } from './lib/ledgerEditors';
import { DIGEST_TIMEZONE } from './lib/notificationQueue';
import { loadBlockedAuthorIds, profileAccess } from './lib/reportVisibility';
import { trustClassFor } from './lib/reputation';
import { takeCappedResult } from './lib/scan';
import { recordSignInDay } from './lib/signInDays';
import { latLng, literals, partialBoolFlags } from './lib/validators';
import schema from './schema';

/**
 * Notification defaults for a fresh profile — per-key (D16): most types on, but the two opt-in
 * Phase-04 drive-time buckets (`nearbyReportDigest` / `greatReportNearby`) default off (decision #4).
 * Single-sourced in `NOTIFICATION_PREF_DEFAULTS`; copied so a mutation can't mutate the shared map.
 */
const DEFAULT_NOTIFICATION_PREFS = { ...NOTIFICATION_PREF_DEFAULTS };

/** The signed-in user's own profile, or `null` if not signed in / not yet provisioned. */
export const current = query({
  args: {},
  handler: (ctx) => getCurrentProfile(ctx),
});

/**
 * Public attribution for a set of profile ids — the fields a report feed/detail/comment thread needs to
 * name and *ring* its authors: `username` + `displayName` + the Clerk `profileImageUrl` + the cosmetic
 * `trustClass` (D50 — the `TrustAvatar` ring color; the raw score is never returned here). Never the
 * private profile (home coord, DOB, etc.). Returned as a `_id → { … }` map keyed by id so the UI can look
 * each author up without ordering assumptions; missing/deleted ids are simply absent.
 */
export const publicByIds = query({
  args: { profileIds: v.array(v.id('profiles')) },
  handler: async (ctx, { profileIds }) => {
    const now = Date.now();
    const result: Record<
      string,
      {
        username: string;
        displayName: string;
        profileImageUrl?: string;
        trustClass?: TrustClass | null;
        /**
         * A deletion tombstone (D33/D62). Returned so clients can render the name without offering a
         * link — the `username` on a tombstone is a synthetic sentinel, and routing to `/u/<sentinel>`
         * would be a dead end dressed up as a profile.
         */
        deleted?: true;
      }
    > = {};
    for (const profileId of [...new Set(profileIds)]) {
      const profile = await ctx.db.get(profileId);
      // A missing id is simply absent from the map (the documented contract). A *deleted* one is
      // present, as a tombstone — `lib/authorView` is the single place that distinction is made.
      if (!profile) continue;
      result[profileId] = publicAuthor(profile, now);
    }
    return result;
  },
});

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
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError('Not authenticated');

    // Avatar is Clerk-managed for v1 (Phase 03 decision #2): mirror the OIDC `picture` claim into
    // `profileImageUrl` — no upload pipeline. Absent if the Clerk `convex` JWT template doesn't map
    // `picture`; when absent we leave any existing mirror untouched rather than clearing it.
    const profileImageUrl = identity.pictureUrl;
    // The email, likewise mirrored from the `email` claim (A08 PR 3 / D174) so a notification email is
    // not a Clerk API call per recipient. Same absence rule: an unmapped claim leaves the mirror alone.
    // Both mirrors are *refreshed* on every later app open by `syncFromClerk` below — this mutation
    // runs at onboarding only.
    const email = identity.email;

    // Hard 16+ minimum (D41), derived from DOB and enforced server-side. Minor status
    // is likewise derived, so it self-corrects on the user's 18th birthday with no
    // re-attestation or scheduled job (same pattern as suspension lapse).
    const now = Date.now();
    if (!meetsMinimumAge(args.dateOfBirth, now)) {
      throw new ConvexError('You must be at least 16 years old');
    }
    const minor = isMinor(args.dateOfBirth, now);

    // Assumption-of-risk acknowledgment (D45). The Convex function is the trust boundary
    // (D37), so a profile can't be created OR kept in sync without a *current* recorded
    // acceptance — never trust a client-side gate. Bumping the version re-prompts users.
    if (!isCurrentRiskAckVersion(args.riskAckVersion)) {
      throw new ConvexError('You must accept the current assumption-of-risk acknowledgment');
    }

    // Normalize + validate the identity fields here too (D37): the client validates for
    // instant feedback, but the trust boundary can't trust it. We store the canonical
    // forms so `username` uniqueness is genuinely case-insensitive (06-data-model.md).
    const username = normalizeUsername(args.username);
    if (!isValidUsername(username)) throw new ConvexError(USERNAME_MESSAGES.invalid);
    const displayName = normalizeDisplayName(args.displayName);
    if (!isValidDisplayName(displayName)) {
      throw new ConvexError('Display name is required');
    }

    const existing = await ctx.db
      .query('profiles')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', identity.subject))
      .unique();

    // An inactive account must not mutate its identity via this onboarding sync:
    //  - a banned/suspended user could squat a new username or rename to evade
    //    moderation (D37);
    //  - a *deleted* user would un-scrub the PII that deletion cleared (displayName →
    //    "deleted user", dropped handle — D33).
    // Idempotent sync still succeeds (returns the profile); it just applies no edits.
    if (existing && existing.status !== 'active') {
      return existing._id;
    }

    // **A ghost is the same case wearing a different field** (D62 amendment). A pending deletion
    // scrubs the profile while leaving `status: 'active'` — deliberately, since `status` is the gate
    // that would also close reads — so without this branch a re-onboarding would helpfully re-sync
    // `displayName` and the avatar back out of Clerk and quietly un-delete the person's identity.
    // (`syncFromClerk`, which *does* run on every launch, carries the same guard for the same reason.)
    //
    // Canceling clears the stamp, and *then* this sync is exactly the re-onboarding path
    // (`needsProfileSetup` routes them here): same code, no special restore, and the name they type
    // is the name they get.
    if (existing && existing.deletionRequestedAt !== undefined) {
      return existing._id;
    }

    // `username` is unique (06-data-model.md) — `checkUsername` is the one rule, shared with the
    // availability query and the rename. (Only reached for new or active profiles — i.e. only when
    // we're about to write it.)
    const verdict = await checkUsername(ctx, username, identity.subject);
    if (!verdict.ok) throw new ConvexError(USERNAME_MESSAGES[verdict.reason]);

    if (existing) {
      // Force a minor's profile private; never silently *widen* an adult's existing choice. So on
      // the 18th birthday (minor → false) an already-private profile stays private until the user
      // opts to make it public — nothing is auto-widened (D13/D41). Posting also unlocks at 18
      // separately (reports.create gates on age), since all reports are public (D13).
      // Keep the *original* acceptance time when the version is unchanged (a re-onboarding,
      // e.g. after a canceled deletion); only stamp a new time when the user accepts a bumped version.
      const reAccepted = existing.riskAckVersion !== args.riskAckVersion;
      // A different handle on an existing profile is a rename, under the rename's cooldown — else
      // re-running onboarding would be the way round it. The same handle re-synced is not one.
      const renamed = username !== existing.username;
      if (renamed) assertMayRename(existing, now);
      await ctx.db.patch(existing._id, {
        displayName,
        username,
        ...(renamed ? { usernameChangedAt: now } : {}),
        dateOfBirth: args.dateOfBirth,
        profileVisibility: minor ? 'private' : existing.profileVisibility,
        ...(profileImageUrl !== undefined ? { profileImageUrl } : {}),
        ...(email !== undefined ? { email } : {}),
        riskAckVersion: args.riskAckVersion,
        // Server-stamped: freshly on a new acceptance (version bump), otherwise the
        // original time is preserved across routine re-syncs (never trust the client clock).
        riskAckAt: reAccepted ? now : (existing.riskAckAt ?? now),
      });
      return existing._id;
    }

    return ctx.db.insert('profiles', {
      clerkUserId: identity.subject,
      displayName,
      username,
      ...(profileImageUrl !== undefined ? { profileImageUrl } : {}),
      ...(email !== undefined ? { email } : {}),
      dateOfBirth: args.dateOfBirth,
      riskAckVersion: args.riskAckVersion,
      riskAckAt: now, // server-stamped, not client-supplied
      driveTimePrefMinutes: 60,
      profileVisibility: minor ? 'private' : 'public', // minors forced private (D13/D41)
      notificationPrefs: DEFAULT_NOTIFICATION_PREFS,
      reputationPoints: 0,
      reportCount: 0,
      commentCount: 0,
      role: 'member',
      status: 'active',
      createdAt: now,
    });
  },
});

/** What a refused username is told, one string per reason — shared by every path that sets one. */
const USERNAME_MESSAGES = {
  invalid: 'Username must be 3–30 characters: letters, numbers, or underscores',
  taken: 'Username is already taken',
} as const;

type UsernameVerdict =
  | { ok: true; username: string }
  | { ok: false; username: string; reason: keyof typeof USERNAME_MESSAGES };

/**
 * May `holderClerkId` have this username? **The one rule** (B03 §11): onboarding, the availability
 * query and the rename all ask it, so a name the settings field calls free is a name the save takes.
 *
 * The canonical form first (D37 — the client's normalization is a courtesy), then the shape, then
 * the index: a name is taken when a *different* account holds it. That includes a ghost (D62): the
 * handle is reserved through the deletion window so canceling can give it back, and a tombstone's
 * synthetic sentinel never collides with a valid handle. Your own current name is yours, not taken.
 */
async function checkUsername(
  ctx: QueryCtx,
  raw: string,
  holderClerkId: string,
): Promise<UsernameVerdict> {
  const username = normalizeUsername(raw);
  if (!isValidUsername(username)) return { ok: false, username, reason: 'invalid' };
  const owner = await ctx.db
    .query('profiles')
    .withIndex('by_username', (q) => q.eq('username', username))
    .first();
  if (owner && owner.clerkUserId !== holderClerkId) return { ok: false, username, reason: 'taken' };
  return { ok: true, username };
}

/**
 * Is this username free, and allowed (B03 §11, settings 7.x and onboarding)? Answers for the caller:
 * signed in, with or without a profile yet — onboarding asks before the row exists. `username` is
 * the canonical form the save would store, so the field can show what "Ada_K " becomes. A refusal
 * says which rule refused it; `current` marks the caller's own handle (free to them, nothing to save).
 */
export const usernameAvailable = query({
  args: { username: v.string() },
  handler: async (
    ctx,
    { username },
  ): Promise<{
    username: string;
    available: boolean;
    reason?: keyof typeof USERNAME_MESSAGES;
    current?: true;
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError('Not authenticated');
    const verdict = await checkUsername(ctx, username, identity.subject);
    if (!verdict.ok) {
      return { username: verdict.username, available: false, reason: verdict.reason };
    }
    const viewer = await getCurrentProfile(ctx);
    return {
      username: verdict.username,
      available: true,
      ...(viewer?.username === verdict.username ? { current: true as const } : {}),
    };
  },
});

/**
 * Change the caller's username (B03 §11). The handle lives on our row alone — Clerk mirrors only the
 * email and the avatar (`MirrorClaims`), and nothing denormalizes a username (every surface reads it
 * at render through `publicAuthor`) — so a rename is one patch with no mirror to fight and no copies
 * to chase. Old `/u/<name>` links stop resolving; that is what renaming means.
 *
 * `requireContributor`: a ghost's handle is reserved, not theirs to trade (D62), and `requireProfile`
 * under it keeps a banned or suspended account from renaming to slip a moderation action (D37) — the
 * same reason `upsertFromClerk` refuses an inactive account's identity edits.
 *
 * One rename per 30 days (`USERNAME_CHANGE_COOLDOWN_MS`), enforced here: a refusal is a `ConvexError`
 * whose data is `{ code: 'username_cooldown', message, unlocksAt }`. Re-saving the current name is
 * not a rename and is never refused. `usernameAvailable` doesn't know about the cooldown — it answers
 * whether a name is free, not whether the caller may take it today.
 */
export const changeUsername = mutation({
  args: { username: v.string() },
  handler: async (ctx, args) => {
    const profile = await requireContributor(ctx);
    const verdict = await checkUsername(ctx, args.username, profile.clerkUserId);
    if (!verdict.ok) throw new ConvexError(USERNAME_MESSAGES[verdict.reason]);
    if (verdict.username !== profile.username) {
      const now = Date.now();
      assertMayRename(profile, now);
      await ctx.db.patch(profile._id, { username: verdict.username, usernameChangedAt: now });
    }
    return { username: verdict.username };
  },
});

/**
 * How long a rename holds (founder call, 2026-11-07): long enough that a handle is something other
 * skaters can learn and find again, and that renaming can't be a way to shed a reputation.
 */
export const USERNAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** When the caller may rename again, or `null` when they may now (never renamed: no cooldown). */
export function usernameUnlocksAt(
  profile: Pick<Doc<'profiles'>, 'usernameChangedAt'>,
): number | null {
  return profile.usernameChangedAt === undefined
    ? null
    : profile.usernameChangedAt + USERNAME_CHANGE_COOLDOWN_MS;
}

/**
 * Throws the cooldown refusal — `{ code: 'username_cooldown', message, unlocksAt }` — when `profile`
 * renamed itself less than 30 days before `now`. Every path that changes an existing profile's
 * handle calls it (`changeUsername`, and `upsertFromClerk`'s re-sync), so neither is a way round.
 */
function assertMayRename(
  profile: Pick<Doc<'profiles'>, 'usernameChangedAt' | 'timezone'>,
  now: number,
): void {
  const unlocksAt = usernameUnlocksAt(profile);
  if (unlocksAt === null || now >= unlocksAt) return;
  throw new ConvexError({
    code: 'username_cooldown',
    message: usernameCooldownMessage(unlocksAt, profile.timezone ?? DIGEST_TIMEZONE),
    unlocksAt,
  });
}

/** The refusal, with the day it lifts in the skater's own zone (the digest's default without one). */
export function usernameCooldownMessage(unlocksAt: number, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(unlocksAt);
  return `You can change your username once every 30 days. You can change it again on ${day}.`;
}

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
    const profile = await requireProfile(ctx);
    if (!isCurrentRiskAckVersion(args.riskAckVersion)) {
      throw new ConvexError('You must accept the current assumption-of-risk acknowledgment');
    }
    await ctx.db.patch(profile._id, {
      riskAckVersion: args.riskAckVersion,
      riskAckAt: Date.now(),
    });
    return profile._id;
  },
});

/**
 * Edit the caller's own profile (D13) — bio, town label, and public↔private visibility. Each field
 * is optional (patch semantics: omit = leave unchanged); an empty bio/town clears it. A **minor cannot
 * set `public`** (D41), re-enforced from the stored DOB. All normalization/validation is
 * single-sourced in `@skating/core`.
 *
 * **`requireContributor`, not `requireProfile`** (D62 second amendment). A deletion request *clears*
 * these exact fields, and until this gate moved a ghost could type them straight back in — a scrubbed
 * profile that quietly re-collected a bio and a town for thirty days, with the wipe reading as a
 * suggestion rather than a deletion. The founder's rule is the blunt one and it's the right one:
 * becoming a ghost stops you editing any field.
 *
 * The one setting that had to survive that is `excludeTracksFromAggregate`, which used to ride along
 * on this mutation — see `setAggregateTracksOptOut` for why it now has its own.
 */
export const updateProfile = mutation({
  args: {
    bio: v.optional(v.string()),
    homeTownLabel: v.optional(v.string()),
    profileVisibility: v.optional(literals(PROFILE_VISIBILITIES)),
  },
  handler: async (ctx, args) => {
    const profile = await requireContributor(ctx);
    const now = Date.now();
    const patch: {
      bio?: string;
      homeTownLabel?: string;
      profileVisibility?: (typeof PROFILE_VISIBILITIES)[number];
    } = {};

    if (args.bio !== undefined) {
      const bio = normalizeBio(args.bio);
      if (!isValidBio(bio)) throw new ConvexError('Bio is too long');
      // Empty clears the field (stored as absent) rather than persisting an empty string.
      patch.bio = bio.length > 0 ? bio : undefined;
    }
    if (args.homeTownLabel !== undefined) {
      const town = normalizeTownLabel(args.homeTownLabel);
      if (!isValidTownLabel(town)) throw new ConvexError('Town label is too long');
      patch.homeTownLabel = town.length > 0 ? town : undefined;
    }
    if (args.profileVisibility !== undefined) {
      if (args.profileVisibility === 'public' && !canSetProfilePublic(profile.dateOfBirth, now)) {
        throw new ConvexError('Users under 18 must keep a private profile');
      }
      patch.profileVisibility = args.profileVisibility;
    }

    await ctx.db.patch(profile._id, patch);
    return profile._id;
  },
});

/**
 * The D58 global opt-out from the aggregate tracks layer. Retroactive by design (see the schema).
 *
 * **Its own mutation solely so it can outlive the account** (D62 second amendment). This is the one
 * setting a departing skater must not lose: it governs the tracks that *survive* their deletion, and
 * a person on their way out is exactly the person most likely to want them off the map. So it takes
 * `requireProfile` while every other profile edit takes `requireContributor` — the gate difference
 * *is* the reason the split exists, and folding this back into `updateProfile` to save a function
 * would silently re-close the door.
 *
 * `requireProfile` still rejects `deleting`: once finalization starts the answer is whatever they last
 * chose, and `writeTombstone` deliberately never touches this field.
 */
/**
 * Record the device's IANA timezone (A08 §3) — the only per-user input the 8pm digest has. Called by
 * both clients on app open, and only when it differs from what's stored, so an ordinary day writes
 * nothing. Validated by the zone primitives' own probe (`isKnownTimeZone`, core `zonedTime.ts`): the
 * runtime's `Intl` table is the one authority on what counts as a zone, and a bad string from a client
 * must not become the argument that makes `nextZonedHourMs` throw inside the fan-out for every report.
 *
 * `requireContributor` rather than `requireProfile`: a departing account has already been silenced
 * (`canReceiveNotifications`), so there is no digest for its zone to place.
 */
export const setTimezone = mutation({
  args: { timezone: v.string() },
  handler: async (ctx, { timezone }) => {
    const profile = await requireContributor(ctx);
    if (!isKnownTimeZone(timezone)) throw new ConvexError('Unknown timezone');
    if (profile.timezone === timezone) return profile._id;
    await ctx.db.patch(profile._id, { timezone });
    return profile._id;
  },
});

/**
 * Refresh the two Clerk mirrors — `email` (A08 PR 3 / D174) and `profileImageUrl` (Phase 03) — from
 * the identity's claims. Called by both clients on app open, beside `setTimezone`.
 *
 * **Why this exists apart from `upsertFromClerk`.** That mutation is the onboarding write: it takes
 * a display name, a username, a date of birth and a risk acknowledgment, and both clients call it
 * from the onboarding screen only. Nothing re-ran it on an ordinary launch, so a mirror set there was
 * set once — every profile that onboarded before the email field existed had no address, and a
 * changed Clerk email or avatar never reached us. The email sender's Clerk fallback papered over the
 * first (one lookup per person, cached), but a cached address is exactly the thing that goes stale
 * when the person changes it. This is the launch-time half: claims only, no identity args, writes
 * nothing when the claims match (beyond the day's sign-in row, once a day — below).
 *
 * **Never un-scrub.** The same rule as `upsertFromClerk`: an inactive account or a pending deletion
 * has had these fields cleared on purpose, and a launch-time sync is the first thing that would put
 * them back. Fail-soft rather than throw — this runs unattended on every open, and a ghost signing in
 * to cancel should see nothing from it. An unmapped claim (`undefined`) leaves the mirror alone.
 *
 * The gate is `canReceiveNotifications` — the same predicate `notificationDelivery.cacheEmail`, the
 * other writer of `profiles.email`, sits behind — so the two writers of the mirror can't drift on
 * who may hold one. (Like `upsertFromClerk`, and unlike `requireProfile`, this reads `status` alone:
 * a suspension that has lapsed without an explicit `unbanUser` still counts as inactive here.)
 *
 * The webhook (`applyClerkMirrors`) is the other caller of the same helper: this one fires on the
 * device's clock, that one on Clerk's, and the row can't tell which wrote it.
 */
export const syncFromClerk = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const profile = await profileForClerkUser(ctx, identity.subject);
    if (!profile) return null;
    // **The sign-in record (B01).** This is the one call every client makes on every open — and
    // again when an app left open returns on a new UTC day (web: `useOpenSync` on visibility and
    // focus; phone: AppState `active`) — so it is where a day's first open goes on the record,
    // before the mirror gate, which turns away a suspended account that did, all the same, sign
    // in. `lib/signInDays` decides who counts.
    await recordSignInDay(ctx, profile, Date.now());
    return applyClerkMirrorsTo(ctx, profile, {
      email: identity.email,
      profileImageUrl: identity.pictureUrl,
      updatedAt: clerkUpdatedAtFromClaim(identity.updatedAt),
    });
  },
});

/**
 * The `updated_at` claim as epoch ms, or `undefined` when the template doesn't map it or it can't
 * be read. Convex types the claim as a string; Clerk's `{{user.updated_at}}` renders a number, and a
 * hand-edited template could make it an ISO date — so all three are accepted, and seconds-precision
 * is promoted to ms rather than compared against a ms stamp from the webhook.
 */
function clerkUpdatedAtFromClaim(claim: unknown): number | undefined {
  let ms: number | undefined;
  if (typeof claim === 'number') ms = claim;
  else if (typeof claim === 'string' && claim.length > 0) {
    ms = /^\d+$/.test(claim) ? Number(claim) : Date.parse(claim);
  }
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return ms < 1e12 ? ms * 1000 : ms;
}

/**
 * The webhook's write (A08 post-merge): Clerk said this user changed, here is the address and
 * avatar now on the account. Same helper, same gate as `syncFromClerk`; the difference is only
 * where the claims came from — a signed webhook (`lib/clerkWebhook.ts`) rather than a signed token.
 * A `null` claim means the account has no such value and clears the mirror (an address removed in
 * Clerk must not keep receiving mail); an `undefined` one leaves it alone.
 */
export const applyClerkMirrors = internalMutation({
  args: {
    clerkUserId: v.string(),
    email: v.optional(v.union(v.string(), v.null())),
    profileImageUrl: v.optional(v.union(v.string(), v.null())),
    updatedAt: v.optional(v.number()),
  },
  handler: async (ctx, { clerkUserId, email, profileImageUrl, updatedAt }) =>
    applyClerkMirrorsFor(ctx, clerkUserId, { email, profileImageUrl, updatedAt }),
});

/**
 * A claim to mirror: a value, `null` to clear, `undefined` to leave as is. `updatedAt` is when
 * Clerk says the account last changed — the recency the write is ordered by.
 */
type MirrorClaims = {
  email?: string | null;
  profileImageUrl?: string | null;
  updatedAt?: number;
};

/**
 * Patch the Clerk mirrors on the profile for `clerkUserId`, if it may hold them — see
 * `syncFromClerk` for the gate. Returns the profile id, or `null` for no profile / not eligible.
 *
 * **Older news is refused.** Two sources write here and neither is ordered: Svix retries a
 * `user.updated` after a later one has landed, and a launch-time sync can run on a session token
 * minted *before* the change the webhook already applied (Clerk caches a template token for about
 * a minute). Each carries Clerk's `updated_at`; a write stamped older than the row's
 * `clerkUpdatedAt` is the earlier state arriving late and changes nothing. An equal stamp still
 * applies — the same change from the other source is idempotent, not stale. A write with no stamp
 * (an older template, a fixture) is applied as before and leaves the stamp alone.
 */
async function applyClerkMirrorsFor(
  ctx: MutationCtx,
  clerkUserId: string,
  claims: MirrorClaims,
): Promise<Id<'profiles'> | null> {
  const profile = await profileForClerkUser(ctx, clerkUserId);
  return profile ? applyClerkMirrorsTo(ctx, profile, claims) : null;
}

/** The profile for a Clerk subject, if one exists. */
function profileForClerkUser(ctx: MutationCtx, clerkUserId: string) {
  return ctx.db
    .query('profiles')
    .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', clerkUserId))
    .unique();
}

/** `applyClerkMirrorsFor` once the profile is in hand. */
async function applyClerkMirrorsTo(
  ctx: MutationCtx,
  profile: Doc<'profiles'>,
  claims: MirrorClaims,
): Promise<Id<'profiles'> | null> {
  if (!canReceiveNotifications(profile)) return null;
  if (
    claims.updatedAt !== undefined &&
    profile.clerkUpdatedAt !== undefined &&
    claims.updatedAt < profile.clerkUpdatedAt
  ) {
    return profile._id;
  }
  const patch: { email?: string; profileImageUrl?: string; clerkUpdatedAt?: number } = {};
  if (claims.updatedAt !== undefined && claims.updatedAt !== profile.clerkUpdatedAt) {
    patch.clerkUpdatedAt = claims.updatedAt;
  }
  if (claims.email !== undefined && (claims.email ?? undefined) !== profile.email) {
    patch.email = claims.email ?? undefined;
  }
  if (
    claims.profileImageUrl !== undefined &&
    (claims.profileImageUrl ?? undefined) !== profile.profileImageUrl
  ) {
    patch.profileImageUrl = claims.profileImageUrl ?? undefined;
  }
  if (Object.keys(patch).length > 0) await ctx.db.patch(profile._id, patch);
  return profile._id;
}

/**
 * The two channel switches (A08 PR 3 / D174): push on the phone, email for the eligible types. A
 * partial patch onto the effective prefs, so flipping one never resets the other. `requireProfile`
 * for the same reason as the aggregate opt-out: turning a channel *off* is exactly what a person on
 * their way out may want, and `canReceiveNotifications` already keeps a ghost from being sent to.
 */
export const setChannelPrefs = mutation({
  args: { push: v.optional(v.boolean()), email: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const profile = await requireProfile(ctx);
    const next = {
      ...effectiveChannelPrefs(profile.channelPrefs),
      ...(args.push !== undefined ? { push: args.push } : {}),
      ...(args.email !== undefined ? { email: args.email } : {}),
    };
    await ctx.db.patch(profile._id, { channelPrefs: next });
    return next;
  },
});

/**
 * The unsubscribe link's landing (A08 PR 3): turn the email channel off for the person whose secret
 * this is, and nothing else. Called from the HTTP route, which has no identity — the secret *is* the
 * authorization, and it authorizes exactly one direction: off. A wrong or stale secret is a no-op
 * that reports `false`, never an error that says whether the user exists.
 */
export const unsubscribeEmailBySecret = internalMutation({
  args: { userId: v.string(), secret: v.string() },
  handler: async (ctx, { userId, secret }): Promise<boolean> => {
    const id = ctx.db.normalizeId('profiles', userId);
    if (!id || secret.length === 0) return false;
    const profile = await ctx.db.get(id);
    if (!profile || profile.emailUnsubscribeSecret !== secret) return false;
    await ctx.db.patch(id, {
      channelPrefs: { ...effectiveChannelPrefs(profile.channelPrefs), email: false },
    });
    return true;
  },
});

/**
 * Remember the report form's put-in switch as the default for the next report (`schema.ts`
 * `profiles.showPutInDefault`). `requireContributor`, not `requireProfile`: a ghost cannot post, so
 * a remembered default has nothing left to seed — unlike the aggregate opt-out below, which governs
 * data that outlives the account.
 */
export const setShowPutInDefault = mutation({
  args: { showPutIn: v.boolean() },
  handler: async (ctx, { showPutIn }) => {
    const profile = await requireContributor(ctx);
    await ctx.db.patch(profile._id, { showPutInDefault: showPutIn });
    return profile._id;
  },
});

export const setAggregateTracksOptOut = mutation({
  args: { excludeTracksFromAggregate: v.boolean() },
  handler: async (ctx, { excludeTracksFromAggregate }) => {
    const profile = await requireProfile(ctx);
    await ctx.db.patch(profile._id, { excludeTracksFromAggregate });
    return profile._id;
  },
});

/**
 * Set (or clear) the caller's PRIVATE home coordinate (D11/D18) and recompute their drive-time bands.
 * `homeCoord` never leaves the server — only the derived `cachedIsochrones` polygons + `outerRadiusMeters`
 * are stored (decision #2). The isochrone recompute is an ORS-calling action, so it's scheduled (not
 * awaited); `storeBands` lands the result shortly after. Passing no coord clears the home and, on
 * recompute, the cached bands. Only ever run on an actual change (rate-limit, D18).
 */
export const setHome = mutation({
  args: { homeCoord: v.optional(latLng) },
  handler: async (ctx, { homeCoord }) => {
    // `requireContributor`: the deletion request clears `homeCoord` and its derived bands, and a ghost
    // re-setting them would re-collect the most sensitive coordinate we hold from an account that has
    // asked to be deleted (D62 second amendment).
    const profile = await requireContributor(ctx);
    if (homeCoord !== undefined && !isValidCoord(homeCoord)) {
      throw new ConvexError('Home coordinate is not valid');
    }
    await ctx.db.patch(profile._id, { homeCoord });
    await ctx.scheduler.runAfter(0, internal.isochrones.recompute, { userId: profile._id });
    return profile._id;
  },
});

/**
 * Measure drive time from somewhere else for a while (B03 §11, board 7.19): a cabin for the week, a
 * trip north. Until `until`, every drive-time read — the feed's bands and filter, the lake's arrival
 * band, the weather sweep's matches, the nearby-report alerts, "bounties near me" — reads the base
 * instead of home (`viewerDriveTime` / `driveOrigin`, the one rule); after it, home again, with
 * nothing for the skater to undo. PRIVATE exactly like `homeCoord` (D11): stored, never served.
 *
 * Schedules two recomputes: one now, so the polygons follow, and one at `until`, so they come home
 * on their own. A re-set or a clear cancels the pending one rather than leave an ORS call queued
 * for a base that no longer exists. `until` must be in the future and within `TRAVEL_BASE_MAX_MS`.
 */
export const setTravelBase = mutation({
  args: { lat: v.number(), lng: v.number(), until: v.number() },
  handler: async (ctx, { lat, lng, until }) => {
    // `requireContributor`, as `setHome`: a ghost re-collecting a private location is the thing the
    // deletion request promised to stop (D62 second amendment).
    const profile = await requireContributor(ctx);
    const coord = { lat, lng };
    if (!isValidCoord(coord)) throw new ConvexError('Travel base coordinate is not valid');
    if (!isValidTravelBaseUntil(until, Date.now())) {
      throw new ConvexError(
        `A travel base ends in the future, within ${TRAVEL_BASE_MAX_MS / 86_400_000} days`,
      );
    }
    await cancelTravelBaseExpiry(ctx, profile);
    const expiryJobId = await ctx.scheduler.runAt(until, internal.isochrones.recompute, {
      userId: profile._id,
    });
    await ctx.db.patch(profile._id, { travelBase: { coord, until, expiryJobId } });
    await ctx.scheduler.runAfter(0, internal.isochrones.recompute, { userId: profile._id });
    return profile._id;
  },
});

/**
 * Go home early (B03 §11): drop the travel base and recompute from home now. A no-op without one.
 * `requireProfile`, unlike the setter: ending a base only ever moves drive time back to the home the
 * person already gave us, and a departing account should be able to stop being measured from a
 * place it is no longer at.
 */
export const clearTravelBase = mutation({
  args: {},
  handler: async (ctx) => {
    const profile = await requireProfile(ctx);
    if (profile.travelBase === undefined) return profile._id;
    await cancelTravelBaseExpiry(ctx, profile);
    await ctx.db.patch(profile._id, { travelBase: undefined });
    await ctx.scheduler.runAfter(0, internal.isochrones.recompute, { userId: profile._id });
    return profile._id;
  },
});

/** Cancel the pending at-`until` recompute of the profile's current base, if one is still queued. */
async function cancelTravelBaseExpiry(ctx: MutationCtx, profile: Doc<'profiles'>): Promise<void> {
  const jobId = profile.travelBase?.expiryJobId;
  if (jobId === undefined) return;
  const job = await ctx.db.system.get(jobId);
  if (job?.state.kind === 'pending') await ctx.scheduler.cancel(jobId);
}

/**
 * Persist the server-sync copy of the feed filter row (decision #3/#6). Local storage is the working
 * copy; this is the durable/LWW copy reconciled on connect. The blob is untrusted (D37), so it's run
 * through `@skating/core` `sanitizeFeedFilters` — invalid/out-of-domain fields are dropped — before it's
 * stored. An empty result clears the stored prefs (show-everything).
 */
export const setFeedFilterPrefs = mutation({
  args: { filters: v.any() },
  handler: async (ctx, { filters }) => {
    const profile = await requireContributor(ctx);
    const clean = sanitizeFeedFilters(filters);
    await ctx.db.patch(profile._id, {
      feedFilterPrefs: Object.keys(clean).length > 0 ? clean : undefined,
    });
    return profile._id;
  },
});

/**
 * Update notification toggles + the two drive-time radii (decision #4). `prefs` is a partial patch
 * merged onto the stored full toggle set; `allRadiusMinutes` (X₁) / `greatRadiusMinutes` (X₂) are the
 * digest / great-report radii. Enforces **X₂ ≥ X₁** ("I'll drive farther for better ice") and that
 * each radius is a canonical band (30/60/90), comparing against whichever value ends up stored.
 */
export const setNotificationPrefs = mutation({
  args: {
    prefs: v.optional(partialBoolFlags(NOTIFICATION_PREF_KEYS)),
    allRadiusMinutes: v.optional(v.number()),
    greatRadiusMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // `requireContributor`, with a consequence worth naming rather than discovering: a ghost's
    // reports are *kept* under the second amendment, so people go on commenting on them and the
    // notifications go on arriving — and this is the switch that would have turned them off. The
    // right fix is to stop generating them for a departed account rather than to leave the switch
    // reachable on a profile that is otherwise frozen; it's logged as a follow-up in the A05a plan.
    const profile = await requireContributor(ctx);

    for (const [label, value] of [
      ['allRadiusMinutes', args.allRadiusMinutes],
      ['greatRadiusMinutes', args.greatRadiusMinutes],
    ] as const) {
      if (value !== undefined && !isDriveTimeBand(value)) {
        throw new ConvexError(`${label} must be 30, 60, or 90`);
      }
    }

    // Resolve the effective radii (provided value wins, else the stored one) and enforce X₂ ≥ X₁.
    const allRadius = args.allRadiusMinutes ?? profile.allRadiusMinutes;
    const greatRadius = args.greatRadiusMinutes ?? profile.greatRadiusMinutes;
    if (allRadius !== undefined && greatRadius !== undefined && greatRadius < allRadius) {
      throw new ConvexError('Great-report radius must be at least the all-reports radius');
    }

    const notificationPrefs = { ...profile.notificationPrefs };
    if (args.prefs) {
      for (const key of NOTIFICATION_PREF_KEYS) {
        const value = args.prefs[key];
        if (value !== undefined) notificationPrefs[key] = value;
      }
    }

    await ctx.db.patch(profile._id, {
      notificationPrefs,
      ...(args.allRadiusMinutes !== undefined ? { allRadiusMinutes: args.allRadiusMinutes } : {}),
      ...(args.greatRadiusMinutes !== undefined
        ? { greatRadiusMinutes: args.greatRadiusMinutes }
        : {}),
    });
    return profile._id;
  },
});

/**
 * How much history a public profile **lists** (the card history), bounded twice by one number: at
 * most this many Posts off the sort-key index, and at most this many member Reports hydrated across
 * them. A Post is up to `POST_MAX_REPORTS` cards, each a body, an author and its photos' thumbnail
 * URLs, so the Post window alone would let a prolific profile hydrate ten times the cards the
 * history held when it was Reports; the Report budget keeps the read where it was, cut at the Post
 * that would take it over. The displayed `reportCount`/`commentCount` are the true lifetime totals
 * from the denormalized profile counters, NOT this window — so a prolific reporter shows "212
 * reports" while the page still renders only the newest cards, and the read stays bounded either way.
 */
const PROFILE_HISTORY_LIMIT = 50;

/**
 * How many of a person's reports the distinct-lakes count reads — newest skate first, off
 * `by_author_skate_end_time`. A season of skating is a few dozen; past this the count is a floor.
 */
export const PROFILE_LAKE_SCAN_CAP = 500;

/**
 * The distinct lakes across a person's visible reports (B03 §11). Moderation-visible only — a
 * hidden report is not on their record — and keyed by the report's body, which a merge repoints
 * (D36), so one lake under two ids can't count twice. Bounded by `PROFILE_LAKE_SCAN_CAP`.
 */
async function distinctLakesOf(
  ctx: QueryCtx,
  authorId: Id<'profiles'>,
): Promise<{ count: number; capped: boolean }> {
  const { rows, truncated } = await takeCappedResult(
    ctx.db
      .query('reports')
      .withIndex('by_author_skate_end_time', (q) => q.eq('authorId', authorId))
      .order('desc'),
    PROFILE_LAKE_SCAN_CAP,
    'profiles.getPublicProfile(lakeCount)',
  );
  const lakes = new Set<string>();
  for (const r of rows) if (r.moderationStatus === 'visible') lakes.add(r.waterBodyId);
  return { count: lakes.size, capped: truncated };
}

/** One entry in a public profile's report history — the report plus its lake name for the card. */

/**
 * The full public payload; `private: true` collapses it to name + avatar only (D13). `trustClass` (the
 * cosmetic ring/chip class, D50) is on **both** variants — the avatar ring renders even on a private
 * profile, since trust is global + cosmetic and leaks no private state. The raw `reputationPoints` (for
 * the admin-only number) and `badges` / `bountyPoints` (the badge row) are on the public variant only.
 */
type PublicProfile =
  | {
      userId: string;
      username: string;
      displayName: string;
      profileImageUrl?: string;
      isSelf: boolean;
      trustClass: TrustClass | null;
      private: true;
    }
  | {
      userId: string;
      username: string;
      displayName: string;
      profileImageUrl?: string;
      isSelf: boolean;
      trustClass: TrustClass | null;
      private: false;
      homeTownLabel?: string;
      bio?: string;
      // Trust score (D50) — the raw number. Present ONLY when the *viewer* is a moderator/admin; omitted
      // from the wire for everyone else, so an ordinary viewer can't read it off the network response
      // (the class chip is the public signal). Ordinary viewers get `undefined`.
      reputationPoints?: number;
      bountyPoints: number; // separate bounty currency (decision 11); absent ⇒ 0
      badges: string[]; // earned BadgeType families in stable order (decision 6)
      reportCount: number;
      commentCount: number;
      /**
       * Distinct lakes across their visible reports (B03 §11). Counted over their newest
       * `PROFILE_LAKE_SCAN_CAP` reports; `lakeCountCapped` says the history ran past that, so the
       * page says "40+ lakes" rather than a number it didn't read.
       */
      lakeCount: number;
      lakeCountCapped?: true;
      /** The person's Posts, newest skate first, as the feed shows them (A10 / D186). */
      posts: PostCardData[];
    };

/**
 * A viewable profile by username (D13). Resolves `by_username`; **bidirectional block hide** (viewer
 * blocked target OR target blocked viewer → treated as not-found); a `deleted` account is not shown.
 * A **public** profile (or the caller's own) returns the full payload — name, avatar, town, bio,
 * #reports/#comments, cosmetic `trustClass` + `badges`/`bountyPoints`, and visible report history. The
 * raw `reputationPoints` number is included ONLY for a moderator/admin viewer (D50). A **private**
 * profile returns name + avatar only. Never leaks the home coordinate, DOB, or tokens.
 */
export const getPublicProfile = query({
  args: { username: v.string() },
  handler: async (ctx, { username }): Promise<PublicProfile | null> => {
    const target = await ctx.db
      .query('profiles')
      .withIndex('by_username', (q) => q.eq('username', normalizeUsername(username)))
      .unique();
    if (!target) return null;

    const viewer = await getCurrentProfile(ctx);
    const viewerId = viewer?._id ?? '';
    const isSelf = viewerId !== '' && viewerId === target._id;
    // Deleted, or blocked in either direction: not found. So is a ghost (D62 amendment), to everyone
    // but themselves — not "empty", *not found*. Their reports stay on the ice record under `Deleted
    // skater`; the person behind them stops existing the moment they ask to leave. The row is still
    // here, and so is the handle, which is why this is a read gate rather than a scrub: canceling has
    // to be able to give the name back.
    const access = await profileAccess(ctx, target, viewer);
    if (access === 'hidden') return null;
    // The raw trust number is admin-only (D50). Gate it server-side on the *viewer's* role so it never
    // leaves the deployment for an ordinary viewer — the client-side chrome that hides it is only
    // defense-in-depth. Own profile does not unlock it; a member never sees their own raw score.
    const viewerIsMod = viewer?.role === 'moderator' || viewer?.role === 'admin';

    const base = {
      userId: target._id,
      username: target.username,
      displayName: target.displayName,
      ...(target.profileImageUrl !== undefined ? { profileImageUrl: target.profileImageUrl } : {}),
      isSelf,
      trustClass: trustClassFor(target, Date.now()),
    };

    // Private profiles are name + avatar only, and not browsable — unless it's your own profile.
    if (access === 'private') return { ...base, private: true };

    // The person's **Posts**, newest skate-end time first — **bounded** (D13). We `.take()` a small
    // window off the sort-key index rather than `.collect()`ing everything, and hydrate members only
    // up to the Report budget, so a prolific reporter's page can't trigger an arbitrarily large
    // read. The displayed totals come from the denormalized counters below, not this window. Each
    // Post is the card the feed shows (A10 / D186), through the same builder — the put-in opt-out,
    // the blocks and the member visibility all ride with it.
    const authored = await ctx.db
      .query('posts')
      .withIndex('by_author_latest_skate_end_time', (q) => q.eq('authorId', target._id))
      .order('desc')
      .take(PROFILE_HISTORY_LIMIT);
    const feedViewer = await loadFeedViewer(ctx, undefined);
    const posts: PostCardData[] = [];
    let hydrated = 0;
    for (const post of authored) {
      if (post.moderationStatus !== 'visible') continue;
      // The budget is cut at a Post boundary — a card is a whole Post, never part of one — and
      // counted by the row's members before visibility, which is the read it costs.
      if (hydrated > 0 && hydrated + post.reportIds.length > PROFILE_HISTORY_LIMIT) break;
      hydrated += post.reportIds.length;
      const card = await toPostCard(ctx, post, feedViewer);
      if (card) posts.push(card);
    }

    // True lifetime totals from the denormalized counters (maintained on the create/moderation/remove
    // paths, seeded by `backfillContributionCounts`). A legacy row that predates the counter falls back
    // to the visible window length so it never shows a spuriously low 0 before the backfill runs.
    const reportCount = target.reportCount ?? posts.reduce((n, p) => n + p.reports.length, 0);
    const commentCount = target.commentCount ?? 0;
    const lakes = await distinctLakesOf(ctx, target._id);

    return {
      ...base,
      private: false,
      ...(target.homeTownLabel !== undefined ? { homeTownLabel: target.homeTownLabel } : {}),
      ...(target.bio !== undefined ? { bio: target.bio } : {}),
      // Admin-only raw score (D50) — included solely for a moderator/admin viewer (see `viewerIsMod`).
      ...(viewerIsMod ? { reputationPoints: target.reputationPoints } : {}),
      bountyPoints: target.bountyPoints ?? 0,
      badges: target.badges ?? [],
      reportCount,
      commentCount,
      lakeCount: lakes.count,
      ...(lakes.capped ? { lakeCountCapped: true as const } : {}),
      posts,
    };
  },
});

/**
 * Search **public** profiles by display name (D13). Private profiles are excluded in-index (they're
 * not searchable); `deleted` accounts and anyone in the viewer's block set are filtered out. Exact
 * `@handle` lookups use `getPublicProfile` instead. Empty query → no results.
 */
export const searchProfiles = query({
  args: { query: v.string() },
  handler: async (ctx, { query }) => {
    const term = query.trim();
    if (term.length === 0) return [];

    const viewer = await getCurrentProfile(ctx);
    const viewerId = viewer?._id ?? '';
    const blocked = viewerId !== '' ? await loadBlockedAuthorIds(ctx, viewerId) : new Set<string>();

    const matches = await ctx.db
      .query('profiles')
      .withSearchIndex('search_profile', (s) =>
        s.search('displayName', term).eq('profileVisibility', 'public'),
      )
      .take(20);

    return (
      matches
        // `isLeaving` alongside `deleted`: a ghost is gone from discovery the moment they ask, not when
        // the cron finally runs.
        .filter((p) => p.status !== 'deleted' && !isLeaving(p) && !blocked.has(p._id))
        .map((p) => ({
          userId: p._id,
          username: p.username,
          displayName: p.displayName,
          ...(p.profileImageUrl !== undefined ? { profileImageUrl: p.profileImageUrl } : {}),
          ...(p.homeTownLabel !== undefined ? { homeTownLabel: p.homeTownLabel } : {}),
          // The denormalized lifetime count (B03 §11, "@ada · 212 reports"); public profiles only,
          // since only those are searchable. Absent on a row that predates the counter.
          ...(p.reportCount !== undefined ? { reportCount: p.reportCount } : {}),
        }))
    );
  },
});

/**
 * The operator detail view of a user (D37/D50/D57). `requireCapability('people.read')`: a moderator sees the
 * lifecycle state, posting perms, and the **private, non-scoring `contradictionCount`** (their D57
 * lever's input) — but the **raw trust/bounty numbers stay admin-only** (D50), gated on the *viewer's*
 * role server-side so they never leave the deployment for a moderator. Bundles the user's recent
 * moderation history (actions taken against them) + any open flags naming them, so the detail page is
 * one read. The tenure-aware good-vs-bad trend is computed separately (the contributor-trust panel).
 */
export const getAdmin = query({
  args: { userId: v.id('profiles') },
  handler: async (ctx, { userId }) => {
    const viewer = await requireCapability(ctx, 'people.read');
    const isAdmin = hasCapability(viewer, 'people.trustScore');
    const target = await ctx.db.get(userId);
    if (!target) return null;

    const now = Date.now();
    const recentActions = await ctx.db
      .query('moderationActions')
      .withIndex('by_target', (q) => q.eq('targetType', 'user').eq('targetId', userId))
      .order('desc')
      .take(50);
    const openFlags = await ctx.db
      .query('contentFlags')
      .withIndex('by_target', (q) => q.eq('targetType', 'user').eq('targetId', userId))
      .filter((q) => q.eq(q.field('status'), 'open'))
      .take(50);

    return {
      userId: target._id,
      username: target.username,
      displayName: target.displayName,
      ...(target.profileImageUrl !== undefined ? { profileImageUrl: target.profileImageUrl } : {}),
      role: target.role,
      status: target.status,
      ...(target.statusReason !== undefined ? { statusReason: target.statusReason } : {}),
      ...(target.suspendedUntil !== undefined ? { suspendedUntil: target.suspendedUntil } : {}),
      trustClass: trustClassFor(target, now),
      // Posting-permission levers (D57) — absent ⇒ allowed; surfaced as booleans the UI toggles.
      canPostReports: target.canPostReports ?? true,
      canPostHazards: target.canPostHazards ?? true,
      canPostComments: target.canPostComments ?? true,
      // The bounty lever is a number, not a switch (A02) — absent means "the global cap applies",
      // which the control renders as an empty field rather than as a value someone set.
      ...(target.activeBountyPostLimit !== undefined
        ? { activeBountyPostLimit: target.activeBountyPostLimit }
        : {}),
      // Moderator-visible (their lever input); the raw trust score below is admin-gated separately.
      contradictionCount: target.contradictionCount ?? 0,
      reportCount: target.reportCount ?? 0,
      commentCount: target.commentCount ?? 0,
      createdAt: target.createdAt,
      // Raw numbers are admin-only (D50) — omitted from the wire for a moderator viewer.
      ...(isAdmin
        ? {
            reputationPoints: target.reputationPoints,
            bountyPoints: target.bountyPoints ?? 0,
          }
        : {}),
      recentActions: withoutLedgerGrantsFor(viewer, recentActions).map((a) => ({
        id: a._id,
        action: a.action,
        reason: a.reason,
        createdAt: a.createdAt,
      })),
      openFlagCount: openFlags.length,
      // Ledger editing (D227) — only an admin can hold it, so the row exists only on an admin, and
      // only for a viewer who can change it: an admin who holds it and is not on their way out
      // (`machinery.ledger`, the server's gate). Anyone else gets neither the row nor who holds it.
      // `lastLedgerEditor` says why a holder's revoke is refused before anyone presses it.
      ...(target.role === 'admin' && seesLedgerGrants(viewer)
        ? {
            ledgerEditor: target.canEditLedger === true,
            lastLedgerEditor: await isLastLedgerEditor(ctx, target),
          }
        : {}),
    };
  },
});

/**
 * The `profiles` fields the current schema allows — anything else on a stored row is retired drift.
 *
 * **Read off the schema, not hand-listed (A08).** This used to be a literal list, and it had drifted six
 * fields behind the schema (`excludeTracksFromAggregate`, `activeBountyPostLimit`,
 * `deletionRequestedAt`, `photosExpiredForSeason`, `photoReconcileStartedAt`, `timezone`) — so the
 * `replace` in `backfillNotificationPrefs` would have silently stripped a departing user's
 * deletion-request stamp, and everyone's aggregate opt-out, the next time anyone ran it. Found on the
 * way to running it for the `bountyAnswered` rename. Reading the schema's own field list makes the
 * drift impossible rather than merely caught.
 */
const PROFILE_FIELDS = Object.keys(schema.tables.profiles.validator.fields);

/**
 * One-time migration (Phase 03): **canonicalize** every `profiles` row to the current schema. A row
 * accumulated across earlier phases can fail strict validation several ways: a **missing** required
 * field (the new `profileVisibility` for very old rows, or `notificationPrefs.reportCommented`, D16),
 * or a **retired** field left behind by a removed feature (`requireFollowApproval`,
 * `notificationPrefs.newFollower` / `followedPostedNearby` from the pre-D13 social graph). This
 * rebuilds each row via `replace` from the allowed fields only — dropping retired top-level fields,
 * canonicalizing `notificationPrefs` to exactly `NOTIFICATION_PREF_KEYS` (preserving booleans,
 * defaulting missing keys on per D16), and defaulting a missing `profileVisibility` from age (minors
 * private, D41). New profiles are already canonical (`upsertFromClerk` + `DEFAULT_NOTIFICATION_PREFS`),
 * and prod is uninitialized, so this is a no-op there. Idempotent. Run once after deploy:
 * `convex run profiles:backfillNotificationPrefs`.
 *
 * **Phase 04 reuse:** this same migration canonicalizes the Phase-04 profile changes — it backfills the
 * three new `notificationPrefs` keys (`favoriteReport`/`nearbyReportDigest`/`greatReportNearby`, per
 * `NOTIFICATION_PREF_DEFAULTS`) and drops the retired `cachedIsochrone`/`cachedIsochroneAt` fields
 * (replaced by `cachedIsochrones`/`outerRadiusMeters`). Run it as part of the Phase-04 deploy.
 */
export const backfillNotificationPrefs = internalMutation({
  args: { cursor: v.optional(v.string()), batchSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, batchSize }) => {
    const now = Date.now();
    const allowed = new Set<string>(PROFILE_FIELDS);
    const page = await ctx.db
      .query('profiles')
      .paginate({ cursor: cursor ?? null, numItems: Math.min(500, Math.max(1, batchSize ?? 200)) });
    const profiles = page.page;
    let patched = 0;
    for (const p of profiles) {
      const raw = p as unknown as Record<string, unknown>;
      const prefs = (p.notificationPrefs ?? {}) as Record<string, boolean>;

      const notificationPrefs = Object.fromEntries(
        NOTIFICATION_PREF_KEYS.map((key) => [
          key,
          typeof prefs[key] === 'boolean' ? prefs[key] : NOTIFICATION_PREF_DEFAULTS[key],
        ]),
      ) as Record<(typeof NOTIFICATION_PREF_KEYS)[number], boolean>;

      const profileVisibility =
        (raw.profileVisibility as (typeof PROFILE_VISIBILITIES)[number] | undefined) ??
        (isMinor(p.dateOfBirth, now) ? 'private' : 'public');

      // Detect drift: a retired top-level field, a missing `profileVisibility`, or non-canonical prefs.
      const hasRetiredField = Object.keys(raw).some(
        (key) => key !== '_id' && key !== '_creationTime' && !allowed.has(key),
      );
      const missingVisibility = raw.profileVisibility === undefined;
      const prefsChanged =
        Object.keys(prefs).length !== NOTIFICATION_PREF_KEYS.length ||
        NOTIFICATION_PREF_KEYS.some((key) => prefs[key] !== notificationPrefs[key]);
      if (!hasRetiredField && !missingVisibility && !prefsChanged) continue;

      // Rebuild from allowed fields only (drops retired ones); replace so unknown keys don't linger.
      const clean: Record<string, unknown> = { notificationPrefs, profileVisibility };
      for (const key of PROFILE_FIELDS) {
        if (key === 'notificationPrefs' || key === 'profileVisibility') continue;
        if (raw[key] !== undefined) clean[key] = raw[key];
      }
      await ctx.db.replace(
        p._id,
        clean as unknown as Omit<Doc<'profiles'>, '_id' | '_creationTime'>,
      );
      patched++;
    }
    return { patched, total: profiles.length, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/**
 * One-time migration (Phase 04 follow-up): seed the denormalized `reportCount` / `commentCount` on every
 * profile from a one-time scan of that author's currently-**visible** reports + comments. Run once after
 * the counters ship; from then on the create / moderation / author-remove paths keep them exact, so the
 * profile read never re-scans a history to count it. Idempotent — re-running just rewrites the same
 * totals. `collect()` per author suits dev's handful of rows + prod's uninitialized state; a large
 * corpus would page. Run: `convex run profiles:backfillContributionCounts`.
 */
export const backfillContributionCounts = internalMutation({
  args: { cursor: v.optional(v.string()), batchSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, batchSize }) => {
    // Smaller pages than the other migrations: each profile costs two *lifetime* history scans, so
    // the per-profile read cost is what binds here, not the profile count (A01).
    const page = await ctx.db
      .query('profiles')
      .paginate({ cursor: cursor ?? null, numItems: Math.min(200, Math.max(1, batchSize ?? 50)) });
    const profiles = page.page;
    let patched = 0;
    for (const p of profiles) {
      const reports = await ctx.db
        .query('reports')
        .withIndex('by_author', (q) => q.eq('authorId', p._id))
        .collect();
      const comments = await ctx.db
        .query('comments')
        .withIndex('by_author', (q) => q.eq('authorId', p._id))
        .collect();
      const reportCount = reports.filter((r) => r.moderationStatus === 'visible').length;
      const commentCount = comments.filter((c) => c.moderationStatus === 'visible').length;
      if (p.reportCount !== reportCount || p.commentCount !== commentCount) {
        await ctx.db.patch(p._id, { reportCount, commentCount });
        patched++;
      }
    }
    return { patched, total: profiles.length, cursor: page.continueCursor, isDone: page.isDone };
  },
});
