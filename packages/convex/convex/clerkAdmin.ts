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
import type { Doc } from './_generated/dataModel';
import { type ActionCtx, internalAction, internalQuery } from './_generated/server';

const CLERK_API_BASE = 'https://api.clerk.com/v1';

/** Backoff between retries; its length is also the retry budget (3 tries after the first). */
const RETRY_DELAYS_MS = [30_000, 5 * 60_000, 30 * 60_000];

/** Requests one run of `setBanned` sends at most while Convex's wish moves under it. */
export const SETTLE_ROUNDS = 3;

/**
 * How long one Clerk request may take. Without it a hung request holds the run until Convex's action
 * limit kills it — no retry, no alert, a silent stop; with it, it is a thrown fetch, and retried.
 */
export const CLERK_TIMEOUT_MS = 20_000;

/**
 * Whether a failed Clerk response is worth retrying. 5xx and rate-limit/timeout responses are transient;
 * any other 4xx (unknown user id, revoked key, malformed request) will fail identically forever, so it
 * escalates to the operator immediately instead of burning 35 minutes of backoff first.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * One Clerk request's answer: applied (a read's parsed body with it), or why not and whether another
 * try could help.
 */
export type ClerkAnswer =
  | { ok: true; status: number; body?: unknown }
  | { ok: false; failure: string; retryable: boolean };

/**
 * **One request to Clerk**, every caller's: held to {@link CLERK_TIMEOUT_MS}, so a hung request is a
 * thrown fetch (retried) rather than a run Convex's action limit kills silently; `accept` says which
 * statuses count as done besides a 2xx (a delete's 404). A `GET` (the reconcile's reads, B01-4k)
 * answers with its parsed JSON body, read under the same timeout.
 */
