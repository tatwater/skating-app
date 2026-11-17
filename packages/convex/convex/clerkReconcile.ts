/**
 * **Clerk's ban lock, checked against Convex once a day** (B01-4k, D277).
 *
 * Convex is the authority on a person's status, and every Convex function refuses a banned person
 * whatever Clerk says; Clerk's lock (`clerkAdmin.setBanned`) only stops new sign-ins. Every sync reads
 * Convex before each request and after each answer, so overlapping syncs converge — except in two
 * cases nothing notices until that person's status next changes: a run that dies between Clerk's
 * answer and its re-read (Convex runs an action at most once), and a request whose answer is lost but
 * which Clerk applies after the retry that followed it. Either leaves Clerk on a stale value; the
 * harmful direction is a person whose ban was lifted still locked out of sign-in, with no alert.
 *
 * **What it checks, with no mirror state stored** (no schema change):
 *
 * 1. Every profile Convex says is banned (`profiles.by_status`, paged with a cursor, by weight) must
 *    be locked in Clerk: each page's Clerk users are read in one request by id.
 * 2. Every Clerk user Clerk says is banned (Clerk's own list, filtered and paged with its cursor) must
 *    be banned in Convex: one whose profile says active or suspended is unlocked; one being deleted,
 *    or deleted, is left alone (account deletion deletes their Clerk user); a Clerk user with no
 *    profile is left alone. Each is counted.
 *
 * **A repair is never a second way to call Clerk.** It asks for a run of `setBanned` (`repair: true`),
 * the one sender with the one retry path, and that run reads what Convex wants before it sends and
 * after every answer. So a reconcile that read a stale value — Convex's page before a lift, or Clerk's
 * lock before a sync in flight landed — can only ask for a run, and the run sends what Convex says
 * then: it cannot undo a newer change. `setBanned` is just another overlapping run, and its argument
 * (`clerkAdmin.ts`, *Why this ends where Convex is*) holds for any number of them. A repair with no
 * profile stops rather than sending, so the reconcile never locks or unlocks a Clerk user Convex has
 * no word on.
 *
 * **Not an audit event** (D270): a repair changes no one's terms — their status did not change, only
 * the mirror caught up — so it writes no audit row and offers no undo.
 *
 * **What it reports — counts only, never a name, email or id.** Each run ends with one log line of its
 * counts; each lock it repaired is a `jobFailures` row (`clerkMirror`, `LockRepaired` /
 * `UnlockRepaired`, keyed by the run and a sequence number), which the Machinery health read counts,
 * for a week; a run that repaired anything mails the operator one summary (a repair means one of the
 * two gaps actually happened). A run that could not finish is a row keyed `run` until one does.
 *
 * **Bounded and polite.** Clerk's Backend API allows 1,000 requests per 10 s on a production instance
 * and 100 on a development one, `GET`s included, per secret key, and answers past it with a 429
 * (https://clerk.com/docs/guides/how-clerk-works/system-limits). A step makes at most
 * {@link READS_PER_STEP} sequential reads, each held to the shared 20 s timeout, and continues itself
 * {@link STEP_GAP_MS} later; repairs are spaced {@link REPAIR_SPACING_MS} apart from the run's start;
 * a run reads at most {@link MAX_READS_PER_RUN} pages and repairs at most {@link MAX_REPAIRS_PER_RUN}.
 * A failed read (a 429 included) takes `setBanned`'s own path — the 30 s, 5 min, 30 min schedule, each
 * retry resuming from the same cursor, then the operator. Idempotent: a second pass over the same
 * state repairs nothing.
 *
 * **Dry run** (`dryRun: true`): every read, no repair asked for and no row or mail written — its
 * counts say what it would repair.
 */

import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { type ClerkAnswer, clerkRequest, type LockWish, lockWish, retryOrPage } from './clerkAdmin';
import { DOC_MAX, ReadBudget } from './lib/readBudget';
import { clearFailure, forgetFailuresBefore, recordFailure } from './lib/recurringWork';
import { literals } from './lib/validators';

const DAY = 24 * 60 * 60_000;

/**
 * Clerk users one read asks for — by id on the Convex side (`user_id` accepts up to 100), and one page
 * of the banned list (`limit` is 1–500, default 10: always sent).
 */
