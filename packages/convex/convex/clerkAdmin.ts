/**
 * Clerk account lock (D37 — "belt + suspenders"). The security boundary is the Convex function (every
 * function re-checks `status` via `requireProfile`), so this is defense-in-depth: locking the Clerk
 * user stops *new* session issuance for a banned account. Called fire-and-forget from the ban/unban
 * mutations via the scheduler (a mutation can't `fetch`).
 *
 * Scope (founder decision, 2026-07-23): **permanent bans only** touch Clerk. Temporary suspensions are
 * enforced purely by the Convex gate (`requireProfile` rejects while `suspendedUntil > now` and
 * auto-lifts with no cron) — Clerk-banning on suspend would leave a user locked out of sign-in after
 * their suspension naturally expired.
 *
 * No-ops (logs) when `CLERK_SECRET_KEY` is absent, so tests and un-provisioned deploys never break on a
 * missing secret — same posture as the ORS/Resend keys.
 */

import { v } from 'convex/values';
import { internalAction } from './_generated/server';

const CLERK_API_BASE = 'https://api.clerk.com/v1';

/**
 * Ban or unban a Clerk user (idempotent on Clerk's side). `banned: true` blocks sign-in; `false`
 * reverses it. Best-effort — a failed call is logged, never thrown, so it can't roll back the Convex
 * status change that already committed (that patch is the real gate).
 */
export const setBanned = internalAction({
  args: { clerkUserId: v.string(), banned: v.boolean() },
  handler: async (_ctx, { clerkUserId, banned }) => {
    const key = process.env.CLERK_SECRET_KEY;
    if (!key) {
      console.warn(
        `CLERK_SECRET_KEY not set — skipping Clerk ${banned ? 'ban' : 'unban'} for ${clerkUserId} (the Convex status gate still applies)`,
      );
      return;
    }
    const endpoint = `${CLERK_API_BASE}/users/${clerkUserId}/${banned ? 'ban' : 'unban'}`;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) {
        console.warn(`Clerk ${banned ? 'ban' : 'unban'} failed: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      console.warn(`Clerk ${banned ? 'ban' : 'unban'} threw`, err);
    }
  },
});
