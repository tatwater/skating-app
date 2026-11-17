/**
 * The People pages' recurring and one-time jobs (B01 §5.7):
 *
 * - **The lapsed-suspension sweep** (D222; the founder's ruling 10, 2026-11-14). A suspension lapses at
 *   read time (`requireProfile`), but the stored status stayed `suspended` with nothing to reset it,
 *   so every reader of `status` lagged. `sweepLapsedSuspensions` (every 15 minutes) resets each
 *   suspension whose end has passed to `active`, with an actorless `unban` row saying it ran its
 *   course. Built the way the erasure sweep is (§12.8, "one failing item never starves the rest"):
 *   each person's reset is its own nested transaction; a failure is counted on the profile
 *   (`lib/attempts`), the walk moves past it, and three failures in a row (three runs) park it out of
 *   the due range; `retryLapsedDaily` tries every parked one once a day, least recently tried first.
 *   **An account in its deletion window, being finalized, or a tombstone is never touched**: the due
 *   range is `eq(undefined)` on `deletionRequestedAt` and `eq('suspended')` on the status, and the
 *   reset re-reads the profile and refuses anything else.
 * - **The drift repair** of `peopleRows`: the oldest-refreshed rows re-derived from their profiles, a
 *   few every ten minutes — what catches a profile write that missed its refresh.
 * - **Backfills** (run by hand once after deploy, each chained, bounded and resumable from the
 *   position it logs): every profile's row (`backfillRows`), and the subject of every flag filed
 *   before it was stamped (`backfillFlagSubjects`). Each marks its finish, which is when the counts it
 *   feeds stop saying they are floors.
 *
 * Every pass charges what it reads at its table's worst case (`lib/readBudget`) — a profile at the
 * document limit, its cached isochrones being polygons — and sizes its page to fit.
 */

import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx, query } from './_generated/server';
import { nextAttemptState } from './lib/attempts';
import { typed, writePersonAudit } from './lib/audit';
import { requireCapability } from './lib/auth';
import { ERASABLE } from './lib/eraseClock';
import { flagSubjectOf } from './lib/flagSubject';
import { refreshPersonRow } from './lib/peopleRows';
import {
  BACKFILL_ARGS,
  endRun,
  foundGap,
  type Lease,
  PASS_SIZE,
  readPreparation,
  savePass,
  takeLease,
  VERDICTS_DONE,
} from './lib/peopleRuns';
import { DOC_MAX, errorClassOf, ReadBudget, ROW_MAX, traced } from './lib/readBudget';
import {
  clearFailure,
  failureOf,
  type Position as LapPosition,
  lapOf,
  mirrorFailure,
  positionOf,
  saveLap,
} from './lib/recurringWork';
import { STAMP_WORK, stampTenure } from './lib/staffTenure';
import { stampStatusTerms, TERMS_STAMP_WORK } from './lib/statusTerms';

const DAY = 86_400_000;

/**
 * The read limit a nested per-person call runs under: what this transaction's budget has left, less a
 * failure's record — the erasure sweep's rule. A nested call's limit counts against the same
 * transaction (its reads are the caller's too), so it is the remaining budget, never a fixed figure: a
 * fixed one is measured from what the caller already read, and a heavy head would leave it nothing.
 *
 * The rest of the rule goes with it: a nested call that **failed** may have read all of its allowance
 * before it threw (a rollback undoes its writes, not its reads), so the caller charges the allowance,
 * not {@link PERSON_WORK} — which ends the pass, and the next one goes on from there. A success read
 * only what the writer reads, so it is charged {@link PERSON_WORK}.
 */
function nestedAllowance(reads: ReadBudget): number {
  return Math.max(0, reads.bytes - ROW_MAX.profile);
}

/**
 * What a nested per-person write may read: the profile at its worst, twice (the writer checks it, and
 * the row's refresh re-reads it after the patch), and the small rows beside it.
 */
const PERSON_WORK = 2 * DOC_MAX + 64 * 1024;

/** What one nested per-person call needs left in the budget: its work, and a failure's record. */
const NESTED_NEED = PERSON_WORK + ROW_MAX.profile;

// ── The lapsed-suspension sweep ────────────────────────────────────────────────────────────────

/** Why a lapse reset left a person as it found them — the sweep's never-touch rule, spelled out. */
export type LapseOutcome = 'reset' | 'not_suspended' | 'not_lapsed' | 'leaving' | 'gone';

/** The reason on the system's row, read in History as the suspension running its course. */
export const LAPSED_REASON = 'The suspension ran its course';

/**
 * Reset one lapsed suspension, in its own transaction. Re-reads the profile: anything but a
 * `suspended` account whose end has passed and that is not in its deletion window (nor being
 * finalized, nor a tombstone) is left exactly as it is.
 */
