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
import type { Doc } from './_generated/dataModel';
import { internalMutation, type MutationCtx, query } from './_generated/server';
import { nextAttemptState } from './lib/attempts';
import { writeAudit } from './lib/audit';
import { requireCapability } from './lib/auth';
import { flagSubjectOf } from './lib/flagSubject';
import {
  markReady,
  READY_FLAG_SUBJECTS,
  READY_ROWS,
  READY_UNDO_CHAINS,
  refreshPersonRow,
} from './lib/peopleRows';
import { DOC_MAX, errorClassOf, ReadBudget, ROW_MAX, traced } from './lib/readBudget';

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
    await writeAudit(ctx, {
      action: 'unban',
      targetType: 'user',
      targetId: userId,
      reason: LAPSED_REASON,
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
  return next.parkedAt !== undefined;
}

/**
 * Cron entry: reset every suspension lapsed by this run's cutoff. Self-continuing while the budget
 * ran out; each person's reset in its own transaction, so one that throws rolls back only itself and
 * the walk goes on past it (one attempt a run). A pass that moved nothing and still has work throws,
 * logged with the position to re-run from.
 */
export const sweepLapsedSuspensions = internalMutation({
  args: { cutoff: v.optional(v.number()), after: v.optional(position) },
  handler: (ctx, args) =>
    traced('peopleJobs.sweepLapsedSuspensions', args, async () => {
      const cutoff = args.cutoff ?? Date.now();
      const reads = new ReadBudget();
      let after = args.after;
      let reset = 0;
      let failed = 0;
      let parked = 0;
      let skipped = 0;
      let more = false;
      for (;;) {
        if (!reads.affords(STEP_NEED)) {
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
        await ctx.scheduler.runAfter(0, internal.peopleJobs.sweepLapsedSuspensions, {
          cutoff,
          ...(after !== undefined ? { after } : {}),
        });
      }
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
  args: { runStart: v.optional(v.number()), after: v.optional(position) },
  handler: (ctx, args) =>
    traced('peopleJobs.retryLapsedDaily', args, async () => {
      const runStart = args.runStart ?? Date.now();
      const now = Date.now();
      const reads = new ReadBudget();
      let after = args.after;
      let reset = 0;
      let failed = 0;
      let skipped = 0;
      let more = false;
      for (;;) {
        if (!reads.affords(STEP_NEED)) {
          more = true;
          break;
        }
        const head = await nextParked(ctx, reads, runStart, after);
        reads.charge('small');
        if (!head) break;
        after = { at: head.lapseParkedAt as number, creation: head._creationTime };
        const allowance = nestedAllowance(reads);
        try {
          const outcome = await ctx.runMutation(
            internal.peopleJobs.lapseOne,
            { userId: head._id, now },
            { transactionLimits: { bytesRead: allowance } },
          );
          reads.spend(PERSON_WORK);
          if (outcome === 'reset') reset++;
          else skipped++;
        } catch (err) {
          reads.spend(allowance);
          reads.touch('profile');
          failed++;
          await recordLapseFailure(ctx, head, errorClassOf(err), now, true);
        }
      }
      if (more && reset + failed + skipped === 0) {
        throw new Error('peopleJobs.retryLapsedDaily: a pass made no progress');
      }
      if (more) {
        await ctx.scheduler.runAfter(0, internal.peopleJobs.retryLapsedDaily, {
          runStart,
          ...(after !== undefined ? { after } : {}),
        });
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

/** One person's row brought in line with their profile, in its own transaction. */
export const refreshOne = internalMutation({
  args: { userId: v.id('profiles'), touch: v.optional(v.boolean()) },
  handler: async (ctx, { userId, touch }) => {
    await refreshPersonRow(ctx, userId, { touch: touch === true });
  },
});

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

/** A profile's tombstone overwritten by a status write before discipline refused it (see below). */
function deletionOverwritten(profile: Doc<'profiles'>): boolean {
  return profile.deletedAt !== undefined && profile.status !== 'deleted';
}

/**
 * Backfill: every profile's row, by creation time, a budget's worth a pass (each profile charged at
 * the document limit, its refresh nested), chained to the end. A refresh that throws is logged and
 * the walk goes on; the rows are marked ready — the stored counts exact — only by a run with no
 * failures, so re-run from the logged position (or from the start: it is idempotent) after a fix.
 * It also reports any tombstone whose status a discipline write overwrote before that was refused
 * (`deletedAt` set, status not `deleted`), for `restoreTombstoneStatus`.
 */
export const backfillRows = internalMutation({
  args: {
    after: v.optional(v.number()),
    failed: v.optional(v.number()),
    overwritten: v.optional(v.array(v.id('profiles'))),
  },
  handler: (ctx, args) =>
    traced('peopleJobs.backfillRows', args, async () => {
      const reads = new ReadBudget();
      const per = ROW_MAX.profile + PERSON_WORK;
      const n = reads.rows('profile', 50, 0, per);
      const profiles = await reads.take('profile', n, (k) =>
        ctx.db
          .query('profiles')
          .withIndex('by_creation_time', (q) => q.gt('_creationTime', args.after ?? 0))
          .take(k),
      );
      let failed = args.failed ?? 0;
      const overwritten = [...(args.overwritten ?? [])];
      let last: Doc<'profiles'> | undefined;
      // A failure charges its whole allowance, which ends this pass; the next goes on after `last`.
      let stopped = false;
      for (const profile of profiles) {
        if (!reads.affords(NESTED_NEED)) {
          stopped = true;
          break;
        }
        if (deletionOverwritten(profile) && overwritten.length < 100) overwritten.push(profile._id);
        const allowance = nestedAllowance(reads);
        try {
          await ctx.runMutation(
            internal.peopleJobs.refreshOne,
            { userId: profile._id },
            { transactionLimits: { bytesRead: allowance } },
          );
          reads.spend(PERSON_WORK);
        } catch (err) {
          reads.spend(allowance);
          failed++;
          console.error(`peopleJobs.backfillRows: ${profile._id} failed (${errorClassOf(err)})`);
        }
        last = profile;
      }
      if (last !== undefined && (stopped || profiles.length === n)) {
        await ctx.scheduler.runAfter(0, internal.peopleJobs.backfillRows, {
          after: last._creationTime,
          failed,
          overwritten,
        });
        return { done: false };
      }
      if (overwritten.length > 0) {
        console.error(
          `peopleJobs.backfillRows: tombstones whose status was overwritten: ${overwritten.join(', ')}`,
        );
      }
      if (failed === 0) await markReady(ctx, READY_ROWS);
      else console.error(`peopleJobs.backfillRows: ${failed} failed; not marked ready — re-run it`);
      return { done: true, failed, overwritten };
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
  args: { after: v.optional(v.number()), failed: v.optional(v.number()) },
  handler: (ctx, args) =>
    traced('peopleJobs.backfillFlagSubjects', args, async () => {
      const reads = new ReadBudget();
      const n = reads.rows('contentFlag', 200, 0, FLAG_STEP);
      const flags = await reads.take('contentFlag', n, (k) =>
        ctx.db
          .query('contentFlags')
          .withIndex('by_creation_time', (q) => q.gt('_creationTime', args.after ?? 0))
          .take(k),
      );
      let failed = args.failed ?? 0;
      for (const flag of flags) {
        if (flag.subjectUserId !== undefined) continue;
        try {
          reads.charge('profile');
          const subject = await flagSubjectOf(ctx, flag.targetType, flag.targetId);
          reads.touch('contentFlag');
          await ctx.db.patch(flag._id, { subjectUserId: subject });
        } catch (err) {
          failed++;
          console.error(
            `peopleJobs.backfillFlagSubjects: ${flag._id} failed (${errorClassOf(err)})`,
          );
        }
      }
      const last = flags[flags.length - 1];
      if (last !== undefined && flags.length === n) {
        await ctx.scheduler.runAfter(0, internal.peopleJobs.backfillFlagSubjects, {
          after: last._creationTime,
          failed,
        });
        return { done: false };
      }
      if (failed === 0) await markReady(ctx, READY_FLAG_SUBJECTS);
      else
        console.error(
          `peopleJobs.backfillFlagSubjects: ${failed} failed; not marked ready — re-run it`,
        );
      return { done: true, failed };
    }),
});

/** Audit rows a pass of the undo-chain backfill reads at most, by count and by real weight. */
const CHAIN_PAGE = 200;
const CHAIN_PAGE_BYTES = 4 * DOC_MAX;

/**
 * Backfill: every undo row written before the audit writer kept chains (`lib/undoChains`) gets its
 * chain's first row and its depth, and that first row the newest depth and who wrote it. Walks the
 * audit log oldest first (an undo is always newer than what it undoes, so its parent is placed
 * before it), a page at a time under a real-weight cap, each row's two point reads within the
 * budget; chained to the end, logging its cursor, and marks `ready:undoChains` only by a run with no
 * failures. Idempotent: a row already placed is passed over.
 */
export const backfillUndoChains = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), failed: v.optional(v.number()) },
  handler: (ctx, args) =>
    traced('peopleJobs.backfillUndoChains', args, async () => {
      const reads = new ReadBudget();
      const page = await reads.capped(CHAIN_PAGE_BYTES, CHAIN_PAGE, () =>
        ctx.db.query('moderationActions').paginate({
          cursor: args.cursor ?? null,
          numItems: CHAIN_PAGE,
          maximumBytesRead: CHAIN_PAGE_BYTES,
        }),
      );
      let failed = args.failed ?? 0;
      let stoppedAt: number | null = null;
      let placed = 0;
      for (const [i, row] of page.page.entries()) {
        if (row.undoesActionId === undefined || row.undoRoot !== undefined) continue;
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
          await ctx.db.patch(row._id, { undoRoot: rootId, undoDepth: depth });
          placed++;
          placed++;
          if (root !== null && (root.undoTop ?? 0) < depth) {
            await ctx.db.patch(rootId, { undoTop: depth, undoTopActorId: row.actorId });
          }
        } catch (err) {
          failed++;
          console.error(`peopleJobs.backfillUndoChains: ${row._id} failed (${errorClassOf(err)})`);
        }
      }
      // Out of budget part-way: the same page again from its start (placed rows are passed over).
      if (stoppedAt !== null) {
        if (placed === 0) throw new Error('peopleJobs.backfillUndoChains: a pass made no progress');
        await ctx.scheduler.runAfter(0, internal.peopleJobs.backfillUndoChains, {
          cursor: args.cursor ?? null,
          failed,
        });
        return { done: false };
      }
      if (!page.isDone) {
        await ctx.scheduler.runAfter(0, internal.peopleJobs.backfillUndoChains, {
          cursor: page.continueCursor,
          failed,
        });
        return { done: false };
      }
      if (failed === 0) await markReady(ctx, READY_UNDO_CHAINS);
      else
        console.error(
          `peopleJobs.backfillUndoChains: ${failed} failed; not marked ready — re-run it`,
        );
      return { done: true, failed };
    }),
});