export const CLERK_PAGE = 100;
/** Banned profiles one Convex page holds, at most — and at most {@link CONVEX_PAGE_BYTES} of them. */
export const CONVEX_PAGE = CLERK_PAGE;
/** A profile can weigh up to the document limit (its cached drive-time polygons). */
const CONVEX_PAGE_BYTES = 8 * DOC_MAX;
/** Clerk reads one step makes, one after another, before it continues itself. */
export const READS_PER_STEP = 5;
/** Convex pages one step reads, at most (a page with no one on it costs no Clerk read). */
const CONVEX_PAGES_PER_STEP = 20;
/** The pause between steps. */
export const STEP_GAP_MS = 2_000;
/** Clerk reads one run makes, at most — 20,000 accounts a side; past it the run stops, counted. */
export const MAX_READS_PER_RUN = 400;
/** Repairs one run asks for, at most; past it the rest are counted and left for the next run. */
export const MAX_REPAIRS_PER_RUN = 200;
/** The gap between repairs, from the run's start: at most two `setBanned` runs a second. */
export const REPAIR_SPACING_MS = 500;
/** How long a repair stays counted on the Machinery read. */
export const REPAIR_RETENTION_MS = 7 * DAY;
/** The `jobFailures` key of a run that could not finish (never a person). */
export const RUN_KEY = 'run';
/** Rows of a week ago one run forgets, at most (a backlog clears over the next runs). */
const FORGET_CAP = 500;

const SIDES = ['convex', 'clerk'] as const;
type Side = (typeof SIDES)[number];

/** What a run found, counted — never a name, email or id. */
const tallyValidator = v.object({
  /** Profiles Convex says are banned, checked against Clerk. */
  convexChecked: v.number(),
  /** Clerk users Clerk says are banned, checked against Convex. */
  clerkChecked: v.number(),
  /** Banned in Convex, not locked in Clerk: a lock asked for (or, dry, that would be). */
  lockRepairs: v.number(),
  /** Locked in Clerk, active or suspended in Convex: an unlock asked for (or would be). */
  unlockRepairs: v.number(),
  /** Banned in Convex, no such Clerk user: left alone. */
  notInClerk: v.number(),
  /** Locked in Clerk, no profile: left alone. */
  noProfile: v.number(),
  /** Locked in Clerk, being deleted or deleted in Convex: left alone. */
  beingDeleted: v.number(),
  /** Out of step past {@link MAX_REPAIRS_PER_RUN}: left for the next run. */
  overCap: v.number(),
  /** Requests sent to Clerk (every read, a retried one included). */
  clerkReads: v.number(),
});
export type Tally = typeof tallyValidator.type;

export const EMPTY_TALLY: Tally = {
  convexChecked: 0,
  clerkChecked: 0,
  lockRepairs: 0,
  unlockRepairs: 0,
  notInClerk: 0,
  noProfile: 0,
  beingDeleted: 0,
  overCap: 0,
  clerkReads: 0,
};

/** How a step ended: the run finished (or stopped at its cap), continued, retried or gave up. */
export type RunState = 'skipped' | 'done' | 'capped' | 'continued' | 'retrying' | 'stopped';
export interface RunOutcome {
  dryRun: boolean;
  state: RunState;
  tally: Tally;
}

/** The Clerk users one read answered with: their id and whether Clerk locks them. */
type UsersAnswer =
  | { ok: true; users: { id: string; banned: boolean }[] }
  | Exclude<ClerkAnswer, { ok: true }>;

/**
 * One read of Clerk's users (`GET /v1/users`, operationId `GetUserList` in Clerk's Backend API spec,
 * https://github.com/clerk/openapi-specs `bapi/2026-08-20.yml`, the same in every published version
 * back to 2021-02-05): `user_id` (repeated, up to 100) or `banned=true`; `limit`; `starting_after`, the
 * id of the last user of the previous page — the cursor, which needs the default `created_at` order
 * and every other parameter the same, and ends when a page returns fewer than `limit`. The answer is
 * an array of User objects; only `id` and `banned` are read.
 */