export const lapseOne = internalMutation({
  args: { userId: v.id('profiles'), now: v.number() },
  handler: async (ctx, { userId, now }): Promise<LapseOutcome> => {
    const reads = new ReadBudget();
    const profile = await reads.one('profile', () => ctx.db.get(userId));
    if (!profile || profile.status === 'deleting' || profile.status === 'deleted') return 'gone';
    if (profile.deletionRequestedAt !== undefined) return 'leaving';
    if (profile.status !== 'suspended') return 'not_suspended';
    if (profile.suspendedUntil === undefined || profile.suspendedUntil > now) return 'not_lapsed';
    await ctx.db.patch(userId, {
      status: 'active',
      statusReason: undefined,
      suspendedUntil: undefined,
      lapseAttempts: undefined,
      lapseErrorClass: undefined,
      lapseParkedAt: undefined,
      lapseRetriedAt: undefined,
    });
    await clearFailure(ctx, 'lapses', userId);
    await writePersonAudit(ctx, {
      action: 'unban',
      targetType: 'user',
      targetId: userId,
      reason: typed(LAPSED_REASON),
      metadata: {
        lapsed: true,
        prev: {
          status: profile.status,
          statusReason: profile.statusReason ?? null,
          suspendedUntil: profile.suspendedUntil,
        },
      },
      createdAt: now,
    });
    await refreshPersonRow(ctx, userId, { now });
    return 'reset';
  },
});

/** A position in a walk: the sort value and the creation time of the last row passed. */
const position = v.object({ at: v.number(), creation: v.number() });
type Position = { at: number; creation: number };

/**
 * The next due profile after `after`: suspended, not parked, not leaving, lapsed by `cutoff`. Ties on
 * `suspendedUntil` are walked by creation time, so a row the walk passed is never read again.
 */
async function nextDue(
  ctx: MutationCtx,
  reads: ReadBudget,
  cutoff: number,
  after: Position | undefined,
): Promise<Doc<'profiles'> | null> {
  if (after !== undefined) {
    const tie = await reads.one('profile', () =>
      ctx.db
        .query('profiles')
        .withIndex('by_suspension_due', (q) =>
          q
            .eq('status', 'suspended')
            .eq('lapseParkedAt', undefined)
            .eq('deletionRequestedAt', undefined)
            .eq('suspendedUntil', after.at)
            .gt('_creationTime', after.creation),
        )
        .first(),
    );
    if (tie) return tie;
  }
  const lower = after?.at ?? 0;
  return reads.one('profile', () =>
    ctx.db
      .query('profiles')
      .withIndex('by_suspension_due', (q) =>
        q
          .eq('status', 'suspended')
          .eq('lapseParkedAt', undefined)
          .eq('deletionRequestedAt', undefined)
          .gt('suspendedUntil', lower)
          .lte('suspendedUntil', cutoff),
      )
      .first(),
  );
}

/** A parked lapse's mirror, written from the profile's own state when it has none (D258). */
async function ensureLapseMirror(
  ctx: MutationCtx,
  reads: ReadBudget,
  profile: Doc<'profiles'>,
  now: number,
): Promise<void> {
  reads.reserve('small', 1);
  if (await failureOf(ctx, 'lapses', profile._id)) return;
  reads.touch('small');
  await mirrorFailure(
    ctx,
    'lapses',
    profile._id,
    {
      attempts: profile.lapseAttempts,
      errorClass: profile.lapseErrorClass,
      parkedAt: profile.lapseParkedAt,
      retriedAt: profile.lapseRetriedAt,
    },
    profile.lapseRetriedAt ?? profile.lapseParkedAt ?? now,
  );
}

/** Mirrored lapse failures the daily retry re-checks at its end, at most a run. */
export const MIRRORS_CHECKED = 20;

/**
 * One page of the parked-lapse mirrors, from where the last run stopped (`jobPositions`, the
 * orphan-photo walk's lap): each is kept while its profile still holds the sweep's attempt state, and
 * forgotten otherwise; a short page finishes the lap, and the next run starts at the head. In mirror
 * order (`by_job_last_failed`), ties on the time broken by creation, so no row is passed twice or not
 * at all. Every profile read is charged as it really weighs; past the budget the page stops where it
 * is, and a row left unread is kept, never judged gone.
 */
async function lapLapseMirrors(ctx: MutationCtx, reads: ReadBudget, now: number): Promise<void> {
  reads.reserve('small', 1);
  const lap = await lapOf(ctx, 'lapseMirrors');
  const at = positionOf(lap);
  const mirrors: Doc<'jobFailures'>[] = [];
  if (at !== undefined) {
    const ties = await reads.take('small', MIRRORS_CHECKED, (n) =>
      ctx.db
        .query('jobFailures')
        .withIndex('by_job_last_failed', (q) =>
          q.eq('job', 'lapses').eq('lastFailedAt', at.value).gt('_creationTime', at.creationTime),
        )
        .take(n),
    );
    mirrors.push(...ties);
  }
  const rest = MIRRORS_CHECKED - mirrors.length;
  if (rest > 0) {
    const later = await reads.take('small', rest, (n) =>
      ctx.db
        .query('jobFailures')
        .withIndex('by_job_last_failed', (q) =>
          q.eq('job', 'lapses').gt('lastFailedAt', at?.value ?? Number.NEGATIVE_INFINITY),
        )
        .take(n),
    );
    mirrors.push(...later);
  }
  let last: LapPosition | undefined;
  let stopped = false;
  for (const mirror of mirrors) {
    // A profile at its worst and the two touches after it (this mirror's delete, the lap's save) —
    // or stop here, this mirror unjudged; the next run picks up at it. A touch charged past the budget
    // would throw, and fail the run's last pass with it.
    if (!reads.affords(ROW_MAX.profile + 2 * ROW_MAX.small)) {
      stopped = true;
      break;
    }
    const id = ctx.db.normalizeId('profiles', mirror.key);
    const profile = id === null ? null : await reads.measured('profile', () => ctx.db.get(id));
    if (profile === undefined) {
      stopped = true;
      break;
    }
    const parked =
      profile !== null && profile.status === 'suspended' && profile.lapseAttempts !== undefined;
    if (!parked) {
      reads.touch('small');
      await ctx.db.delete(mirror._id);
    }
    last = { value: mirror.lastFailedAt, creationTime: mirror._creationTime };
  }
  const finished = !stopped && mirrors.length < MIRRORS_CHECKED;
  reads.touch('small');
  await saveLap(ctx, 'lapseMirrors', lap, finished ? undefined : (last ?? at), now);
}

