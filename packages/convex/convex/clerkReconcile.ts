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
 * **What it checks, with no mirror state stored** (no schema change), the harmful direction first:
 *
 * 1. Every Clerk user Clerk says is banned (Clerk's own list, filtered, newest first, paged by
 *    creation time) must be banned in Convex: one whose profile says active or suspended is unlocked;
 *    one being deleted, or deleted, is left alone (account deletion deletes their Clerk user); a Clerk
 *    user with no profile is left alone. Each is counted.
 * 2. Every profile Convex says is banned (`profiles.by_status`, paged with a cursor, by weight) must
 *    be locked in Clerk: each page's Clerk users are read in one request by id.
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
 * two gaps happened — or a sync was still in its retry ladder when the run read). A run that could not finish is a row keyed {@link RUN_KEY} until one
 * does.
 *
 * **Bounded and polite.** Clerk's Backend API allows 1,000 requests per 10 s on a production instance
 * and 100 on a development one, `GET`s included, per secret key, and answers past it with a 429
 * (https://clerk.com/docs/guides/how-clerk-works/system-limits). A step makes at most
 * {@link READS_PER_STEP} sequential reads, each held to the shared 20 s timeout, and continues itself
 * {@link STEP_GAP_MS} later; repairs are spaced {@link REPAIR_SPACING_MS} apart across the whole run,
 * each batch from the slot after the last one's (never a slot in the past, so a batch found late — after
 * a retry's back-off — is spaced too, not sent at once); a run reads at most {@link MAX_READS_PER_RUN}
 * pages and repairs at most {@link MAX_REPAIRS_PER_RUN}. A failed read (a 429 included) takes
 * `setBanned`'s own path — the 30 s, 5 min, 30 min schedule, each retry resuming from the same cursor,
 * then the operator. Idempotent: a second pass over the same state repairs nothing.
 *
 * **Dry run** (`dryRun: true`): every read, no repair asked for and no row or summary written — its
 * counts say what it would repair. A read that fails past its retries still pages the operator.
 */

import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { type ClerkAnswer, clerkRequest, type LockWish, lockWish, retryOrPage } from './clerkAdmin';
import { DOC_MAX, ReadBudget } from './lib/readBudget';
import { clearFailure, forgetFailuresBefore, recordFailure } from './lib/recurringWork';
import { isSeedProfile } from './lib/seedPeople';
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
/** The gap between one repair and the next, across the run: at most two `setBanned` runs a second. */
export const REPAIR_SPACING_MS = 500;
/** How long a repair stays counted on the Machinery read. */
export const REPAIR_RETENTION_MS = 7 * DAY;
/**
 * The `jobFailures` key of a run that could not finish (never a person). It sorts before every
 * repair's key (`<runId>.<seq>`, digits): the Machinery read counts a job's first `HEALTH_CAP` rows by
 * key, and an over-cap run alone writes that many repairs — a key after them would never be counted.
 */
export const RUN_KEY = '!run';
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
  /**
   * Banned in Convex, a fake person from the dev seed (D287): no Clerk account, so never sent to
   * Clerk and never repaired — counted and skipped. Present only once one is met, and optional so a
   * run in flight across the deploy that added it still validates.
   */
  seedSkipped: v.optional(v.number()),
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

/**
 * The Clerk users one read answered with: their id, whether Clerk locks them and when they were created
 * (`null` when the entry doesn't say) — and how many entries the page held, read or not (what says
 * whether it was the last).
 */
type UsersAnswer =
  | {
      ok: true;
      users: { id: string; banned: boolean; createdAt: number | null }[];
      listed: number;
    }
  | Exclude<ClerkAnswer, { ok: true }>;

/**
 * One read of Clerk's users (`GET /v1/users`, operationId `GetUserList` in Clerk's Backend API spec,
 * https://github.com/clerk/openapi-specs `bapi/2026-08-20.yml`, the same in every published version
 * back to 2021-02-05): `user_id` (repeated, up to 100) or `banned=true`; `limit` (1–500, default 10);
 * `created_at_before` (users created strictly before it, in Unix ms), under the default order, newest
 * first (`-created_at`). The answer is an array of User objects; only `id`, `banned` and `created_at`
 * (Unix ms) are read.
 *
 * **Why not Clerk's `starting_after` cursor.** It names the last user of the previous page, and the
 * spec doesn't say what it answers when that user no longer matches `banned=true` — which this run
 * makes likely: the page's last user may be the very one it just unlocked, and a user may be deleted
 * during a retry's back-off. Paging by creation time is defined whatever happened to any one user:
 * each page asks for what was created at or before the last one's millisecond, and skips the ids
 * already read at that millisecond (`seen`), so ties across a page boundary are read once each.
 */
async function readUsers(key: string, query: string): Promise<UsersAnswer> {
  const answer = await clerkRequest(key, `/users?${query}`, 'GET');
  if (!answer.ok) return answer;
  if (!Array.isArray(answer.body)) {
    return { ok: false, failure: 'an answer that was not a list of users', retryable: false };
  }
  const users = answer.body.flatMap((u: unknown) => {
    if (typeof u !== 'object' || u === null) return [];
    const { id, banned, created_at } = u as {
      id?: unknown;
      banned?: unknown;
      created_at?: unknown;
    };
    if (typeof id !== 'string') return [];
    const createdAt =
      typeof created_at === 'number' && Number.isFinite(created_at) ? created_at : null;
    return [{ id, banned: banned === true, createdAt }];
  });
  return { ok: true, users, listed: answer.body.length };
}

/**
 * **One step of the daily reconcile** — the cron's tick starts a run (`{}`); each step continues it.
 * Never throws on a Clerk failure (the retry schedule, then the operator); a Convex failure stops the
 * chain with its side and counts in the log and the run counted under {@link RUN_KEY}, and the next
 * day's tick starts afresh.
 */
export const run = internalAction({
  args: {
    dryRun: v.optional(v.boolean()),
    /** The run's start — set by its first step, carried by the rest. */
    runId: v.optional(v.number()),
    side: v.optional(literals(SIDES)),
    /** The Convex side's page cursor. */
    cursor: v.optional(v.union(v.string(), v.null())),
    /**
     * The Clerk side's place: the `created_at_before` of its next page (absent: the newest), and the
     * ids already read at the millisecond just under it.
     */
    before: v.optional(v.number()),
    seen: v.optional(v.array(v.string())),
    /** Retry counter of the read that failed — 0 (absent) otherwise. */
    attempt: v.optional(v.number()),
    tally: v.optional(tallyValidator),
    /** The earliest the run's next repair may run — its start at first, carried by the rest. */
    repairAt: v.optional(v.number()),
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
    let side: Side = args.side ?? 'clerk';
    let cursor = args.cursor ?? null;
    let before = args.before;
    let seen = args.seen ?? [];
    /** Where the run is, for a retry or the next step. */
    const place = () => ({
      side,
      cursor,
      ...(before !== undefined ? { before } : {}),
      ...(seen.length > 0 ? { seen } : {}),
    });
    let attempt = args.attempt ?? 0;
    let repairAt = args.repairAt ?? runId;

    /** Out-of-step locks, asked of `setBanned` (spaced one after another) or, dry, only counted. */
    const nominate = async (clerkUserIds: string[], banned: boolean) => {
      if (clerkUserIds.length === 0) return;
      const asked = tally.lockRepairs + tally.unlockRepairs;
      const take = clerkUserIds.slice(0, Math.max(0, MAX_REPAIRS_PER_RUN - asked));
      tally.overCap += clerkUserIds.length - take.length;
      if (take.length === 0) return;
      if (!dryRun) {
        repairAt = await ctx.runMutation(internal.clerkReconcile.repair, {
          runId,
          seq: asked,
          from: repairAt,
          items: take.map((clerkUserId) => ({ clerkUserId, banned })),
        });
      }
      if (banned) tally.lockRepairs += take.length;
      else tally.unlockRepairs += take.length;
    };

    /** A read that failed: `setBanned`'s path — retried from this same position, then the operator. */
    const fail = async (answer: Exclude<ClerkAnswer, { ok: true }>): Promise<RunOutcome> => {
      const asked = dryRun ? 0 : tally.lockRepairs + tally.unlockRepairs;
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
            ...place(),
            attempt: nextAttempt,
            tally,
            repairAt,
          }),
        fix: `The daily check of Clerk sign-in locks against Convex stopped before it finished. ${
          asked > 0
            ? `The ${asked} repair(s) it had already asked for still run through the usual sync, and it runs again tomorrow.`
            : 'Its failure changed nothing, and it runs again tomorrow.'
        } If it keeps failing, check that CLERK_SECRET_KEY is valid and that Clerk is up.`,
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

    const step = async (): Promise<RunOutcome> => {
      let reads = 0;
      let convexPages = 0;
      while (reads < READS_PER_STEP && convexPages < CONVEX_PAGES_PER_STEP) {
        if (tally.clerkReads >= MAX_READS_PER_RUN) return await finish('capped');
        if (side === 'convex') {
          convexPages++;
          const page = await ctx.runQuery(internal.clerkReconcile.bannedPage, { cursor });
          // A fake person from the dev seed has no Clerk account (D287): counted, never asked
          // about and never repaired.
          const clerkUserIds = page.clerkUserIds.filter((id) => !isSeedProfile(id));
          const skipped = page.clerkUserIds.length - clerkUserIds.length;
          if (skipped > 0) tally.seedSkipped = (tally.seedSkipped ?? 0) + skipped;
          if (clerkUserIds.length > 0) {
            reads++;
            tally.clerkReads++;
            const query = [
              ...clerkUserIds.map((id) => `user_id=${encodeURIComponent(id)}`),
              `limit=${CLERK_PAGE}`,
            ].join('&');
            const answer = await readUsers(key, query);
            if (!answer.ok) return await fail(answer);
            attempt = 0;
            const locked = new Map(answer.users.map((u) => [u.id, u.banned]));
            const toLock: string[] = [];
            for (const id of clerkUserIds) {
              tally.convexChecked++;
              const isLocked = locked.get(id);
              if (isLocked === undefined) tally.notInClerk++;
              else if (!isLocked) toLock.push(id);
            }
            await nominate(toLock, true);
          }
          if (page.isDone) return await finish('done');
          cursor = page.continueCursor;
        } else {
          reads++;
          tally.clerkReads++;
          const upTo = before === undefined ? '' : `&created_at_before=${before}`;
          const answer = await readUsers(key, `banned=true&limit=${CLERK_PAGE}${upTo}`);
          if (!answer.ok) return await fail(answer);
          attempt = 0;
          // What this page adds: not read already at the boundary, and — Clerk's filter, read again
          // from each user — still locked (one Clerk no longer locks needs nothing).
          const already = new Set(seen);
          const ids = answer.users.filter((u) => u.banned && !already.has(u.id)).map((u) => u.id);
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
          // The last page is the one Clerk answered short — counted by what it listed, read or not;
          // then the Convex side.
          if (answer.listed < CLERK_PAGE) {
            side = 'convex';
            cursor = null;
            before = undefined;
            seen = [];
            continue;
          }
          const edge = answer.users.at(-1)?.createdAt ?? null;
          if (edge === null) {
            return await fail({
              ok: false,
              failure: 'a full page whose last user has no creation time',
              retryable: false,
            });
          }
          // The next page: created at or before this page's last millisecond, skipping who was read
          // there. A full page that adds no one is more than a page of users created in one
          // millisecond — the list can't be walked past it.
          if (answer.users.every((u) => already.has(u.id))) {
            return await fail({
              ok: false,
              failure: `more than ${CLERK_PAGE} locked users share one creation time`,
              retryable: false,
            });
          }
          const atEdge = answer.users.filter((u) => u.createdAt === edge).map((u) => u.id);
          seen = before === edge + 1 ? [...new Set([...seen, ...atEdge])] : atEdge;
          before = edge + 1;
        }
      }
      await ctx.scheduler.runAfter(STEP_GAP_MS, internal.clerkReconcile.run, {
        dryRun,
        runId,
        ...place(),
        tally,
        repairAt,
      });
      return { dryRun, state: 'continued', tally };
    };

    try {
      return await step();
    } catch (err) {
      // A Convex failure (a Clerk one never throws): the chain stops here and tomorrow's tick starts
      // afresh — never silently: its side and counts in the log (no id), the run counted unfinished.
      console.error(
        `Clerk ban-lock reconcile${dryRun ? ' (dry run)' : ''} stopped on the ${side} side by a Convex failure: ${JSON.stringify(tally)}`,
      );
      if (!dryRun) {
        await ctx.runMutation(internal.clerkReconcile.recordUnfinished, {}).catch(() => undefined);
      }
      throw err;
    }
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
 * Repairs, asked of the one sender: a `setBanned` run each (`repair: true`), spaced
 * {@link REPAIR_SPACING_MS} apart from `from` (the slot after the run's last repair) or now, whichever
 * is later — never a slot in the past, so a batch found late in a run is not sent at once — and a
 * `jobFailures` row each, keyed by the run and its sequence number, never the person, in the same
 * transaction, so a row is counted exactly when a repair was asked for. Returns the next free slot.
 */
export const repair = internalMutation({
  args: {
    runId: v.number(),
    seq: v.number(),
    from: v.number(),
    items: v.array(v.object({ clerkUserId: v.string(), banned: v.boolean() })),
  },
  handler: async (ctx, { runId, seq, from, items }): Promise<number> => {
    const now = Date.now();
    const start = Math.max(now, from);
    for (const [i, { clerkUserId, banned }] of items.entries()) {
      // At its slot, not after a delay: the slots stay exact whatever the clock reads at each call.
      await ctx.scheduler.runAt(start + i * REPAIR_SPACING_MS, internal.clerkAdmin.setBanned, {
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
    return start + items.length * REPAIR_SPACING_MS;
  },
});

/**
 * A run that gave up — on Clerk, or on a Convex failure: counted under {@link RUN_KEY} until a run
 * finishes.
 */
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
    const outOfStep = repaired > 0 || tally.overCap > 0;
    if (!outOfStep && state === 'done') return;
    const lines = [
      `Unlocked ${tally.unlockRepairs}: active or suspended in Convex, but Clerk was blocking their sign-in.`,
      `Locked ${tally.lockRepairs}: banned in Convex, but Clerk was not blocking new sign-ins (every Convex function was already refusing them).`,
      `Checked ${tally.convexChecked} banned in Convex and ${tally.clerkChecked} locked in Clerk.`,
    ];
    if (repaired > 0) {
      lines.push(
        'A repair means a sync was lost — a run that stopped after Clerk answered, or a late answer Clerk applied after its retry — or was still retrying when the check ran (a status changed in the half hour before it). Each repair runs through the usual sync, which retries and emails you if Clerk refuses. Nothing to do unless this keeps happening.',
      );
    }
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
      // A run that only hit its read limit found no one out of step: it says so, not that it did.
      subject: outOfStep
        ? `Clerk sign-in locks: ${repaired} repaired`
        : 'Clerk sign-in locks: the daily check stopped at its limit',
      heading: outOfStep
        ? 'The daily check found Clerk out of step with Convex'
        : 'The daily check of Clerk sign-in locks stopped before it had checked everyone',
      lines,
      deepLinkPath: '/admin/people',
    });
  },
});