async function readUsers(key: string, query: string): Promise<UsersAnswer> {
  const answer = await clerkRequest(key, `/users?${query}`, 'GET');
  if (!answer.ok) return answer;
  if (!Array.isArray(answer.body)) {
    return { ok: false, failure: 'an answer that was not a list of users', retryable: false };
  }
  const users = answer.body.flatMap((u: unknown) => {
    if (typeof u !== 'object' || u === null) return [];
    const { id, banned } = u as { id?: unknown; banned?: unknown };
    return typeof id === 'string' ? [{ id, banned: banned === true }] : [];
  });
  return { ok: true, users };
}

/**
 * **One step of the daily reconcile** — the cron's tick starts a run (`{}`); each step continues it.
 * Never throws on a Clerk failure (the retry schedule, then the operator); a Convex failure stops the
 * chain with its position in the log, and the next day's tick starts afresh.
 */
export const run = internalAction({
  args: {
    dryRun: v.optional(v.boolean()),
    /** The run's start — set by its first step, carried by the rest. */
    runId: v.optional(v.number()),
    side: v.optional(literals(SIDES)),
    /** The side's cursor: a Convex page cursor, or the last Clerk user id read. */
    cursor: v.optional(v.union(v.string(), v.null())),
    /** Retry counter of the read that failed — 0 (absent) otherwise. */
    attempt: v.optional(v.number()),
    tally: v.optional(tallyValidator),
  },
  handler: async (ctx, args): Promise<RunOutcome> => {
    const dryRun = args.dryRun === true;
    const tally: Tally = { ...EMPTY_TALLY, ...args.tally };
    const key = process.env.CLERK_SECRET_KEY;
    if (!key) {
      console.warn(
        'CLERK_SECRET_KEY not set — skipping the Clerk ban-lock reconcile (the Convex status gate still applies)',
      );
      return { dryRun, state: 'skipped', tally };
    }
    const runId = args.runId ?? Date.now();
    let side: Side = args.side ?? 'convex';
    let cursor = args.cursor ?? null;
    let attempt = args.attempt ?? 0;

    /** Out-of-step locks, asked of `setBanned` (spaced from the run's start) or, dry, only counted. */
    const nominate = async (clerkUserIds: string[], banned: boolean) => {
      if (clerkUserIds.length === 0) return;
      const asked = tally.lockRepairs + tally.unlockRepairs;
      const take = clerkUserIds.slice(0, Math.max(0, MAX_REPAIRS_PER_RUN - asked));
      tally.overCap += clerkUserIds.length - take.length;
      if (take.length === 0) return;
      if (!dryRun) {
        await ctx.runMutation(internal.clerkReconcile.repair, {
          runId,
          seq: asked,
          items: take.map((clerkUserId) => ({ clerkUserId, banned })),
        });
      }
      if (banned) tally.lockRepairs += take.length;
      else tally.unlockRepairs += take.length;
    };

    /** A read that failed: `setBanned`'s path — retried from this same position, then the operator. */
    const fail = async (answer: Exclude<ClerkAnswer, { ok: true }>): Promise<RunOutcome> => {
      const next = await retryOrPage(ctx, {
        what: 'reconcile',
        subject: 'the daily ban-lock check',
        attempt,
        failure: answer.failure,
        retryable: answer.retryable,
        retry: (delayMs, nextAttempt) =>
          ctx.scheduler.runAfter(delayMs, internal.clerkReconcile.run, {
            dryRun,
            runId,
            side,
            cursor,
            attempt: nextAttempt,
            tally,
          }),
        fix: 'The daily check of Clerk sign-in locks against Convex stopped before it finished. Its failure changed nothing, and it runs again tomorrow. If it keeps failing, check that CLERK_SECRET_KEY is valid and that Clerk is up.',
      });
      if (next === 'paged' && !dryRun) {
        await ctx.runMutation(internal.clerkReconcile.recordUnfinished, {});
      }
      return { dryRun, state: next === 'retried' ? 'retrying' : 'stopped', tally };
    };

    const finish = async (state: 'done' | 'capped'): Promise<RunOutcome> => {
      // Counts only: the tally holds no name, email or id.
      console.log(
        `Clerk ban-lock reconcile${dryRun ? ' (dry run)' : ''} ${state}: ${JSON.stringify(tally)}`,
      );
      if (!dryRun) await ctx.runMutation(internal.clerkReconcile.finishRun, { state, tally });
      return { dryRun, state, tally };
    };

    let reads = 0;
    let convexPages = 0;
    while (reads < READS_PER_STEP && convexPages < CONVEX_PAGES_PER_STEP) {
      if (tally.clerkReads >= MAX_READS_PER_RUN) return await finish('capped');
      if (side === 'convex') {
        convexPages++;
        const page = await ctx.runQuery(internal.clerkReconcile.bannedPage, { cursor });
        if (page.clerkUserIds.length > 0) {
          reads++;
          tally.clerkReads++;
          const query = [
            ...page.clerkUserIds.map((id) => `user_id=${encodeURIComponent(id)}`),
            `limit=${CLERK_PAGE}`,
          ].join('&');
          const answer = await readUsers(key, query);
          if (!answer.ok) return await fail(answer);
          attempt = 0;
          const locked = new Map(answer.users.map((u) => [u.id, u.banned]));
          const toLock: string[] = [];
          for (const id of page.clerkUserIds) {
            tally.convexChecked++;
            const isLocked = locked.get(id);
            if (isLocked === undefined) tally.notInClerk++;
            else if (!isLocked) toLock.push(id);
          }
          await nominate(toLock, true);
        }
        if (page.isDone) {
          side = 'clerk';
          cursor = null;
        } else {
          cursor = page.continueCursor;
        }
      } else {
        reads++;
        tally.clerkReads++;
        const after = cursor === null ? '' : `&starting_after=${encodeURIComponent(cursor)}`;
        const answer = await readUsers(key, `banned=true&limit=${CLERK_PAGE}${after}`);
        if (!answer.ok) return await fail(answer);
        attempt = 0;
        // Clerk's filter, read again from each user: one it no longer locks needs nothing.
        const ids = answer.users.filter((u) => u.banned).map((u) => u.id);
        const wishes = await wishesFor(ids, (remaining) =>
          ctx.runQuery(internal.clerkReconcile.lockWishes, { clerkUserIds: remaining }),
        );
        const toUnlock: string[] = [];
        ids.forEach((id, i) => {
          tally.clerkChecked++;
          const wish = wishes[i];
          if (wish === null) tally.noProfile++;
          else if (wish === 'gone') tally.beingDeleted++;
          else if (wish === false) toUnlock.push(id);
        });
        await nominate(toUnlock, false);
        const last = answer.users.at(-1);
        if (answer.users.length < CLERK_PAGE || last === undefined) return await finish('done');
        cursor = last.id;
      }
    }
    await ctx.scheduler.runAfter(STEP_GAP_MS, internal.clerkReconcile.run, {
      dryRun,
      runId,
      side,
      cursor,
      tally,
    });
    return { dryRun, state: 'continued', tally };
  },
});