/** A walk's position as the run's recorded cursor (for the record only; passes carry `after`). */
function positionKey(after: Position | undefined): string | null {
  return after === undefined ? null : `${after.at}:${after.creation}`;
}

/** One step's charge: the head (a profile), the nested reset's reads, and a failure's touch. */
const STEP_NEED = 2 * ROW_MAX.profile + PERSON_WORK + ROW_MAX.profile;

/**
 * Record a failed attempt on the profile (the outer transaction; the nested one rolled back). After
 * three in a row it is parked: out of the due range until the daily retry.
 */
async function recordLapseFailure(
  ctx: MutationCtx,
  profile: Doc<'profiles'>,
  errorClass: string,
  now: number,
  byDailyRetry: boolean,
): Promise<boolean> {
  const next = nextAttemptState(
    {
      attempts: profile.lapseAttempts,
      errorClass: profile.lapseErrorClass,
      parkedAt: profile.lapseParkedAt,
      retriedAt: profile.lapseRetriedAt,
    },
    { kind: 'failed', errorClass, ...(byDailyRetry ? { byDailyRetry: true } : {}) },
    now,
  );
  if (next === null) return false;
  await ctx.db.patch(profile._id, {
    lapseAttempts: next.attempts,
    lapseErrorClass: next.errorClass,
    lapseParkedAt: next.parkedAt,
    lapseRetriedAt: next.retriedAt,
  });
  // Machinery's count reads this small mirror, never the profile (D258).
  await mirrorFailure(ctx, 'lapses', profile._id, next, now);
  return next.parkedAt !== undefined;
}

/**
 * Cron entry: reset every suspension lapsed by this run's cutoff. Self-continuing while the budget
 * ran out; each person's reset in its own transaction, so one that throws rolls back only itself and
 * the walk goes on past it (one attempt a run). A pass that moved nothing and still has work throws,
 * logged with the position to re-run from. Every pass holds its run's lease (`lib/peopleRuns`): a
 * cron tick starts a new run, and a still-scheduled pass of an older run then does nothing — so two
 * runs never walk the due range at once, and no lapse takes two attempts in one run.
 */
export const sweepLapsedSuspensions = internalMutation({
  args: {
    cutoff: v.optional(v.number()),
    after: v.optional(position),
    run: v.optional(v.number()),
    pass: v.optional(v.number()),
  },
  handler: (ctx, args) =>
    traced('peopleJobs.sweepLapsedSuspensions', args, async () => {
      const reads = new ReadBudget();
      reads.reserve('small', 4);
      const lease = await takeLease(ctx, 'lapseSweep', args);
      if (lease === null) return { reset: 0, failed: 0, parked: 0, skipped: 0, more: false };
      const cutoff = args.cutoff ?? Date.now();
      let after = args.after;
      let reset = 0;
      let failed = 0;
      let parked = 0;
      let skipped = 0;
      let more = false;
      for (let steps = 0; ; steps++) {
        if (!reads.affords(STEP_NEED) || steps >= PASS_SIZE.lapseSweep) {
          more = true;
          break;
        }
        const head = await nextDue(ctx, reads, cutoff, after);
        reads.charge('small');
        if (!head) break;
        after = { at: head.suspendedUntil as number, creation: head._creationTime };
        const allowance = nestedAllowance(reads);
        let outcome: LapseOutcome;
        try {
          outcome = await ctx.runMutation(
            internal.peopleJobs.lapseOne,
            { userId: head._id, now: cutoff },
            { transactionLimits: { bytesRead: allowance } },
          );
        } catch (err) {
          // Its reads count here even though it rolled back: charged at its whole allowance.
          reads.spend(allowance);
          failed++;
          reads.touch('profile');
          if (await recordLapseFailure(ctx, head, errorClassOf(err), cutoff, false)) {
            parked++;
            console.error(
              `peopleJobs.sweepLapsedSuspensions: parked ${head._id} after repeated failures`,
            );
          }
          continue;
        }
        reads.spend(PERSON_WORK);
        if (outcome === 'reset') reset++;
        else skipped++;
      }
      const moved = reset + failed + skipped > 0;
      if (more && !moved) {
        throw new Error('peopleJobs.sweepLapsedSuspensions: a pass made no progress');
      }
      if (more) {
        const next = await savePass(ctx, lease, {
          cursor: positionKey(after),
          failed: lease.failed + failed,
        });
        await ctx.scheduler.runAfter(0, internal.peopleJobs.sweepLapsedSuspensions, {
          cutoff,
          ...next,
          ...(after !== undefined ? { after } : {}),
        });
      } else await endRun(ctx, lease, lease.failed + failed);
      return { reset, failed, parked, skipped, more };
    }),
});

