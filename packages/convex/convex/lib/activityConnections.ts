/**
 * Writing a third-party activity connection — the one place credentials enter `activityConnections`.
 *
 * **Why this is a module and not three lines in `strava.ts`** (PR #29 review). The obvious place for
 * this code is next to the OAuth flow that produces the tokens, and that's where it was. But
 * `activityConnections` is a *provider-generic* table by design — `provider: literals(ACTIVITY_PROVIDERS)`
 * — so the second integration (Garmin, HealthKit, Whoop, …) writes the same rows from its own file,
 * with its own token exchange, and would naturally hand-roll its own copy of this. The rule below is
 * not one a second author would think to look for, because it isn't about OAuth at all.
 *
 * **The rule: a connection may not be written for an account that is being, or has been, deleted.**
 *
 * That sounds like something `requireProfile` should handle, and for every ordinary mutation it does.
 * It cannot handle this one. A connection write is *always* reached from an action holding a bare
 * `userId` rather than a caller identity, because the person is away at the provider's consent screen
 * — or, for a token refresh, because the write happens on the far side of a network round-trip. Two
 * concrete ways that goes wrong, both of which existed before this module:
 *
 * 1. The user starts a connect flow, account finalization begins, and the provider's redirect lands a
 *    second later carrying a valid code. The nonce was minted while the account was healthy.
 * 2. No callback at all: a refresh reads the connection while it exists, the erase stage drains the
 *    table during the token exchange, and the write-back finds nothing to patch and **inserts** a new
 *    row.
 *
 * `activityConnections` gets exactly one erase pass and no later deletion stage rescans it, so either
 * one leaves live OAuth credentials for an account that no longer exists — the single worst row in the
 * app to leak, since it grants continuing access to a *different* service's data.
 *
 * Reading the profile here has a second effect worth knowing: it puts this path under Convex's OCC
 * alongside every other write instead of beside it. A finalization lock committing concurrently now
 * conflicts with this mutation's read set, so the retry sees `deleting`.
 *
 * **If you are adding a provider:** call this, don't reimplement it. If your provider's shape doesn't
 * fit `storeActivityConnection`, call `canConnectAccount` and keep the refusal — the gate is the part
 * that matters, and a `false` return must abort the flow rather than be logged and ignored (see
 * `strava.completeConnect`, which reports it to the user as a failed connect).
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/** Taken from the column rather than re-declared, so a new `ACTIVITY_PROVIDERS` value lands here free. */
type ActivityProvider = Doc<'activityConnections'>['provider'];

/** What a connection write reports back. `stored: false` ⇒ refused, and the caller must not proceed. */
export interface ConnectionWriteResult {
  stored: boolean;
}

/**
 * May this account receive a new or refreshed third-party connection?
 *
 * `false` for a profile that is gone, mid-finalization (`deleting`) or tombstoned (`deleted`). Banned
 * and suspended accounts are deliberately **allowed** here: a moderation state is reversible and its
 * gate belongs at the surfaces a banned user can reach, not on a row they already own. Deletion is the
 * one state that makes the row itself wrong.
 */
export async function canConnectAccount(
  ctx: MutationCtx,
  userId: Id<'profiles'>,
): Promise<boolean> {
  const profile = await ctx.db.get(userId);
  if (profile === null || profile.status === 'deleting' || profile.status === 'deleted') {
    console.warn(
      `activityConnections: refusing a connection write for ${userId} (${
        profile?.status ?? 'no profile'
      })`,
    );
    return false;
  }
  return true;
}

/**
 * Store or replace one provider's connection for a user.
 *
 * Upserts on `(userId, provider)` — a re-connect updates the tokens in place rather than accumulating
 * rows, and `connectedAt` keeps the *original* connection date, since that's what a user reading
 * "connected since" means by it.
 */
export async function storeActivityConnection(
  ctx: MutationCtx,
  args: {
    userId: Id<'profiles'>;
    provider: ActivityProvider;
    externalUserId: string;
    accessToken: string;
    refreshToken: string;
    tokenExpiresAt: number;
    scopes: string[];
  },
): Promise<ConnectionWriteResult> {
  if (!(await canConnectAccount(ctx, args.userId))) return { stored: false };

  const existing = (
    await ctx.db
      .query('activityConnections')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect()
  ).find((c: Doc<'activityConnections'>) => c.provider === args.provider);

  const fields = {
    userId: args.userId,
    provider: args.provider,
    externalUserId: args.externalUserId,
    accessToken: args.accessToken,
    refreshToken: args.refreshToken,
    tokenExpiresAt: args.tokenExpiresAt,
    scopes: args.scopes,
    connectedAt: existing?.connectedAt ?? Date.now(),
  };
  if (existing) await ctx.db.patch(existing._id, fields);
  else await ctx.db.insert('activityConnections', fields);
  return { stored: true };
}
