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
import { internalAction, internalQuery } from './_generated/server';

const CLERK_API_BASE = 'https://api.clerk.com/v1';

/** Backoff between retries; its length is also the retry budget (3 tries after the first). */
const RETRY_DELAYS_MS = [30_000, 5 * 60_000, 30 * 60_000];

/** Requests one run of `setBanned` sends at most while Convex's wish moves under it. */
const SETTLE_ROUNDS = 3;

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
  handler: async (ctx, { clerkUserId, banned: scheduled, attempt = 0 }) => {
    const key = process.env.CLERK_SECRET_KEY;
    if (!key) {
      console.warn(
        `CLERK_SECRET_KEY not set — skipping Clerk ${scheduled ? 'ban' : 'unban'} for ${clerkUserId} (the Convex status gate still applies)`,
      );
      return;
    }
    // What Convex says, read before each send and again after each answer. The scheduled value stands
    // only for a person with no profile to read, or one being deleted (its own step deletes the Clerk
    // user).
    const wanted = async () =>
      (await ctx.runQuery(internal.clerkAdmin.lockWanted, { clerkUserId })) ?? scheduled;

    /*
     * **Why this ends where Convex is** (the mirror has no ordering of its own, and these actions
     * overlap: every status write schedules one, and a retry runs later still). Clerk answers a request
     * only after applying it. Take the last request Clerk applies, R, sent by action A. After R's
     * answer A reads Convex again; that read is later than R's application. If Convex then wants what
     * R set, A stops — and Clerk holds what Convex said at a moment after every earlier request was
     * applied. If not, A sends again, and that request is applied after R — so R wasn't the last.
     * Any status change after A's read schedules its own action, whose read and request come after
     * the change, so after R. Hence: once every request has answered and no retry is pending, Clerk's
     * lock equals Convex's status at the last read — whatever the interleaving, a suspension that
     * replaces a ban, an undo and a redo in quick succession, or a retry crossing a newer change (a
     * retry is just another action). A failure is no different: an answer we give up on is followed by
     * the same read, and a changed wish is sent rather than mailed about.
     *
     * Bounded: an action sends at most `SETTLE_ROUNDS` times; a wish still moving after that goes to
     * the retry schedule (its next run reads afresh) and, past its budget, to the operator — never a
     * silent stop. The one gap: an action that dies between an answer and its read (Convex runs an
     * action at most once) leaves the last request's value standing until the next status write; only
     * a reconcile over every account would close that.
     */
    let banned = await wanted();
    let failure = '';
    let retryable = false;
    let settled = false;
    for (let round = 0; round < SETTLE_ROUNDS; round++) {
      const verb = banned ? 'ban' : 'unban';
      let ok = false;
      try {
        const res = await fetch(`${CLERK_API_BASE}/users/${clerkUserId}/${verb}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
        });
        ok = res.ok;
        if (!ok) {
          failure = `${res.status} ${res.statusText}`;
          retryable = isRetryableStatus(res.status);
        }
      } catch (err) {
        // A thrown fetch is a network/DNS blip — always worth another try.
        failure = err instanceof Error ? err.message : String(err);
        retryable = true;
      }
      // After the answer, success or failure: what does Convex want now?
      const now = await wanted();
      if (now !== banned) {
        banned = now;
        continue;
      }
      if (ok) return;
      settled = true;
      break;
    }
    if (!settled) {
      // Still moving after every round: the retry schedule reads afresh at its next run.
      failure = 'the status kept changing while it was sent';
      retryable = true;
    }
    const verb = banned ? 'ban' : 'unban';

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

/**
 * Whether Clerk should lock this person now: a ban locks; any other live status — active, suspended
 * (a suspension never locks Clerk) — unlocks. `null` with no profile, or one on its way out.
 */
export const lockWanted = internalQuery({
  args: { clerkUserId: v.string() },
  handler: async (ctx, { clerkUserId }): Promise<boolean | null> => {
    const profile = await ctx.db
      .query('profiles')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', clerkUserId))
      .first();
    if (!profile || profile.status === 'deleting' || profile.status === 'deleted') return null;
    return profile.status === 'banned';
  },
});

/**
 * Delete a Clerk user — the last step of account deletion (D33/D62), fired once the Convex tombstone
 * is written.
 *
 * Same posture as `setBanned` above and for the same reason: the Convex row is the security boundary,
 * `requireProfile` already rejects `status: 'deleted'`, and rolling back a deletion the user explicitly
 * asked for because a third-party API blipped would be far worse than a lagging Clerk mirror. So it
 * retries, then pages a human, and never throws.
 *
 * **A 404 is success, not failure.** Clerk returns it when the user is already gone — which happens on
 * a retry that actually landed, and when someone deletes themselves from Clerk's own UI first. Treating
 * it as terminal would page the operator every time the job worked.
 */
export const deleteUser = internalAction({
  args: {
    clerkUserId: v.string(),
    /** Retry counter — 0 (absent) on the first, scheduler-driven attempt. */
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, { clerkUserId, attempt = 0 }) => {
    const key = process.env.CLERK_SECRET_KEY;
    if (!key) {
      console.warn(
        `CLERK_SECRET_KEY not set — skipping Clerk delete for ${clerkUserId} (the Convex tombstone is written and every function rejects them)`,
      );
      return;
    }

    let failure: string;
    let retryable: boolean;
    try {
      const res = await fetch(`${CLERK_API_BASE}/users/${clerkUserId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${key}` },
      });
      if (res.ok || res.status === 404) return;
      failure = `${res.status} ${res.statusText}`;
      retryable = isRetryableStatus(res.status);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      retryable = true;
    }

    const delayMs = RETRY_DELAYS_MS[attempt];
    if (retryable && delayMs !== undefined) {
      console.warn(
        `Clerk delete for ${clerkUserId} failed (${failure}); retry ${attempt + 1}/${RETRY_DELAYS_MS.length}`,
      );
      await ctx.scheduler.runAfter(delayMs, internal.clerkAdmin.deleteUser, {
        clerkUserId,
        attempt: attempt + 1,
      });
      return;
    }

    console.error(
      `Clerk delete for ${clerkUserId} gave up after ${attempt + 1} attempt(s): ${failure}`,
    );
    await ctx.scheduler.runAfter(0, internal.operatorAlerts.send, {
      subject: 'Clerk delete failed — manual fix needed',
      heading: `Clerk delete failed for ${clerkUserId}`,
      lines: [
        `Last error: ${failure} (after ${attempt + 1} attempt(s)).`,
        'The Convex profile is already a tombstone — their content is anonymized and every function rejects them, so this is not a data-exposure gap. What remains is a Clerk auth user that should not exist: delete it in the Clerk dashboard to complete the request.',
      ],
      deepLinkPath: '/admin/users',
    });
  },
});