/**
 * The next parked profile tried strictly before this run began, after `after`, least recently tried
 * first. Strictly: a failure re-stamps its profile at `now`, which is `runStart` itself in a run's
 * first pass, so an inclusive bound would read it again in the same run (the erasure retry's rule).
 */
async function nextParked(
  ctx: MutationCtx,
  reads: ReadBudget,
  runStart: number,
  after: Position | undefined,
): Promise<Doc<'profiles'> | null> {
  if (after !== undefined) {
    const tie = await reads.one('profile', () =>
      ctx.db
        .query('profiles')
        .withIndex('by_suspension_parked', (q) =>
          q
            .eq('status', 'suspended')
            .eq('lapseParkedAt', after.at)
            .gt('_creationTime', after.creation),
        )
        .first(),
    );
    if (tie) return tie;
  }
  return reads.one('profile', () =>
    ctx.db
      .query('profiles')
      .withIndex('by_suspension_parked', (q) =>
        q
          .eq('status', 'suspended')
          .gt('lapseParkedAt', after?.at ?? 0)
          .lt('lapseParkedAt', runStart),
      )
      .first(),
  );
}

/**
 * Daily: try every parked lapse once, least recently tried first, each in its own transaction. A
 * success resets it (and clears its record); a failure keeps it parked, re-stamped as just tried — so
 * it goes behind every other parked one tomorrow — and noted as retried. An account that has since
 * entered its deletion window is left as it is. Chained a pass at a time; only what was parked or
 * tried before the run began is read, so each is tried once a run.
 */
export const retryLapsedDaily = internalMutation({
  args: {
    runStart: v.optional(v.number()),
    after: v.optional(position),
    run: v.optional(v.number()),
    pass: v.optional(v.number()),
  },
  handler: (ctx, args) =>
    traced('peopleJobs.retryLapsedDaily', args, async () => {
      const reads = new ReadBudget();
      reads.reserve('small', 4);
      const lease = await takeLease(ctx, 'lapseRetry', args);
      if (lease === null) return { reset: 0, failed: 0, skipped: 0, more: false };
      const runStart = args.runStart ?? Date.now();
      const now = Date.now();
      let after = args.after;
      let reset = 0;
      let failed = 0;
      let skipped = 0;
      let more = false;
      for (let steps = 0; ; steps++) {
        if (!reads.affords(STEP_NEED) || steps >= PASS_SIZE.lapseRetry) {
          more = true;
          break;
        }
        const head = await nextParked(ctx, reads, runStart, after);
        reads.charge('small');
        if (!head) break;
        after = { at: head.lapseParkedAt as number, creation: head._creationTime };
        const allowance = nestedAllowance(reads);
        let outcome: LapseOutcome;
        try {
          outcome = await ctx.runMutation(
            internal.peopleJobs.lapseOne,
            { userId: head._id, now },
            { transactionLimits: { bytesRead: allowance } },
          );
        } catch (err) {
          reads.spend(allowance);
          reads.touch('profile');
          failed++;
          await recordLapseFailure(ctx, head, errorClassOf(err), now, true);
          continue;
        }
        reads.spend(PERSON_WORK);
        if (outcome === 'reset') reset++;
        else skipped++;
        // Still parked but passed by (in their deletion window): mirrored if it isn't yet — a lapse
        // parked before the mirror existed gets one here, so Machinery's count heals in a day. Outside
        // the attempt: the reset went through, so nothing here is ever recorded as the lapse failing.
        if (outcome === 'leaving') await ensureLapseMirror(ctx, reads, head, now);
      }
      if (more && reset + failed + skipped === 0) {
        throw new Error('peopleJobs.retryLapsedDaily: a pass made no progress');
      }
      if (more) {
        const next = await savePass(ctx, lease, {
          cursor: positionKey(after),
          failed: lease.failed + failed,
        });
        await ctx.scheduler.runAfter(0, internal.peopleJobs.retryLapsedDaily, {
          runStart,
          ...next,
          ...(after !== undefined ? { after } : {}),
        });
      } else {
        await endRun(ctx, lease, lease.failed + failed);
        // Mirrors whose lapse went another way — the account erased, or its status changed by a
        // writer outside this module — are forgotten a page a day, lapping the mirrors from a saved
        // place, so the ones it keeps never hold a stale one behind them.
        await lapLapseMirrors(ctx, reads, now);
      }
      return { reset, failed, skipped, more };
    }),
});

/** Parked lapses a page lists at most, and the bytes of profiles it reads at most, as they weigh. */
const PARKED_PAGE = 50;
const PARKED_PAGE_BYTES = 8 * DOC_MAX;

/**
 * The lapses the sweep parked, oldest parked first, each with its attempts and last error class — a
 * page at a time. The rows are profiles (the parking lives on them), which can weigh a whole document
 * each, so a page stops at {@link PARKED_PAGE_BYTES} of them as they really weigh and says where the
 * next begins: a short page is not the end, `isDone` is.
 */
