/**
 * Push-token registration (A08 PR 3). A device that has granted notification permission calls
 * `register` on app open with its `ExponentPushToken[…]`; the row is the address `notificationDelivery`
 * sends to. Owner-scoped: a token is a private capability to ring one person's phone, and the only
 * thing anyone can do with someone else's is nothing.
 *
 * A token can move between accounts (sign out, sign in as someone else on the same phone), so
 * `register` re-homes an existing row rather than refusing it — the phone belongs to whoever is
 * signed in now, and leaving the old owner's row would ring the wrong person.
 */

import { ConvexError, v } from 'convex/values';
import { mutation } from './_generated/server';
import { requireProfile } from './lib/auth';
import { isExpoPushToken } from './lib/expoPush';
import { literals } from './lib/validators';

export const register = mutation({
  args: {
    token: v.string(),
    platform: literals(['ios', 'android']),
    deviceName: v.optional(v.string()),
  },
  handler: async (ctx, { token, platform, deviceName }) => {
    // `requireProfile`, not `requireContributor`: a person mid-deletion keeps their device registered
    // until finalize drains the rows — `canReceiveNotifications` already silences them upstream, and
    // refusing here would just leave a stale row behind if they cancel.
    const profile = await requireProfile(ctx);
    if (!isExpoPushToken(token)) throw new ConvexError('Not an Expo push token');
    const now = Date.now();
    const existing = await ctx.db
      .query('pushTokens')
      .withIndex('by_token', (q) => q.eq('token', token))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        userId: profile._id,
        platform,
        ...(deviceName !== undefined ? { deviceName } : {}),
        lastSeenAt: now,
        // A re-register is the device saying it's alive again: a token Expo once reported dead can
        // come back (reinstall keeps it on some Androids), and the app asking is the proof.
        disabledAt: undefined,
      });
      return existing._id;
    }
    return ctx.db.insert('pushTokens', {
      userId: profile._id,
      token,
      platform,
      ...(deviceName !== undefined ? { deviceName } : {}),
      createdAt: now,
      lastSeenAt: now,
    });
  },
});

/** The device-level off switch: "no push on this phone", leaving the account's other devices alone. */
export const unregister = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const profile = await requireProfile(ctx);
    const existing = await ctx.db
      .query('pushTokens')
      .withIndex('by_token', (q) => q.eq('token', token))
      .unique();
    if (existing && existing.userId === profile._id) await ctx.db.delete(existing._id);
  },
});

/**
 * Sign-out's version of `unregister`, deliberately **unauthenticated**: the token is the credential.
 *
 * A signed-out phone must stop ringing for the account that left, and the two things `unregister`
 * needs are exactly what sign-out takes away. The session: a Convex mutation issued offline is
 * *queued*, and once Clerk's sign-out has run it would arrive with no identity and fail
 * `requireProfile`. And a live network — the device has no reason to still be online when it
 * retries at the next launch, signed in as nobody. So this asks for neither.
 *
 * What holding a token lets a stranger do here is make one phone stop receiving pushes — the same
 * thing the phone's own settings screen does, and nothing that reads or reveals anything. The token
 * is a 22-character Expo-minted opaque id that only the device, Expo and this table ever see; it is
 * not derivable from a user, and Expo's own send API needs our access token besides. That is a
 * far smaller capability than the authenticated `register` hands out (re-homing the row), which is
 * why `register` stays owner-scoped and this doesn't.
 */
export const release = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    if (!isExpoPushToken(token)) return;
    const existing = await ctx.db
      .query('pushTokens')
      .withIndex('by_token', (q) => q.eq('token', token))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});
