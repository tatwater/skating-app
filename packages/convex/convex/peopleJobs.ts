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
import { markReady, READY_FLAG_SUBJECTS, READY_ROWS, refreshPersonRow } from './lib/peopleRows';
import { DOC_MAX, errorClassOf, ReadBudget, ROW_MAX, traced } from './lib/readBudget';

const DAY = 86_400_000;

/** What a nested per-person write may read: the profile at its worst, and the small rows beside it. */
const PERSON_WORK = DOC_MAX + 64 * 1024;

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
    const profile = await ctx.db.get(userId);
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
  cutoff: number,
  after: Position | undefined,
): Promise<Doc<'profiles'> | null> {
  if (after !== undefined) {
    const tie = await ctx.db
      .query('profiles')
      .withIndex('by_suspension_due', (q) =>
        q
          .eq('status', 'suspended')
          .eq('lapseParkedAt', undefined)
          .eq('deletionRequestedAt', undefined)
          .eq('suspendedUntil', after.at)
          .gt('_creationTime', after.creation),
      )
      .first();
    if (tie) return tie;
  }
  const lower = after?.at ?? 0;
  return ctx.db
    .query('profiles')
    .withIndex('by_suspension_due', (q) =>
      q
        .eq('status', 'suspended')
        .eq('lapseParkedAt', undefined)
        .eq('deletionRequestedAt', undefined)
        .gt('suspendedUntil', lower)
        .lte('suspendedUntil', cutoff),
    )
    .first();
}

/** One step's charge: the head (a profile), the nested reset's reads, and a failure's touch. */
const STEP_NEED = ROW_MAX.profile + PERSON_WORK + ROW_MAX.profile;

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
        const head = await reads.one('profile', () => nextDue(ctx, cutoff, after));
        reads.charge('small');
        if (!head) break;
        after = { at: head.suspendedUntil as number, creation: head._creationTime };
        let outcome: LapseOutcome;
        try {
          outcome = await ctx.runMutation(
            internal.peopleJobs.lapseOne,
            { userId: head._id, now: cutoff },
            { transactionLimits: { bytesRead: PERSON_WORK } },
          );
        } catch (err) {
          reads.spend(PERSON_WORK);
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

/** The next parked profile tried before this run began, after `after`, least recently tried first. */
async function nextParked(
  ctx: MutationCtx,
  runStart: number,
  after: Position | undefined,
): Promise<Doc<'profiles'> | null> {
  if (after !== undefined) {
    const tie = await ctx.db
      .query('profiles')
      .withIndex('by_suspension_parked', (q) =>
        q
          .eq('status', 'suspended')
          .eq('lapseParkedAt', after.at)
          .gt('_creationTime', after.creation),
      )
      .first();
    if (tie) return tie;
  }
  return ctx.db
    .query('profiles')
    .withIndex('by_suspension_parked', (q) =>
      q
        .eq('status', 'suspended')
        .gt('lapseParkedAt', after?.at ?? 0)
        .lte('lapseParkedAt', runStart),
    )
    .first();
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
        const head = await reads.one('profile', () => nextParked(ctx, runStart, after));
        reads.charge('small');
        if (!head) break;
        after = { at: head.lapseParkedAt as number, creation: head._creationTime };
        try {
          const outcome = await ctx.runMutation(
            internal.peopleJobs.lapseOne,
            { userId: head._id, now },
            { transactionLimits: { bytesRead: PERSON_WORK } },
          );
          reads.spend(PERSON_WORK);
          if (outcome === 'reset') reset++;
          else skipped++;
        } catch (err) {
          reads.spend(PERSON_WORK);
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

/** At most this many parked lapses listed. */
const PARKED_LIST = 50;

/** The lapses the sweep parked, oldest parked first, each with its attempts and last error class. */
export const parkedLapses = query({
  args: {},
  handler: async (ctx) => {
    await requireCapability(ctx, 'machinery.read');
    const rows = await ctx.db
      .query('profiles')
      .withIndex('by_suspension_parked', (q) => q.eq('status', 'suspended').gt('lapseParkedAt', 0))
      .take(PARKED_LIST + 1);
    return {
      parked: rows.slice(0, PARKED_LIST).map((p) => ({
        userId: p._id,
        suspendedUntil: p.suspendedUntil ?? null,
        attempts: p.lapseAttempts ?? 0,
        errorClass: p.lapseErrorClass ?? null,
        parkedAt: p.lapseParkedAt ?? null,
        retriedAt: p.lapseRetriedAt ?? null,
      })),
      capped: rows.length > PARKED_LIST,
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
        try {
          await ctx.runMutation(
            internal.peopleJobs.refreshOne,
            { userId: row.userId, touch: true },
            { transactionLimits: { bytesRead: PERSON_WORK } },
          );
          repaired++;
        } catch (err) {
          failed++;
          console.error(`peopleJobs.repairDrift: ${row.userId} failed (${errorClassOf(err)})`);
          await ctx.db.patch(row._id, { refreshedAt: now });
        }
        reads.spend(PERSON_WORK);
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
      for (const profile of profiles) {
        if (deletionOverwritten(profile) && overwritten.length < 100) overwritten.push(profile._id);
        try {
          await ctx.runMutation(
            internal.peopleJobs.refreshOne,
            { userId: profile._id },
            { transactionLimits: { bytesRead: PERSON_WORK } },
          );
        } catch (err) {
          failed++;
          console.error(`peopleJobs.backfillRows: ${profile._id} failed (${errorClassOf(err)})`);
        }
        reads.spend(PERSON_WORK);
      }
      const last = profiles[profiles.length - 1];
      if (last !== undefined && profiles.length === n) {
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
    const profile = await ctx.db.get(userId);
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