export const parkedLapses = query({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    await requireCapability(ctx, 'machinery.read');
    const budget = new ReadBudget();
    const page = await budget.capped(PARKED_PAGE_BYTES, PARKED_PAGE, () =>
      ctx.db
        .query('profiles')
        .withIndex('by_suspension_parked', (q) =>
          q.eq('status', 'suspended').gt('lapseParkedAt', 0),
        )
        .paginate({
          cursor: cursor ?? null,
          numItems: PARKED_PAGE,
          maximumBytesRead: PARKED_PAGE_BYTES,
        }),
    );
    return {
      parked: page.page.map((p) => ({
        userId: p._id,
        suspendedUntil: p.suspendedUntil ?? null,
        attempts: p.lapseAttempts ?? 0,
        errorClass: p.lapseErrorClass ?? null,
        parkedAt: p.lapseParkedAt ?? null,
        retriedAt: p.lapseRetriedAt ?? null,
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

// ── The rows: one refresh, the drift repair, the backfill ──────────────────────────────────────

/**
 * One person's row brought in line with their profile, in its own transaction; whether the row's facts
 * changed (a missing or stale row — a gap, to the rows backfill).
 */
export const refreshOne = internalMutation({
  args: { userId: v.id('profiles'), touch: v.optional(v.boolean()) },
  handler: async (ctx, { userId, touch }): Promise<boolean> =>
    refreshPersonRow(ctx, userId, { touch: touch === true }),
});

/** A staffer's tenure stamped on their row, in its own transaction (`lib/staffTenure`). */
export const stampOne = internalMutation({
  args: { userId: v.id('profiles') },
  handler: (ctx, { userId }) => stampTenure(ctx, userId),
});

/**
 * When a suspended or banned person's terms were set, stamped on their row in its own transaction
 * (`lib/statusTerms`) — for rows written before that rule (B01-4f).
 */
export const stampTermsOne = internalMutation({
  args: { userId: v.id('profiles') },
  handler: (ctx, { userId }) => stampStatusTerms(ctx, userId),
});

/** What a pass of a superseded run returns: it read its lease and did nothing else. */
const SUPERSEDED = { done: false, superseded: true } as const;

/** A refresh, its row read beside it, and a failure's touch of that row. */
const REPAIR_STEP = ROW_MAX.small + PERSON_WORK + ROW_MAX.small;
/** Rows a drift repair looks at a run, at most. */
const REPAIR_ROWS = 10;

/**
 * Re-derive the rows refreshed longest ago (a day or more), a few a run. A row whose refresh throws is
 * stamped as refreshed anyway, so it goes to the back and never holds up the rest; the failure is
 * logged with the person's id.
 */
export const repairDrift = internalMutation({
  args: {},
  handler: (ctx, args) =>
    traced('peopleJobs.repairDrift', args, async () => {
      const now = Date.now();
      const reads = new ReadBudget();
      const n = Math.min(REPAIR_ROWS, reads.rows('small', REPAIR_ROWS, 0, REPAIR_STEP));
      const rows = await reads.take('small', n, (k) =>
        ctx.db
          .query('peopleRows')
          .withIndex('by_refreshed_at', (q) => q.lt('refreshedAt', now - DAY))
          .take(k),
      );
      let repaired = 0;
      let failed = 0;
      for (const row of rows) {
        // A failure charges its whole allowance, which leaves the rest for the next run.
        if (!reads.affords(NESTED_NEED)) break;
        const allowance = nestedAllowance(reads);
        try {
          await ctx.runMutation(
            internal.peopleJobs.refreshOne,
            { userId: row.userId, touch: true },
            { transactionLimits: { bytesRead: allowance } },
          );
          repaired++;
          reads.spend(PERSON_WORK);
        } catch (err) {
          reads.spend(allowance);
          failed++;
          console.error(`peopleJobs.repairDrift: ${row.userId} failed (${errorClassOf(err)})`);
          await ctx.db.patch(row._id, { refreshedAt: now });
        }
      }
      return { repaired, failed };
    }),
});

/** Each backfill's job, by the run it leases, and the backfill a run starts when it ends. */
const BACKFILL_JOB = {
  rows: { self: internal.peopleJobs.backfillRows, next: internal.peopleJobs.backfillFlagSubjects },
  flagSubjects: {
    self: internal.peopleJobs.backfillFlagSubjects,
    next: internal.peopleJobs.backfillUndoChains,
  },
  undoChains: {
    self: internal.peopleJobs.backfillUndoChains,
    next: internal.peopleJobs.backfillVerdicts,
  },
  verdicts: { self: internal.peopleJobs.backfillVerdicts, next: null },
} as const;

/**
 * Record the pass and schedule the run's next one, carrying its run. `gap`: the pass fixed something
 * the backfill exists to fix, which takes back an earlier `ready` — once a pass, not once an item.
 */
async function nextPass(
  ctx: MutationCtx,
  lease: Lease,
  cursor: string | null,
  failed: number,
  gap: boolean,
): Promise<void> {
  if (gap) await foundGap(ctx, lease);
  const next = await savePass(ctx, lease, { cursor, failed });
  const job = BACKFILL_JOB[lease.job as keyof typeof BACKFILL_JOB].self;
  await ctx.scheduler.runAfter(0, job, { ...next, cursor });
}

/**
 * The run reached the end of its range: it concludes its backfill's readiness, and — unless it was an
 * `alone` run — starts the next backfill's new run, whatever this one's outcome. A gap its last pass
 * fixed is recorded first, so a run begun part-way can't keep a conclusion it just disproved.
 */
async function finishBackfill(
  ctx: MutationCtx,
  lease: Lease,
  failed: number,
  gap: boolean,
): Promise<void> {
  if (gap) await foundGap(ctx, lease);
  await endRun(ctx, lease, failed);
  if (failed > 0)
    console.error(`peopleJobs: ${lease.job} run ${lease.run}: ${failed} failed; not ready`);
  const next = BACKFILL_JOB[lease.job as keyof typeof BACKFILL_JOB].next;
  if (lease.chains && next !== null) await ctx.scheduler.runAfter(0, next, {});
}

/** A profile's tombstone overwritten by a status write before discipline refused it (see below). */
function deletionOverwritten(profile: Doc<'profiles'>): boolean {
  return profile.deletedAt !== undefined && profile.status !== 'deleted';
}

/**
 * **The first People backfill, and the one command an operator runs** (`PEOPLE_BACKFILLS`): when a run
 * ends it starts `backfillFlagSubjects`, which starts `backfillUndoChains` — whatever each one's
 * outcome, since each concludes only its own readiness. Every pass holds its run's lease
 * (`lib/peopleRuns`): a call with no `run` starts a new run and supersedes any older one, whose
 * delayed passes then do nothing. `alone: true` starts a run that doesn't start the rest.
 *
 * Backfill: every profile's row, by creation time, a budget's worth a pass (each profile charged at
 * the document limit, its refresh nested), chained to the end. A refresh that throws is logged and
 * the walk goes on; the rows are marked ready — the stored counts exact — only by a run from the start
 * with no failures, so re-run from the start (it is idempotent) after a fix: a new run begun at a
 * logged position walks the rest, but can't vouch for what lies before it.
 * It also reports any tombstone whose status a discipline write overwrote before that was refused
 * (`deletedAt` set, status not `deleted`), for `restoreTombstoneStatus`.
 */
export const backfillRows = internalMutation({
  args: BACKFILL_ARGS,
  handler: (ctx, args) =>
    traced('peopleJobs.backfillRows', args, async () => {
      const reads = new ReadBudget();
      reads.reserve('small', 4);
      const lease = await takeLease(ctx, 'rows', args);
      if (lease === null) return SUPERSEDED;
      let failed = lease.failed;
      const after = Number(args.cursor ?? 0);
      const per = ROW_MAX.profile + PERSON_WORK;
      const n = reads.rows('profile', PASS_SIZE.rows, 0, per);
      const profiles = await reads.take('profile', n, (k) =>
        ctx.db
          .query('profiles')
          .withIndex('by_creation_time', (q) => q.gt('_creationTime', after))
          .take(k),
      );
      let last: Doc<'profiles'> | undefined;
      // A failure charges its whole allowance, which ends this pass; the next goes on after `last`.
      let stopped = false;
      let gap = false;
      for (const profile of profiles) {
        // A staffer's row also carries their tenure (the Staff lane's dates), stamped by the rule
        // the strip reads (`lib/staffTenure`): the item starts only when both fit.
        const staff = profile.role !== 'member' && profile.status !== 'deleted';
        // A suspended or banned person's row also carries when their terms were set
        // (`lib/statusTerms`), stamped by the rule the person page reads.
        const disciplined = profile.status === 'suspended' || profile.status === 'banned';
        const need =
          NESTED_NEED +
          (staff ? STAMP_WORK + ROW_MAX.profile : 0) +
          (disciplined ? TERMS_STAMP_WORK + ROW_MAX.profile : 0);
        if (!reads.affords(need)) {
          stopped = true;
          break;
        }
        if (deletionOverwritten(profile)) {
          console.error(
            `peopleJobs.backfillRows: tombstone whose status was overwritten: ${profile._id}`,
          );
        }
        const allowance = nestedAllowance(reads);
        try {
          const changed = await ctx.runMutation(
            internal.peopleJobs.refreshOne,
            { userId: profile._id },
            { transactionLimits: { bytesRead: allowance } },
          );
          reads.spend(PERSON_WORK);
          if (changed) gap = true;
        } catch (err) {
          reads.spend(allowance);
          failed++;
          console.error(`peopleJobs.backfillRows: ${profile._id} failed (${errorClassOf(err)})`);
          last = profile;
          continue;
        }
        if (staff) {
          const stampAllowance = nestedAllowance(reads);
          try {
            await ctx.runMutation(
              internal.peopleJobs.stampOne,
              { userId: profile._id },
              { transactionLimits: { bytesRead: stampAllowance } },
            );
            reads.spend(STAMP_WORK);
          } catch (err) {
            reads.spend(stampAllowance);
            failed++;
            console.error(`peopleJobs.backfillRows: ${profile._id} tenure (${errorClassOf(err)})`);
          }
        }
        if (disciplined) {
          const termsAllowance = nestedAllowance(reads);
          try {
            const moved = await ctx.runMutation(
              internal.peopleJobs.stampTermsOne,
              { userId: profile._id },
              { transactionLimits: { bytesRead: termsAllowance } },
            );
            reads.spend(TERMS_STAMP_WORK);
            if (moved) gap = true;
          } catch (err) {
            reads.spend(termsAllowance);
            failed++;
            console.error(`peopleJobs.backfillRows: ${profile._id} terms (${errorClassOf(err)})`);
          }
        }
        last = profile;
      }
      if (last !== undefined && (stopped || profiles.length === n)) {
        await nextPass(ctx, lease, String(last._creationTime), failed, gap);
        return { done: false };
      }
      await finishBackfill(ctx, lease, failed, gap);
      return { done: true, failed };
    }),
});

/**
 * Put a tombstone's status back to `deleted` when a suspension or ban written before discipline
 * refused tombstones overwrote it — reported by `backfillRows`. Only a profile with `deletedAt` and
 * another status is touched; its suspension window and reason go with it, as the tombstone has them.
 */
export const restoreTombstoneStatus = internalMutation({
  args: { userId: v.id('profiles') },
  handler: async (ctx, { userId }) => {
    const reads = new ReadBudget();
    const profile = await reads.one('profile', () => ctx.db.get(userId));
    if (!profile || !deletionOverwritten(profile)) return { restored: false };
    await ctx.db.patch(userId, {
      status: 'deleted',
      statusReason: undefined,
      suspendedUntil: undefined,
      lapseAttempts: undefined,
      lapseErrorClass: undefined,
      lapseParkedAt: undefined,
      lapseRetriedAt: undefined,
    });
    // The sweep's attempt state goes, so its Machinery mirror goes with it (D258).
    await clearFailure(ctx, 'lapses', userId);
    await refreshPersonRow(ctx, userId);
    return { restored: true };
  },
});

/** A flag, its target at the worst any target weighs, and the flag's patch. */
const FLAG_STEP = ROW_MAX.contentFlag + DOC_MAX + ROW_MAX.contentFlag;

/**
 * Backfill: the subject of every flag filed before it was stamped, by creation time, a budget's
 * worth a pass (a target charged at the document limit), chained to the end. A flag whose stamp
 * throws is logged and skipped; the subjects are marked ready only by a run with no failures.
 */
export const backfillFlagSubjects = internalMutation({
  args: BACKFILL_ARGS,
  handler: (ctx, args) =>
    traced('peopleJobs.backfillFlagSubjects', args, async () => {
      const reads = new ReadBudget();
      reads.reserve('small', 4);
      const lease = await takeLease(ctx, 'flagSubjects', args);
      if (lease === null) return SUPERSEDED;
      let failed = lease.failed;
      const after = Number(args.cursor ?? 0);
      const n = reads.rows('contentFlag', PASS_SIZE.flagSubjects, 0, FLAG_STEP);
      const flags = await reads.take('contentFlag', n, (k) =>
        ctx.db
          .query('contentFlags')
          .withIndex('by_creation_time', (q) => q.gt('_creationTime', after))
          .take(k),
      );
      let gap = false;
      for (const flag of flags) {
        if (flag.subjectUserId !== undefined) continue;
        try {
          reads.charge('profile');
          const subject = await flagSubjectOf(ctx, flag.targetType, flag.targetId);
          reads.touch('contentFlag');
          await ctx.db.patch(flag._id, { subjectUserId: subject });
          gap = true;
        } catch (err) {
          failed++;
          console.error(
            `peopleJobs.backfillFlagSubjects: ${flag._id} failed (${errorClassOf(err)})`,
          );
        }
      }
      const last = flags[flags.length - 1];
      if (last !== undefined && flags.length === n) {
        await nextPass(ctx, lease, String(last._creationTime), failed, gap);
        return { done: false };
      }
      await finishBackfill(ctx, lease, failed, gap);
      return { done: true, failed };
    }),
});

/** Audit rows a pass of the undo-chain backfill reads at most by real weight (by count: `PASS_SIZE`). */
const CHAIN_PAGE_BYTES = 4 * DOC_MAX;

/**
 * Backfill: every undo row written before the audit writer kept chains (`lib/undoChains`) gets its
 * chain's first row and its depth, and that first row the newest depth and who wrote it. Walks the
 * audit log oldest first (an undo is always newer than what it undoes, so its parent is placed
 * before it), a page at a time under a real-weight cap, each row's two point reads within the
 * budget; chained to the end, recording its cursor, and ready only by a run with no
 * failures. Idempotent: a row already placed is passed over.
 */
export const backfillUndoChains = internalMutation({
  args: BACKFILL_ARGS,
  handler: (ctx, args) =>
    traced('peopleJobs.backfillUndoChains', args, async () => {
      const reads = new ReadBudget();
      reads.reserve('small', 4);
      const lease = await takeLease(ctx, 'undoChains', args);
      if (lease === null) return SUPERSEDED;
      let failed = lease.failed;
      const pageSize = PASS_SIZE.undoChains;
      const page = await reads.capped(CHAIN_PAGE_BYTES, pageSize, () =>
        ctx.db.query('moderationActions').paginate({
          cursor: args.cursor ?? null,
          numItems: pageSize,
          maximumBytesRead: CHAIN_PAGE_BYTES,
        }),
      );
      let stoppedAt: number | null = null;
      let placed = 0;
      for (const [i, row] of page.page.entries()) {
        if (row.undoesActionId === undefined || row.undoRoot !== undefined) continue;
        // A role undo changes the person's tenure: their row is stamped again once it is placed —
        // so the row starts only when that walk fits too (a placed row is passed over next time).
        const roleRow =
          row.targetType === 'user' &&
          (row.action === 'grant_role' || row.action === 'revoke_role');
        if (roleRow && !reads.affords(STAMP_WORK + 2 * ROW_MAX.moderationAction)) {
          stoppedAt = i;
          break;
        }
        const parentId = row.undoesActionId;
        const parent = await reads.measured('moderationAction', () => ctx.db.get(parentId));
        if (parent === undefined) {
          stoppedAt = i;
          break;
        }
        if (parent === null) continue;
        const rootId = parent.undoRoot ?? parent._id;
        const root =
          rootId === parent._id
            ? parent
            : await reads.measured('moderationAction', () => ctx.db.get(rootId));
        if (root === undefined) {
          stoppedAt = i;
          break;
        }
        try {
          const depth = (parent.undoDepth ?? 0) + 1;
          // The first row's stamp before the row's place: a row once placed is passed over, so a
          // failure between the two must leave the row unplaced (re-run places it, the stamp holds).
          if (root !== null && (root.undoTop ?? 0) < depth) {
            await ctx.db.patch(rootId, { undoTop: depth, undoTopActorId: row.actorId });
          }
          await ctx.db.patch(row._id, { undoRoot: rootId, undoDepth: depth });
          if (roleRow) {
            try {
              await stampTenure(ctx, row.targetId as Id<'profiles'>);
            } catch (err) {
              // The same rule as the first row's stamp above: a placed row is passed over, so a stamp
              // that failed must leave the row unplaced, or the re-run never stamps the person again.
              await ctx.db.patch(row._id, { undoRoot: undefined, undoDepth: undefined });
              throw err;
            } finally {
              // Its reads count either way; the row started only once they fit.
              reads.spend(STAMP_WORK);
            }
          }
          placed++;
        } catch (err) {
          failed++;
          console.error(`peopleJobs.backfillUndoChains: ${row._id} failed (${errorClassOf(err)})`);
        }
      }
      // Out of budget part-way: the same page again from its start (placed rows are passed over).
      if (stoppedAt !== null && placed === 0) {
        throw new Error('peopleJobs.backfillUndoChains: a pass made no progress');
      }
      if (stoppedAt !== null || !page.isDone) {
        const cursor = stoppedAt !== null ? (args.cursor ?? null) : page.continueCursor;
        await nextPass(ctx, lease, cursor, failed, placed > 0);
        return { done: false };
      }
      await finishBackfill(ctx, lease, failed, placed > 0);
      return { done: true, failed };
    }),
});

/** Whether the audit log and every erasable table are empty: then the content record has no work. */
async function nothingToRecord(ctx: MutationCtx, reads: ReadBudget): Promise<boolean> {
  const audit = await reads.one('moderationAction', () =>
    ctx.db.query('moderationActions').first(),
  );
  if (audit !== null) return false;
  for (const kind of Object.keys(ERASABLE) as (keyof typeof ERASABLE)[]) {
    const row = await reads.one(kind, () => ctx.db.query(ERASABLE[kind]).first());
    if (row !== null) return false;
  }
  return true;
}

/**
 * Backfill: **the content record** (D248, B01-4d) — every item's verdicts rebuilt from its whole audit
 * history, each item's newest decision marked (`contentVerdicts.superseded`), then every withdrawn
 * row's erasure clock. Its work is three chained jobs that already existed —
 * `contentRecord.backfillVerdicts` (the audit walk), `contentRecord.replayVerdictHistory` (one item's
 * history, a page a transaction) and `erasure.backfillClocks` (after the verdicts, so no clock runs
 * before the verdict that holds it exists) — and this run's lease rides every pass of them: a pass of
 * a superseded run does nothing. Started with no `run`, it starts a new run and hands it to the walk
 * (at `cursor`, an audit-log cursor, if given: then a run begun part-way, which can't conclude
 * `ready`); the clocks' last pass hands it back with `cursor: VERDICTS_DONE`, and the run concludes.
 * Every pass that rewrote a verdict or set a clock found a gap, which takes back an earlier `ready`.
 */
export const backfillVerdicts = internalMutation({
  args: BACKFILL_ARGS,
  handler: (ctx, args) =>
    traced('peopleJobs.backfillVerdicts', args, async () => {
      const reads = new ReadBudget();
      reads.reserve('small', 4);
      const lease = await takeLease(ctx, 'verdicts', args);
      if (lease === null) return SUPERSEDED;
      const failed = lease.failed;
      if (args.run !== undefined && args.cursor === VERDICTS_DONE) {
        await finishBackfill(ctx, lease, failed, false);
        return { done: true, failed };
      }
      // A database with nothing to replay or clock — no audit row, no row of any erasable table —
      // ends at once, ready, as every People backfill does (a fresh deployment takes the procedure).
      if (args.run === undefined && (await nothingToRecord(ctx, reads))) {
        await finishBackfill(ctx, lease, failed, false);
        return { done: true, failed };
      }
      const start = args.cursor === VERDICTS_DONE ? null : (args.cursor ?? null);
      const next = await savePass(ctx, lease, { cursor: start, failed });
      await ctx.scheduler.runAfter(0, internal.contentRecord.backfillVerdicts, {
        cursor: start,
        lease: next,
      });
      return { done: false };
    }),
});

/**
 * **The operator's check** (step 3 of `AFTER_MERGE_PROCEDURE`): every People backfill's state — ready,
 * running, stalled, its last recorded position and failures — the jobs to run again, and `ready` when
 * all of them are, each as its current run has it. It is `lib/peopleRuns.readPreparation`, whose
 * `ready` and `pending` are the run rows' alone by the same rule as every People read's
 * (`readPending`), so the check and the pages can't disagree about what is finished; only the check
 * reads a running run's progress too. Internal:
 * callable only with the deployment's key (`convex run`).
 */
export const preparation = internalQuery({
  args: {},
  handler: (ctx) => readPreparation(ctx),
});