/**
 * Every id's lock wish, asked a query at a time until all are answered (each answers what its read
 * budget affords).
 */
async function wishesFor(
  ids: string[],
  ask: (remaining: string[]) => Promise<LockWish[]>,
): Promise<LockWish[]> {
  const out: LockWish[] = [];
  while (out.length < ids.length) {
    const got = await ask(ids.slice(out.length));
    if (got.length === 0) throw new Error('clerkReconcile: a lock-wish read answered nothing');
    out.push(...got);
  }
  return out;
}

/**
 * A page of the profiles Convex says are banned: their Clerk user ids, at most {@link CONVEX_PAGE} and
 * at most {@link CONVEX_PAGE_BYTES} of them as they really weigh.
 */
export const bannedPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const budget = new ReadBudget();
    const page = await budget.capped(CONVEX_PAGE_BYTES, CONVEX_PAGE, () =>
      ctx.db
        .query('profiles')
        .withIndex('by_status', (q) => q.eq('status', 'banned'))
        .paginate({ cursor, numItems: CONVEX_PAGE, maximumBytesRead: CONVEX_PAGE_BYTES }),
    );
    return {
      clerkUserIds: page.page.map((p) => p.clerkUserId),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * What Clerk's lock should be for each Clerk user, by `lockWanted`'s rule — answered in order, as many
 * as one transaction's read budget affords (each profile read as it really weighs); the caller asks
 * again for the rest.
 */
export const lockWishes = internalQuery({
  args: { clerkUserIds: v.array(v.string()) },
  handler: async (ctx, { clerkUserIds }): Promise<LockWish[]> => {
    const budget = new ReadBudget();
    const out: LockWish[] = [];
    for (const clerkUserId of clerkUserIds.slice(0, CLERK_PAGE)) {
      const read = await budget.measured('profile', () =>
        ctx.db
          .query('profiles')
          .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', clerkUserId))
          .first(),
      );
      if (read === undefined) break; // out of budget: the caller asks again from here
      out.push(lockWish(read));
    }
    return out;
  },
});

/**
 * Repairs, asked of the one sender: a `setBanned` run each (`repair: true`), spaced from the run's start,
 * and a `jobFailures` row each — keyed by the run and its sequence number, never the person — in the
 * same transaction, so a row is counted exactly when a repair was asked for.
 */
export const repair = internalMutation({
  args: {
    runId: v.number(),
    seq: v.number(),
    items: v.array(v.object({ clerkUserId: v.string(), banned: v.boolean() })),
  },
  handler: async (ctx, { runId, seq, items }) => {
    const now = Date.now();
    for (const [i, { clerkUserId, banned }] of items.entries()) {
      const at = runId + (seq + i) * REPAIR_SPACING_MS;
      await ctx.scheduler.runAfter(Math.max(0, at - now), internal.clerkAdmin.setBanned, {
        clerkUserId,
        banned,
        repair: true,
      });
      await recordFailure(
        ctx,
        'clerkMirror',
        `${runId}.${seq + i}`,
        banned ? 'LockRepaired' : 'UnlockRepaired',
        now,
        { park: false },
      );
    }
  },
});

/** A run that gave up on Clerk: counted under {@link RUN_KEY} until a run finishes. */
export const recordUnfinished = internalMutation({
  args: {},
  handler: async (ctx) => {
    await recordFailure(ctx, 'clerkMirror', RUN_KEY, 'Unfinished', Date.now(), { park: false });
  },
});

/**
 * A run's end: the run row cleared when it finished whole (or kept, naming why not), repairs older than
 * a week forgotten, and — when it repaired anything or could not reach everyone — one summary mail to
 * the operator, counts only.
 */
export const finishRun = internalMutation({
  args: { state: literals(['done', 'capped'] as const), tally: tallyValidator },
  handler: async (ctx, { state, tally }) => {
    const now = Date.now();
    if (state === 'capped') {
      await recordFailure(ctx, 'clerkMirror', RUN_KEY, 'Capped', now, { park: false });
    } else if (tally.overCap > 0) {
      await recordFailure(ctx, 'clerkMirror', RUN_KEY, 'OverRepairCap', now, { park: false });
    } else {
      await clearFailure(ctx, 'clerkMirror', RUN_KEY);
    }
    await forgetFailuresBefore(ctx, 'clerkMirror', now - REPAIR_RETENTION_MS, FORGET_CAP);

    const repaired = tally.lockRepairs + tally.unlockRepairs;
    if (repaired === 0 && tally.overCap === 0 && state === 'done') return;
    const lines = [
      `Unlocked ${tally.unlockRepairs}: active or suspended in Convex, but Clerk was blocking their sign-in.`,
      `Locked ${tally.lockRepairs}: banned in Convex, but Clerk was not blocking new sign-ins (every Convex function was already refusing them).`,
      `Checked ${tally.convexChecked} banned in Convex and ${tally.clerkChecked} locked in Clerk.`,
      'A repair means a sync was lost — a run that stopped after Clerk answered, or a late answer Clerk applied after its retry. Each repair runs through the usual sync, which retries and emails you if Clerk refuses. Nothing to do unless this keeps happening.',
    ];
    if (tally.overCap > 0) {
      lines.push(
        `${tally.overCap} more were out of step past this run's limit of ${MAX_REPAIRS_PER_RUN} repairs; tomorrow's run takes them. That many suggests the sync itself is failing — check the logs for Clerk errors.`,
      );
    }
    if (state === 'capped') {
      lines.push(
        `The run stopped at its limit of ${MAX_READS_PER_RUN} Clerk reads before it had checked everyone.`,
      );
    }
    await ctx.scheduler.runAfter(0, internal.operatorAlerts.send, {
      subject: `Clerk sign-in locks: ${repaired} repaired`,
      heading: 'The daily check found Clerk out of step with Convex',
      lines,
      deepLinkPath: '/admin/people',
    });
  },
});