export async function clerkRequest(
  key: string,
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  accept: (status: number) => boolean = () => false,
): Promise<ClerkAnswer> {
  try {
    const res = await fetch(`${CLERK_API_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(CLERK_TIMEOUT_MS),
    });
    if (res.ok || accept(res.status)) {
      if (method !== 'GET') return { ok: true, status: res.status };
      return { ok: true, status: res.status, body: await res.json() };
    }
    return {
      ok: false,
      failure: `${res.status} ${res.statusText}`,
      retryable: isRetryableStatus(res.status),
    };
  } catch (err) {
    // A thrown fetch is a network/DNS blip or a timeout (or a read's body cut off) — always worth
    // another try.
    return {
      ok: false,
      failure: err instanceof Error ? err.message : String(err),
      retryable: true,
    };
  }
}

/**
 * **A Clerk failure's next step**, every caller's: the retry schedule ({@link RETRY_DELAYS_MS}) while
 * it is transient and the budget lasts — `retry` schedules the next run with `attempt + 1` — and
 * otherwise the operator, paged with the manual fix (D38). Never a silent stop, and never a throw.
 * Says which it did.
 */
export async function retryOrPage(
  ctx: ActionCtx,
  {
    what,
    subject,
    attempt,
    failure,
    retryable,
    retry,
    fix,
  }: {
    /** The verb, as the log and the page name it: `ban`, `unban`, `delete`, `reconcile`. */
    what: string;
    /** What it was for, as the log and the page name it: the Clerk user id, or the job. */
    subject: string;
    attempt: number;
    failure: string;
    retryable: boolean;
    retry: (delayMs: number, attempt: number) => Promise<unknown>;
    /** What the operator is told to do, after the last error. */
    fix: string;
  },
): Promise<'retried' | 'paged'> {
  const delayMs = RETRY_DELAYS_MS[attempt]; // undefined ⇒ the retry budget is spent
  if (retryable && delayMs !== undefined) {
    console.warn(
      `Clerk ${what} for ${subject} failed (${failure}); retry ${attempt + 1}/${RETRY_DELAYS_MS.length}`,
    );
    await retry(delayMs, attempt + 1);
    return 'retried';
  }
  // Out of retries (or a permanent error): Convex and Clerk now disagree and only a human can fix it.
  console.error(`Clerk ${what} for ${subject} gave up after ${attempt + 1} attempt(s): ${failure}`);
  await ctx.scheduler.runAfter(0, internal.operatorAlerts.send, {
    subject: `Clerk ${what} failed — manual fix needed`,
    heading: `Clerk ${what} failed for ${subject}`,
    lines: [`Last error: ${failure} (after ${attempt + 1} attempt(s)).`, fix],
    deepLinkPath: '/admin/users',
  });
  return 'paged';
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
    /**
     * A repair the daily reconcile asked for (`clerkReconcile`, B01-4k), carried by its retries: with
     * no profile to read, the run stops instead of sending the scheduled value — the reconcile leaves
     * a Clerk user with no profile alone.
     */
    repair: v.optional(v.boolean()),
  },
  handler: async (ctx, { clerkUserId, banned: scheduled, attempt = 0, repair }) => {
    const key = process.env.CLERK_SECRET_KEY;
    if (!key) {
      console.warn(
        `CLERK_SECRET_KEY not set — skipping Clerk ${scheduled ? 'ban' : 'unban'} for ${clerkUserId} (the Convex status gate still applies)`,
      );
      return;
    }
    // What Convex says, read before each send and again after each answer. With no profile to read,
    // the wish stands where it was — the scheduled value at first. A person being deleted, or
    // deleted, is no one's to lock: account deletion deletes the Clerk user itself, so the run stops
    // (never a ban sent to a deleted Clerk user, nor a page about one). A repair with no profile
    // stops the same way: the reconcile asked about someone Convex has no word on.
    const wanted = async (fallback: boolean) => {
      const read = await ctx.runQuery(internal.clerkAdmin.lockWanted, { clerkUserId });
      if (read === null && repair) return 'gone';
      return read === 'gone' ? read : (read ?? fallback);
    };

    /*
     * **Why this ends where Convex is** (the mirror has no ordering of its own, and these actions
     * overlap: every status write schedules one, and a retry runs later still). Clerk answers a request
     * only after applying it. Take the last request Clerk applies, R, sent by action A. After R's
     * answer A reads Convex again; that read is later than R's application. If Convex then wants what
     * R set, A stops — and Clerk holds what Convex said at a moment after every earlier request was
     * applied. If not, A sends again — or, out of rounds, its retry does — and that request is applied
     * after R, so R wasn't the last. Any change of the wish after A's read schedules its own action,
     * whose read and request come after the change, so after R. Hence: once every request has answered,
     * no retry is pending and no run has handed off to the operator, Clerk's lock equals Convex's
     * status at the last read — whatever the interleaving, a suspension that replaces a ban, an undo
     * and a redo in quick succession, or a retry crossing a newer change (a retry is just another
     * action). A failure is no different: an answer we give up on is followed by the same read, and a
     * changed wish is sent rather than mailed about.
     *
     * Bounded: an action sends at most `SETTLE_ROUNDS` times, each held to `CLERK_TIMEOUT_MS`; a wish
     * still moving after that goes to the retry schedule (its next run reads afresh) and, past its
     * budget, to the operator — never a silent stop. The gaps: an action that dies between an answer
     * and its read (Convex runs an action at most once), and a request whose answer is lost (a timeout
     * included) but which Clerk applies after the retry that follows it, leave the last applied value
     * standing until the next status write — or until the daily reconcile (`clerkReconcile`, B01-4k)
     * finds it and asks for a run of this action, which, being just another run, converges the same way.
     */
    const first = await wanted(scheduled);
    if (first === 'gone') return;
    let banned = first;
    let failure = '';
    let retryable = false;
    for (let round = 1; ; round++) {
      const verb = banned ? 'ban' : 'unban';
      const answer = await clerkRequest(key, `/users/${clerkUserId}/${verb}`, 'POST');
      if (!answer.ok) ({ failure, retryable } = answer);
      // After the answer, success or failure: what does Convex want now?
      const now = await wanted(banned);
      if (now === 'gone') return;
      if (now === banned) {
        if (answer.ok) return;
        break; // a failure Convex still stands behind: the retry schedule, or the operator
      }
      banned = now;
      if (round === SETTLE_ROUNDS) {
        // Still moving after every round: the retry schedule reads afresh at its next run.
        failure = 'the status kept changing while it was sent';
        retryable = true;
        break;
      }
    }
    await retryOrPage(ctx, {
      what: banned ? 'ban' : 'unban',
      subject: clerkUserId,
      attempt,
      failure,
      retryable,
      retry: (delayMs, next) =>
        ctx.scheduler.runAfter(delayMs, internal.clerkAdmin.setBanned, {
          clerkUserId,
          banned,
          attempt: next,
          ...(repair ? { repair } : {}),
        }),
      fix: banned
        ? 'Convex has the account BANNED, but Clerk may still issue sign-in sessions. Ban the user in the Clerk dashboard to close the gap. (Every Convex function still rejects them.)'
        : 'Convex has the account ACTIVE, but Clerk may still be blocking sign-in — the user is locked out. Unban the user in the Clerk dashboard to restore access.',
    });
  },
});

/**
 * Whether Clerk should lock this person now: a ban locks; any other live status — active, suspended
 * (a suspension never locks Clerk) — unlocks. `'gone'` for one being deleted or deleted (account
 * deletion deletes their Clerk user); `null` with no profile.
 */
export const lockWanted = internalQuery({
  args: { clerkUserId: v.string() },
  handler: async (ctx, { clerkUserId }): Promise<LockWish> =>
    lockWish(
      await ctx.db
        .query('profiles')
        .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', clerkUserId))
        .first(),
    ),
});

/** What Clerk's lock should be for one person: see {@link lockWanted}. */
export type LockWish = boolean | 'gone' | null;

/** The rule {@link lockWanted} and the reconcile both read a profile by. */
export function lockWish(profile: Pick<Doc<'profiles'>, 'status'> | null): LockWish {
  if (!profile) return null;
  if (profile.status === 'deleting' || profile.status === 'deleted') return 'gone';
  return profile.status === 'banned';
}

/**
 * Delete a Clerk user — the last step of account deletion (D33/D62), fired once the Convex tombstone
 * is written.
 *
 * Same posture as `setBanned` above and for the same reason: the Convex row is the security boundary,
 * `requireProfile` already rejects `status: 'deleted'`, and rolling back a deletion the user explicitly
 * asked for because a third-party API blipped would be far worse than a lagging Clerk mirror. So it
 * takes the same path (B01-4h): one request held to {@link CLERK_TIMEOUT_MS} (`clerkRequest`), then the
 * retry schedule, then a page to a human (`retryOrPage`) — and never throws. One-way, so it needs no
 * settling: whatever order its runs land in, the user ends deleted.
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

    // A 404 is the user already gone: done (a retry that landed, or a deletion from Clerk's own UI).
    const answer = await clerkRequest(key, `/users/${clerkUserId}`, 'DELETE', (s) => s === 404);
    if (answer.ok) return;
    await retryOrPage(ctx, {
      what: 'delete',
      subject: clerkUserId,
      attempt,
      failure: answer.failure,
      retryable: answer.retryable,
      retry: (delayMs, next) =>
        ctx.scheduler.runAfter(delayMs, internal.clerkAdmin.deleteUser, {
          clerkUserId,
          attempt: next,
        }),
      fix: 'The Convex profile is already a tombstone — their content is anonymized and every function rejects them, so this is not a data-exposure gap. What remains is a Clerk auth user that should not exist: delete it in the Clerk dashboard to complete the request.',
    });
  },
});
