/**
 * **The identity rules both profile writers share** (B03 §9.5): the username check, its messages,
 * the rename cooldown and a new profile's defaults. `profiles.ts` (the onboarding sync, the rename,
 * the availability query) and `consent.ts` (the acceptance that creates or re-introduces an account)
 * each used to be the one place a rule lived; two writers with a copy each would drift, so they ask
 * here.
 */

import { isValidUsername, normalizeUsername } from '@skating/core';
import { ConvexError } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { NOTIFICATION_PREF_DEFAULTS } from './enums';
import { DIGEST_TIMEZONE } from './notificationQueue';

/** What a refused username is told, one string per reason — shared by every path that sets one. */
export const USERNAME_MESSAGES = {
  invalid: 'Username must be 3–30 characters: letters, numbers, or underscores',
  taken: 'Username is already taken',
} as const;

export type UsernameVerdict =
  | { ok: true; username: string }
  | { ok: false; username: string; reason: keyof typeof USERNAME_MESSAGES };

/**
 * May `holderClerkId` have this username? **The one rule** (B03 §11): onboarding, the acceptance, the
 * availability query and the rename all ask it, so a name the settings field calls free is a name the
 * save takes.
 *
 * The canonical form first (D37 — the client's normalization is a courtesy), then the shape, then
 * the index: a name is taken when a *different* account holds it. That includes a ghost (D62): the
 * handle is reserved through the deletion window so canceling can give it back, and a tombstone's
 * synthetic sentinel never collides with a valid handle. Your own current name is yours, not taken.
 */
export async function checkUsername(
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
 * handle calls it (`changeUsername`, `upsertFromClerk`'s re-sync, and the acceptance that
 * re-introduces a canceled deletion), so none is a way round.
 */
export function assertMayRename(
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
 * The fields a brand-new profile starts with, beside its identity: the defaults every account is
 * born with, wherever it is born. Notification defaults per key (D16): most types on, the two opt-in
 * drive-time buckets off — single-sourced in `NOTIFICATION_PREF_DEFAULTS`, copied so a write can't
 * mutate the shared map. A minor is forced private (D13/D41); since D294 no new account is one, and
 * the branch stays for a lowered minimum.
 */
export function newProfileDefaults(now: number, minor: boolean) {
  return {
    driveTimePrefMinutes: 60,
    profileVisibility: minor ? ('private' as const) : ('public' as const),
    notificationPrefs: { ...NOTIFICATION_PREF_DEFAULTS },
    reputationPoints: 0,
    reportCount: 0,
    commentCount: 0,
    role: 'member' as const,
    status: 'active' as const,
    createdAt: now,
  };
}
