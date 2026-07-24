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
 *
 * **Reconciliation (2026-07-24 review).** The Convex patch has already committed by the time this runs,
 * so a silent Clerk failure splits the two systems — and the dangerous direction is the *unban*: Convex
 * says active, Clerk still refuses sign-in, and a reinstated user stays locked out with nobody aware.
 * So a failed call is retried with backoff, and a terminal failure pages the operator (D38) with the
 * exact manual fix. Still never throws: rolling back the Convex status — the real gate — would be worse
 * than a lagging Clerk mirror.
 */

import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction } from './_generated/server';

const CLERK_API_BASE = 'https://api.clerk.com/v1';

/** Backoff between retries; its length is also the retry budget (3 tries after the first). */
const RETRY_DELAYS_MS = [30_000, 5 * 60_000, 30 * 60_000];

/**
 * Whether a failed Clerk response is worth retrying. 5xx and rate-limit/timeout responses are transient;
 * any other 4xx (unknown user id, revoked key, malformed request) will fail identically forever, so it
 * escalates to the operator immediately instead of burning 35 minutes of backoff first.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * Ban or unban a Clerk user (idempotent on Clerk's side). `banned: true` blocks sign-in; `false`
 * reverses it. Retries transient failures on a backoff; on a terminal failure sends an operator alert
 * naming the account and the manual Clerk-dashboard fix. Never throws.
 */
export const setBanned = internalAction({
  args: {
    clerkUserId: v.string(),
    banned: v.boolean(),
    /** Retry counter — 0 (absent) on the first, scheduler-driven attempt. */
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, { clerkUserId, banned, attempt = 0 }) => {
    const verb = banned ? 'ban' : 'unban';
    const key = process.env.CLERK_SECRET_KEY;
    if (!key) {
      console.warn(
        `CLERK_SECRET_KEY not set — skipping Clerk ${verb} for ${clerkUserId} (the Convex status gate still applies)`,
      );
      return;
    }

    const endpoint = `${CLERK_API_BASE}/users/${clerkUserId}/${verb}`;
    let failure: string;
    let retryable: boolean;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
      });
      if (res.ok) return;
      failure = `${res.status} ${res.statusText}`;
      retryable = isRetryableStatus(res.status);
    } catch (err) {
      // A thrown fetch is a network/DNS blip — always worth another try.
      failure = err instanceof Error ? err.message : String(err);
      retryable = true;
    }

    const delayMs = RETRY_DELAYS_MS[attempt]; // undefined ⇒ the retry budget is spent
    if (retryable && delayMs !== undefined) {
      console.warn(
        `Clerk ${verb} for ${clerkUserId} failed (${failure}); retry ${attempt + 1}/${RETRY_DELAYS_MS.length}`,
      );
      await ctx.scheduler.runAfter(delayMs, internal.clerkAdmin.setBanned, {
        clerkUserId,
        banned,
        attempt: attempt + 1,
      });
      return;
    }

    // Out of retries (or a permanent error): Convex and Clerk now disagree and only a human can fix it.
    console.error(
      `Clerk ${verb} for ${clerkUserId} gave up after ${attempt + 1} attempt(s): ${failure}`,
    );
    await ctx.scheduler.runAfter(0, internal.operatorAlerts.send, {
      subject: `Clerk ${verb} failed — manual fix needed`,
      heading: `Clerk ${verb} failed for ${clerkUserId}`,
      lines: [
        `Last error: ${failure} (after ${attempt + 1} attempt(s)).`,
        banned
          ? 'Convex has the account BANNED, but Clerk may still issue sign-in sessions. Ban the user in the Clerk dashboard to close the gap. (Every Convex function still rejects them.)'
          : 'Convex has the account ACTIVE, but Clerk may still be blocking sign-in — the user is locked out. Unban the user in the Clerk dashboard to restore access.',
      ],
      deepLinkPath: '/admin/users',
    });
  },
});
