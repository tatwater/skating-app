/**
 * The per-day sign-in record (B01, founder call 2026-11-10) — `signInDays`, one row per person per
 * UTC day they opened the app signed in. See the table's schema note for who reads it.
 *
 * **One cheap, idempotent write.** The first open of a day reads one index entry and inserts; every
 * later open that day reads the same entry, finds it, and writes nothing. Two opens racing (a phone
 * and a laptop at once) both read the empty range, but Convex's optimistic concurrency puts the
 * second commit's read set in conflict with the first's insert, so the second retries, finds the
 * row, and stops — one row, never two. A retry is the cost; a double count can't happen.
 *
 * **Who counts.** Anyone with a profile that is not on its way out: a pending deletion (D62) or a
 * finished one leaves no new record, since the deletion is about to erase it anyway. A suspended or
 * banned person who opens the app did sign in, and is counted; Metrics can tell them apart later
 * by joining the profile.
 */
import { metricDay } from '@skating/core';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/** Does an open by this profile go on the record? */
export function recordsSignIns(profile: Doc<'profiles'>): boolean {
  return (
    profile.status !== 'deleting' &&
    profile.status !== 'deleted' &&
    profile.deletionRequestedAt === undefined
  );
}

/**
 * Put `profile`'s open at `now` on the record, once per UTC day. Returns whether this call wrote
 * the day's row (`false` when the day was already on the record, or the profile isn't counted).
 */
export async function recordSignInDay(
  ctx: MutationCtx,
  profile: Doc<'profiles'>,
  now: number,
): Promise<boolean> {
  if (!recordsSignIns(profile)) return false;
  const day = metricDay(now);
  const existing = await ctx.db
    .query('signInDays')
    .withIndex('by_user_day', (q) => q.eq('userId', profile._id).eq('day', day))
    .first();
  if (existing) return false;
  await ctx.db.insert('signInDays', { userId: profile._id, day, firstAt: now });
  return true;
}
