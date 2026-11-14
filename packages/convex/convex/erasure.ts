/**
 * The 30-day erasure (D248, the founder's rulings of 2026-11-13): what a person withdrew is gone for
 * real 30 days on, "if no moderator action is taken during that time" — so a data dump holds what the
 * person expects, a complaint that arrives after a harasser deletes their comment can still be
 * assessed, and "people's mistakes don't live on for perpetuity."
 *
 * **Erased means gone, observation included** — unlike account deletion's "erase the person, keep
 * the observation" (D62): here the author withdrew the item from the community. What stays is what
 * other people made (their comments, their votes, their flags) and what has its own life: a hazard
 * drawn in an erased Report is a warning others may have confirmed, and stays exactly as it is with
 * only its link to the Report removed (D3; founder ruling 2026-11-13).
 *
 * **The sweep reads only due work.** Eligibility is decided at the writes (`lib/eraseClock`): each
 * withdrawable row carries an `eraseAt` exactly while it is withdrawn and unheld, so `by_erase_at`'s
 * `gt(0).lte(now)` range is the work list. The hold is re-read at the moment of erasure anyway — two
 * guards for a job that cannot be undone, as the account-deletion sweep keeps two
 * (`accountDeletion.finalizeDueDeletions`).
 *
 * **One history entry per erasure**, with no actor (the system erased it) and no content — the row
 * says only that the item is gone, and when.
 *
 * **Every read is charged, and every pass moves.** Each transaction here charges every read it makes
 * — the due row, the hold checks, an item's links a page at a time, the second touch of a row it
 * patches or deletes — at its table's worst case against one `ReadBudget` (`lib/readBudget`), so no
 * pass can read past the limit however large every row is. The sweep takes the head of the due range
 * one item at a time and starts an item only when the budget left covers its hold check, its fixed
 * reads and at least one row of whatever it carries (`ITEM_NEED`, which a fresh budget always covers):
 * so each pass erases an item, clears a clock that should not run, or deletes at least one row of an
 * item it then leaves whole and still due. Erasing or clearing takes the head out of the range, so
 * the next pass walks forward with no cursor; `pageSize` is the test seam for that continuation.
 */

import { POST_MAX_REPORTS, postPhotoIds } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx, query } from './_generated/server';
import { writeAudit } from './lib/audit';
import { requireCapability } from './lib/auth';
import {
  authorRetracted,
  ERASABLE,
  type Erasable,
  type ErasableDoc,
  HOLD_COST,
  postHoldOf,
  recordEraseFailure,
  refreshClockOf,
  releaseParkedErasure,
  withdrawnAtOf,
} from './lib/eraseClock';
import { deletePhotoAndBlobs } from './lib/photoOrphans';
import { postSearchText } from './lib/postSync';
import {
  asFailure,
  errorClassOf,
  ReadBudget,
  ROW_MAX,
  type RowKind,
  SETTLE_CHUNK_IDS,
  sizePage,
  TX_BUDGET,
  TX_READ_LIMIT,
  traced,
} from './lib/readBudget';
import { literals } from './lib/validators';

export { ROW_MAX } from './lib/readBudget';

/** Items per kind per tick, at most. */
const PAGE = 100;

/** See `accountDeletion`'s `pageSizeFor`: a real argument, so a test can force the continuation. */
function pageSizeFor(requested: number | undefined): number {
  return Math.min(Math.max(requested ?? PAGE, 1), PAGE);
}

/** What the history row says. No content, no names: only that it is gone. */
const ERASE_REASON: Record<Erasable, string> = {
  report: 'Erased 30 days after its author deleted it',
  post: 'Erased 30 days after its author deleted it',
  comment: 'Erased 30 days after its author deleted it',
  hazard: 'Erased 30 days after its author withdrew it',
  contentFlag: 'Erased 30 days after the person who filed it withdrew it',
  waterBodyRequest: 'Erased 30 days after the person who asked withdrew it',
  accessAlert: 'Erased 30 days after its author retracted it',
};

/**
 * Photos an erased item carried. Whether one is still used by anything that survives is a question
 * about everything its uploader posted, and **an unknown is never "unused"**: so the tick records the
 * debt — one `photoSettlements` row per erased item, in the transaction that erased it — and
 * `settlePhotos` works from those rows, reading the uploader's Reports and hazards a charged page per
 * transaction until it has the whole answer, and only then deletes what nothing uses.
 */
interface PhotoWork {
  uploaderId: Id<'profiles'>;
  photoIds: readonly Id<'photos'>[];
}

/** One sweep transaction's budgets: the reads it may still make, and the writes. */
interface Tick {
  reads: ReadBudget;
  /** Writes left for the rows an item carries without a bound of its own (`drain`). */
  writes: number;
}

/** Writes per tick for every item the seam allows: an item rarely needs more than a few. */
const WRITES_PER_ROW = 20;

/**
 * Each eraser's fixed reads beside its drains — kept back while it drains, so they are always
 * affordable when the drains are done.
 */
const TAIL: Record<Erasable, number> = {
  // Its replies (one), itself, its parent, the parent's replies (one), the parent.
  comment: 5 * ROW_MAX.comment,
  // The Report it was drawn in, read and patched; itself, deleted; its uploader's settlement place.
  hazard: 2 * ROW_MAX.report + ROW_MAX.hazard + ROW_MAX.settleQueue,
  // Its recording, read and patched; itself, deleted; its uploader's settlement place.
  report: 2 * ROW_MAX.activity + ROW_MAX.report + ROW_MAX.settleQueue,
  post: ROW_MAX.post,
  contentFlag: ROW_MAX.contentFlag,
  waterBodyRequest: ROW_MAX.waterBodyRequest,
  accessAlert: ROW_MAX.accessAlert,
};

/** The heaviest row each eraser drains, read and touched: one is the least a started item must do. */
const ONE_DRAINED: Record<Erasable, number> = {
  comment: 0,
  hazard: 2 * ROW_MAX.small,
  report: 2 * Math.max(ROW_MAX.reportRevision, ROW_MAX.putIn, ROW_MAX.hazard, ROW_MAX.photo),
  post: 2 * ROW_MAX.postRevision,
  contentFlag: 0,
  waterBodyRequest: 0,
  accessAlert: 2 * ROW_MAX.small,
};

/**
 * What the budget must hold before the sweep takes the next item of a kind: the due row, its hold
 * check, and then either the clock write that leaves it held or its eraser's fixed reads plus one
 * drained row. Every one is under a fresh `TX_BUDGET` (a test holds that), so a pass always moves.
 */
export const ITEM_NEED: Record<Erasable, number> = Object.fromEntries(
  (Object.keys(ERASABLE) as Erasable[]).map((kind) => [
    kind,
    HOLD_COST[kind] + Math.max(ROW_MAX[kind], TAIL[kind] + ONE_DRAINED[kind]),
  ]),
) as Record<Erasable, number>;

/**
 * Delete or unlink every row a range still holds, as far as the budgets go — each row charged read
 * and touched at `kind`'s worst case, with `reserve` kept back. `take` returns the head of the range;
 * `act` removes each row from it (a delete, or clearing the indexed link), so the range shrinks.
 * `true` when the range is known empty; `false` when a budget ran out first.
 */
async function drain<Row>(
  tick: Tick,
  kind: RowKind,
  reserve: number,
  take: (n: number) => Promise<Row[]>,
  act: (row: Row) => Promise<unknown>,
): Promise<boolean> {
  for (;;) {
    const n = Math.min(tick.writes, tick.reads.rows(kind, PAGE, reserve, 2 * ROW_MAX[kind]));
    if (n <= 0) return false;
    const page = await tick.reads.take(kind, n, take);
    for (const row of page) {
      tick.reads.touch(kind);
      await act(row);
    }
    tick.writes -= page.length;
    // A short page was the whole range.
    if (page.length < n) return true;
  }
}

/** `true` when the item was erased; `false` when a budget ran out first (it is still due). */
type Eraser = (
  ctx: MutationCtx,
  tick: Tick,
  doc: ErasableDoc,
  now: number,
  photos: PhotoWork[],
) => Promise<boolean>;

/**
 * Who erases each kind, in the order a tick runs them: a Post after its members (a Post is held
 * while a member is still listed), a member after the comments under it are sorted out.
 *
 * **An alert its author retracted follows the same 30 days** (founder call, 2026-11-13: "follow the
 * 30-day pattern"). A moderator who wants one kept as evidence of a pattern of bad claims records a
 * verdict on it (a retraction on the withdrawn alert), which holds it like any held content.
 */
const ERASERS: Record<Erasable, Eraser> = {
  comment: (ctx, tick, doc, now) => eraseComment(ctx, tick, doc as Doc<'comments'>, now),
  hazard: (ctx, tick, doc, _now, photos) => eraseHazard(ctx, tick, doc as Doc<'hazards'>, photos),
  report: (ctx, tick, doc, _now, photos) => eraseReport(ctx, tick, doc as Doc<'reports'>, photos),
  post: (ctx, tick, doc) => erasePost(ctx, tick, doc as Doc<'posts'>),
  contentFlag: async (ctx, tick, doc) => {
    tick.reads.touch('contentFlag');
    await ctx.db.delete((doc as Doc<'contentFlags'>)._id);
    return true;
  },
  waterBodyRequest: async (ctx, tick, doc) => {
    tick.reads.touch('waterBodyRequest');
    await ctx.db.delete((doc as Doc<'waterBodyRequests'>)._id);
    return true;
  },
  accessAlert: (ctx, tick, doc) => eraseAlert(ctx, tick, doc as Doc<'accessAlerts'>),
};

/** The kinds the sweep erases, in order. */
export const ERASED_KINDS = Object.keys(ERASERS) as Erasable[];

/** The head of one kind's due range, charged. Bounded below: the index is not sparse. */
async function dueHead(
  ctx: MutationCtx,
  reads: ReadBudget,
  kind: Erasable,
  now: number,
): Promise<ErasableDoc | undefined> {
  // Spelled per table: Convex types an index range per table, and a union would lose them.
  const head = (rows: ErasableDoc[]) => rows[0];
  switch (kind) {
    case 'comment':
      return head(
        await reads.take(kind, 1, (n) =>
          ctx.db
            .query('comments')
            .withIndex('by_erase_at', (q) => q.gt('eraseAt', 0).lte('eraseAt', now))
            .take(n),
        ),
      );
    case 'hazard':
      return head(
        await reads.take(kind, 1, (n) =>
          ctx.db
            .query('hazards')
            .withIndex('by_erase_at', (q) => q.gt('eraseAt', 0).lte('eraseAt', now))
            .take(n),
        ),
      );
    case 'report':
      return head(
        await reads.take(kind, 1, (n) =>
          ctx.db
            .query('reports')
            .withIndex('by_erase_at', (q) => q.gt('eraseAt', 0).lte('eraseAt', now))
            .take(n),
        ),
      );
    case 'post':
      return head(
        await reads.take(kind, 1, (n) =>
          ctx.db
            .query('posts')
            .withIndex('by_erase_at', (q) => q.gt('eraseAt', 0).lte('eraseAt', now))
            .take(n),
        ),
      );
    case 'contentFlag':
      return head(
        await reads.take(kind, 1, (n) =>
          ctx.db
            .query('contentFlags')
            .withIndex('by_erase_at', (q) => q.gt('eraseAt', 0).lte('eraseAt', now))
            .take(n),
        ),
      );
    case 'waterBodyRequest':
      return head(
        await reads.take(kind, 1, (n) =>
          ctx.db
            .query('waterBodyRequests')
            .withIndex('by_erase_at', (q) => q.gt('eraseAt', 0).lte('eraseAt', now))
            .take(n),
        ),
      );
    case 'accessAlert':
      return head(
        await reads.take(kind, 1, (n) =>
          ctx.db
            .query('accessAlerts')
            .withIndex('by_erase_at', (q) => q.gt('eraseAt', 0).lte('eraseAt', now))
            .take(n),
        ),
      );
  }
}

/**
 * One item's erasure, as its own nested transaction: the hold re-read, the eraser, its history row
 * and the photo debt it leaves. An item that throws rolls back only its own work; the sweep counts
 * the failure on the item and moves on (`recordEraseFailure`). The sweep passes the row it read, in
 * the same transaction, so it is not read twice. Returns what it did and what it spent.
 */
export const eraseOne = internalMutation({
  args: {
    kind: literals([
      'report',
      'post',
      'comment',
      'hazard',
      'contentFlag',
      'waterBodyRequest',
      'accessAlert',
    ] as const satisfies readonly Erasable[]),
    doc: v.any(),
    now: v.number(),
    bytes: v.number(),
    writes: v.number(),
  },
  handler: async (ctx, { kind, doc, now, bytes, writes }) => {
    try {
      const tick: Tick = { reads: new ReadBudget(bytes), writes };
      const item = doc as ErasableDoc;
      const spent = () => ({ spent: bytes - tick.reads.bytes, writes: writes - tick.writes });
      // The second guard: re-read the withdrawal and the holds now. A row that is held (or no longer
      // withdrawn) has its clock cleared or moved, which takes it out of the range.
      const next = await refreshClockOf(ctx, tick.reads, kind, item, now);
      if (next === undefined || next > now) return { outcome: 'held' as const, ...spent() };
      const photos: PhotoWork[] = [];
      // Part-way: what it removed is gone, the item itself is whole and still due.
      if (!(await ERASERS[kind](ctx, tick, item, now, photos))) {
        return { outcome: 'partial' as const, ...spent() };
      }
      await writeAudit(ctx, {
        action: 'erase',
        targetType: kind,
        targetId: item._id,
        reason: ERASE_REASON[kind],
        createdAt: now,
      });
      // What it let go of is owed a settlement, written here, with the erasure.
      for (const work of photos) await owePhotos(ctx, tick.reads, work, now);
      return { outcome: 'erased' as const, ...spent() };
    } catch (err) {
      throw asFailure(err);
    }
  },
});

/**
 * What the sweep's own transaction needs before it takes the next item of a kind: the due row, the
 * item's own need (`ITEM_NEED`, spent by `eraseOne`), and the write that records a failure. Every one
 * is under a fresh `TX_BUDGET` (a test holds that), so a pass always moves.
 */
export const PASS_NEED: Record<Erasable, number> = Object.fromEntries(
  (Object.keys(ERASABLE) as Erasable[]).map((kind) => [kind, 2 * ROW_MAX[kind] + ITEM_NEED[kind]]),
) as Record<Erasable, number>;

/**
 * Cron entry: erase everything due. Self-continuing while any kind may have more, or a budget ran out
 * part-way through an item.
 *
 * **One item that always fails never holds up the rest.** Each item is erased in its own nested
 * transaction (`eraseOne`). One that throws rolls back only itself, and the sweep records the attempt
 * on it (`lib/eraseClock.recordEraseFailure`) and goes on; after `MAX_ERASE_ATTEMPTS` the item is
 * parked — out of the due range, counted in `erasure.parked`, released only by `erasure.retryParked`.
 */
export const eraseDue = internalMutation({
  args: {
    pageSize: v.optional(v.number()),
  },
  handler: (ctx, args) =>
    traced('erasure.eraseDue', args, async () => {
      const { pageSize } = args;
      const size = pageSizeFor(pageSize);
      const now = Date.now();
      const erased: Partial<Record<Erasable, number>> = {};
      const reads = new ReadBudget();
      // The seam scales the write budget, so a test can force any item across passes.
      let writes = size * WRITES_PER_ROW;
      let held = 0;
      let failed = 0;
      let parked = 0;
      let drained = false;
      let more = false;
      kinds: for (const kind of ERASED_KINDS) {
        for (let taken = 0; ; taken++) {
          if (taken >= size) {
            more = true;
            break;
          }
          // Out of budget: the rest waits for the next pass, still due.
          if (!reads.affords(PASS_NEED[kind]) || writes <= 0) {
            more = true;
            break kinds;
          }
          const doc = await dueHead(ctx, reads, kind, now);
          if (!doc) break;
          const allowance = reads.bytes - ROW_MAX[kind];
          try {
            const result = await ctx.runMutation(
              internal.erasure.eraseOne,
              { kind, doc, now, bytes: allowance, writes },
              { transactionLimits: { bytesRead: allowance } },
            );
            reads.spend(result.spent);
            writes -= result.writes;
            if (result.writes > 0) drained = true;
            if (result.outcome === 'held') held++;
            else if (result.outcome === 'erased') erased[kind] = (erased[kind] ?? 0) + 1;
            else {
              more = true;
              break kinds;
            }
          } catch (err) {
            // Its own work rolled back; its reads still count against this transaction.
            reads.spend(allowance);
            failed++;
            if (
              (await recordEraseFailure(ctx, reads, kind, doc, errorClassOf(err), now)) === 'parked'
            ) {
              parked++;
              console.error(`erasure.eraseDue: parked ${kind} ${doc._id} after repeated failures`);
            }
          }
        }
      }
      // Every pass moves: it erases an item, clears or moves a clock, deletes a row an item carries, or
      // counts a failure (`PASS_NEED` holds a fresh budget to that). One that did none of those and still
      // has work would reschedule itself forever over the same head — so it fails, loudly, instead.
      const moved = Object.keys(erased).length > 0 || held > 0 || failed > 0 || drained;
      if (more && !moved) {
        throw new Error('erasure.eraseDue: a pass made no progress on the head of the due range');
      }
      if (more) {
        await ctx.scheduler.runAfter(0, internal.erasure.eraseDue, {
          ...(pageSize !== undefined ? { pageSize } : {}),
        });
      } else {
        // The run is over: settle what is owed — this run's debts, and any a failed chain left.
        await ctx.scheduler.runAfter(0, internal.erasure.settleOwed, {
          ...(pageSize !== undefined ? { pageSize } : {}),
        });
      }
      return { erased, held, failed, parked, more };
    }),
});

// ── The erasers ────────────────────────────────────────────────────────────────────────────────

/**
 * A comment: its words go. A comment replies point at stays as an empty shell — no body, no edit
 * time — so the thread still draws the placeholder its replies hang from, exactly as it draws any
 * removed comment (`buildCommentThread`). Any other is deleted. A shell whose last reply this was has
 * nothing left to hold up, and goes too. (Comments keep no revisions: an edit replaces the body.)
 */
async function eraseComment(
  ctx: MutationCtx,
  tick: Tick,
  comment: Doc<'comments'>,
  now: number,
): Promise<boolean> {
  const { reads } = tick;
  const reply = await reads.one('comment', () =>
    ctx.db
      .query('comments')
      .withIndex('by_parent', (q) => q.eq('parentCommentId', comment._id))
      .first(),
  );
  reads.touch('comment');
  if (reply) {
    await ctx.db.patch(comment._id, {
      body: '',
      editedAt: undefined,
      eraseAt: undefined,
      erasedAt: now,
    });
  } else {
    await ctx.db.delete(comment._id);
  }
  const parentId = comment.parentCommentId;
  if (parentId !== undefined) {
    const parent = await reads.one('comment', () => ctx.db.get(parentId));
    if (parent?.erasedAt !== undefined) {
      const sibling = await reads.one('comment', () =>
        ctx.db
          .query('comments')
          .withIndex('by_parent', (q) => q.eq('parentCommentId', parent._id))
          .first(),
      );
      if (!sibling) {
        reads.touch('comment');
        await ctx.db.delete(parent._id);
      }
    }
  }
  return true;
}

/**
 * Record what an erasure owes, in its own transaction: the item's photo ids in debt rows of at most
 * `SETTLE_CHUNK_IDS` (an insert reads nothing), and the uploader's place in the settlement queue if
 * they have none — at the back. A parked uploader stays parked: a new debt does not release them,
 * because what fails is reading their history, which a new debt does not change; their debts wait.
 */
async function owePhotos(ctx: MutationCtx, reads: ReadBudget, work: PhotoWork, now: number) {
  const ids = [...new Set(work.photoIds)];
  if (ids.length === 0) return;
  for (let i = 0; i < ids.length; i += SETTLE_CHUNK_IDS) {
    await ctx.db.insert('photoSettlements', {
      uploaderId: work.uploaderId,
      photoIds: ids.slice(i, i + SETTLE_CHUNK_IDS),
      owedAt: now,
    });
  }
  const queued = await reads.one('settleQueue', () =>
    ctx.db
      .query('photoSettlementQueue')
      .withIndex('by_uploader', (q) => q.eq('uploaderId', work.uploaderId))
      .first(),
  );
  if (!queued) {
    await ctx.db.insert('photoSettlementQueue', {
      uploaderId: work.uploaderId,
      queuedAt: now,
      phase: 'take',
    });
  }
}

/** Failed settlement steps an uploader gets before they are parked. */
export const MAX_SETTLE_ATTEMPTS = 3;
/** Clearing one debt: its row read and deleted. */
const CLEAR_ONE = 2 * ROW_MAX.photoSettlement;
/** Settling one photo: the row, its access-photo check, and the delete or strip. */
const SETTLE_ONE = 2 * ROW_MAX.photo + ROW_MAX.small;
/** A step's own bookkeeping: its place in the queue, read and written back. */
const STEP_PLACE = 2 * ROW_MAX.settleQueue;
/** The least a step is given: its place, and a page row with a photo's settlement beside it. */
const MIN_STEP = STEP_PLACE + ROW_MAX.hazard + SETTLE_ONE;

/**
 * Settle everyone owed a settlement, an uploader at a time, round robin: the walk takes the unparked
 * uploader whose turn is oldest (`photoSettlementQueue.by_parked_queued`), runs one step of their
 * settlement as its own nested transaction (`settleStep`), and goes on to the next turn, as many as
 * the budget affords, then continues itself until no unparked uploader is owed anything.
 *
 * **One uploader that always fails never holds up anyone else.** A step that throws rolls back only
 * that uploader's step; the walk records the attempt and the error's class on their queue row, sends
 * them to the back, and goes on; after `MAX_SETTLE_ATTEMPTS` they are parked — skipped, counted in
 * `erasure.parked`, their debts still owed and their photos untouched — until `erasure.retryParked`.
 * Started at each sweep run's end and by its own hourly cron; the state is all rows, never arguments.
 */
export const settleOwed = internalMutation({
  args: { pageSize: v.optional(v.number()) },
  handler: (ctx, args) =>
    traced('erasure.settleOwed', args, async () => {
      const reads = new ReadBudget();
      const now = Date.now();
      let steps = 0;
      let failed = 0;
      let parked = 0;
      for (;;) {
        // A turn: the next uploader's place, a step, and the write that records a failure.
        if (!reads.affords(ROW_MAX.settleQueue + MIN_STEP + ROW_MAX.settleQueue)) {
          await ctx.scheduler.runAfter(0, internal.erasure.settleOwed, args);
          return { steps, failed, parked, more: true };
        }
        const [turn] = await reads.take('settleQueue', 1, (n) =>
          ctx.db
            .query('photoSettlementQueue')
            .withIndex('by_parked_queued', (q) => q.eq('parkedAt', undefined))
            .take(n),
        );
        if (!turn) return { steps, failed, parked, more: false };
        const allowance = reads.bytes - ROW_MAX.settleQueue;
        try {
          const spent = await ctx.runMutation(
            internal.erasure.settleStep,
            {
              uploaderId: turn.uploaderId,
              bytes: allowance,
              ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
            },
            { transactionLimits: { bytesRead: allowance } },
          );
          reads.spend(spent);
          steps++;
        } catch (err) {
          reads.spend(allowance);
          failed++;
          const attempts = (turn.attempts ?? 0) + 1;
          const parks = attempts >= MAX_SETTLE_ATTEMPTS;
          reads.touch('settleQueue');
          await ctx.db.patch(turn._id, {
            attempts,
            lastErrorClass: errorClassOf(err),
            // To the back of the queue: everyone else's turn comes first.
            queuedAt: Math.max(now, turn.queuedAt + 1),
            ...(parks ? { parkedAt: now } : {}),
          });
          if (parks) {
            parked++;
            console.error(`erasure.settleOwed: parked the settlement of ${turn.uploaderId}`);
          }
        }
      }
    }),
});

/**
 * One step of one uploader's settlement, as its own nested transaction (`settleOwed` runs it):
 * whatever their queue row says comes next, and the row moved on and sent to the back of the queue.
 * Returns the bytes it charged. The phases:
 *
 * - **take**: their oldest debts, as many as fit `SETTLE_CHUNK_IDS` photo ids. None left: their place
 *   is deleted — they are owed nothing.
 * - **reports**, then **hazards**: their Reports a page at a time, then their hazards resumed after
 *   the last one read (by creation time, which no write moves), striking each photo in use. **A photo
 *   is deleted only in a step that has itself read to the end of their hazards** — so a hazard filed
 *   since (which sets no back-link on its photos) is read before anything it shows can go — and is
 *   checked there against a Report that took it since (the photo's back-link) and the access photos.
 *   The only rows that can name a photo are its uploader's own Reports and hazards and the access
 *   photos that point at it (`lib/photoOrphans`). A photo whose blob outlives the delete stays as the
 *   orphan sweep's pointer, stripped and marked `erasedAt`, and leaves its uploader's export.
 * - **clear**: once every photo it took on is settled or found in use, the debts it took on are
 *   deleted, then the next take. A debt is never cleared before its settlement has finished.
 */
export const settleStep = internalMutation({
  args: {
    uploaderId: v.id('profiles'),
    bytes: v.number(),
    /** Test seam: rows per page, clamped to what the page can afford. */
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, { uploaderId, bytes, pageSize }) => {
    try {
      const reads = new ReadBudget(bytes);
      const cap = pageSize ?? Number.POSITIVE_INFINITY;
      const place = await reads.one('settleQueue', () =>
        ctx.db
          .query('photoSettlementQueue')
          .withIndex('by_uploader', (q) => q.eq('uploaderId', uploaderId))
          .first(),
      );
      if (!place) return bytes - reads.bytes;
      // The place is written back once, at the end; kept back from every page below.
      const reserve = ROW_MAX.settleQueue;
      const now = Date.now();
      const save = async (next: Partial<Doc<'photoSettlementQueue'>>) => {
        reads.touch('settleQueue');
        await ctx.db.patch(place._id, {
          cursor: undefined,
          after: undefined,
          ...next,
          // A turn taken, so to the back: round robin with everyone else owed.
          queuedAt: Math.max(now, place.queuedAt + 1),
        });
      };
      const photoIds = place.photoIds ?? [];
      const owed = place.owed ?? [];
      const toClear = () => save({ phase: 'clear', photoIds: [], owed });

      if (place.phase === 'take') {
        const rows = await reads.take(
          'photoSettlement',
          sizePage(reads, 'photoSettlement', { cap: 16, reserve }),
          (n) =>
            ctx.db
              .query('photoSettlements')
              .withIndex('by_uploader', (q) => q.eq('uploaderId', uploaderId))
              .take(n),
        );
        if (rows.length === 0) {
          // Owed nothing more: their place goes.
          reads.touch('settleQueue');
          await ctx.db.delete(place._id);
          return bytes - reads.bytes;
        }
        const taken: Id<'photoSettlements'>[] = [];
        const ids = new Set<Id<'photos'>>();
        for (const row of rows) {
          // The first debt always (at most a chunk); another only while all of it still fits.
          const fresh = [...new Set(row.photoIds)].filter((id) => !ids.has(id));
          if (taken.length > 0 && ids.size + fresh.length > SETTLE_CHUNK_IDS) break;
          taken.push(row._id);
          for (const id of fresh) ids.add(id);
        }
        await save({ phase: 'reports', photoIds: [...ids], owed: taken });
        return bytes - reads.bytes;
      }

      if (place.phase === 'clear') {
        const rest = [...owed];
        while (rest.length > 0 && reads.affords(CLEAR_ONE + reserve)) {
          const id = rest.shift() as Id<'photoSettlements'>;
          await reads.row(CLEAR_ONE, async () => {
            const row = await reads.one('photoSettlement', () => ctx.db.get(id));
            if (!row) return;
            reads.touch('photoSettlement');
            await ctx.db.delete(id);
          });
        }
        await save(rest.length > 0 ? { phase: 'clear', owed: rest } : { phase: 'take', owed: [] });
        return bytes - reads.bytes;
      }

      if (place.phase === 'reports') {
        const page = await reads.page('report', sizePage(reads, 'report', { cap, reserve }), (n) =>
          ctx.db
            .query('reports')
            .withIndex('by_author', (q) => q.eq('authorId', uploaderId))
            .paginate({ cursor: place.cursor ?? null, numItems: n }),
        );
        const used = new Set<string>(page.page.flatMap((row) => row.photoIds));
        const remaining = photoIds.filter((id) => !used.has(id));
        if (remaining.length === 0) await toClear();
        else if (page.isDone) await save({ phase: 'hazards', photoIds: remaining });
        else await save({ phase: 'reports', photoIds: remaining, cursor: page.continueCursor });
        return bytes - reads.bytes;
      }

      // Hazards, resumed after the last one read; a photo is kept back for, so a short read settles.
      const after = place.after;
      const n = sizePage(reads, 'hazard', { cap, reserve: reserve + SETTLE_ONE });
      const hazards = await reads.take('hazard', n, (k) =>
        ctx.db
          .query('hazards')
          .withIndex('by_author', (q) =>
            after === undefined
              ? q.eq('createdByUserId', uploaderId)
              : q.eq('createdByUserId', uploaderId).gt('_creationTime', after),
          )
          .take(k),
      );
      const used = new Set<string>(hazards.flatMap((row) => row.photoIds));
      const remaining = photoIds.filter((id) => !used.has(id));
      const readTo = hazards.at(-1)?._creationTime ?? after;
      const position = readTo !== undefined ? { after: readTo } : {};
      if (remaining.length === 0) {
        await toClear();
        return bytes - reads.bytes;
      }
      if (hazards.length === n) {
        await save({ phase: 'hazards', photoIds: remaining, ...position });
        return bytes - reads.bytes;
      }
      // This step read to the end of their hazards: what is left, nothing of theirs uses but a Report
      // that took it since or an access point — read here, beside the delete.
      let done = 0;
      while (done < remaining.length && reads.affords(SETTLE_ONE + reserve)) {
        const photoId = remaining[done] as Id<'photos'>;
        done++;
        await reads.row(SETTLE_ONE, async () => {
          const photo = await reads.one('photo', () => ctx.db.get(photoId));
          if (!photo || photo.erasedAt !== undefined) return;
          if (photo.reportId !== undefined) return;
          const onAccess = await reads.one('small', () =>
            ctx.db
              .query('accessPhotos')
              .withIndex('by_photo', (q) => q.eq('photoId', photoId))
              .first(),
          );
          if (onAccess) return;
          reads.touch('photo');
          if (await deletePhotoAndBlobs(ctx, photo)) return;
          // A blob outlived the attempt: the row is the only pointer to it (the orphan sweep retries),
          // and no longer anything of its uploader's.
          await ctx.db.patch(photoId, {
            caption: undefined,
            takenAt: undefined,
            coord: undefined,
            placeOnMap: false,
            erasedAt: now,
          });
        });
      }
      const rest = remaining.slice(done);
      if (rest.length === 0) await toClear();
      else await save({ phase: 'hazards', photoIds: rest, ...position });
      return bytes - reads.bytes;
    } catch (err) {
      throw asFailure(err);
    }
  },
});

/** The most parked items the parked read lists, and the most a retry releases, per kind. */
const PARKED_LIST = 50;

/**
 * Release parked work — every parked uploader's settlement, and every parked item of the kinds named
 * (all, by default), up to `PARKED_LIST` of each a call: attempts reset, back in the queue and on the
 * clock. For an operator, once whatever made them fail is fixed: `convex run erasure:retryParked '{}'`.
 */
export const retryParked = internalMutation({
  args: { kinds: v.optional(v.array(v.string())) },
  handler: async (ctx, { kinds }) => {
    const now = Date.now();
    const reads = new ReadBudget(TX_READ_LIMIT);
    const uploaders = await reads.take('settleQueue', PARKED_LIST, (n) =>
      ctx.db
        .query('photoSettlementQueue')
        .withIndex('by_parked_queued', (q) => q.gt('parkedAt', 0))
        .take(n),
    );
    for (const row of uploaders) {
      await ctx.db.patch(row._id, {
        parkedAt: undefined,
        attempts: 0,
        lastErrorClass: undefined,
        queuedAt: now,
      });
    }
    let items = 0;
    for (const kind of (kinds ?? ERASED_KINDS) as Erasable[]) {
      if (!ERASED_KINDS.includes(kind)) throw new ConvexError(`Unknown kind ${kind}`);
      const budget = new ReadBudget(TX_BUDGET);
      const parkedRows = await parkedOf(ctx, budget, kind, Math.floor(PARKED_LIST / 4));
      for (const doc of parkedRows) {
        await releaseParkedErasure(ctx, budget, kind, doc, now);
        items++;
      }
    }
    return { uploaders: uploaders.length, items };
  },
});

/** One kind's parked items, oldest parked first. Bounded below: the field is optional. */
function parkedOf(ctx: QueryCtx, reads: ReadBudget, kind: Erasable, n: number) {
  return reads.take(kind, Math.max(1, reads.rows(kind, n)), (k) =>
    // Typed as one table: every erasable table has the same `by_erase_parked` index.
    ctx.db
      .query(ERASABLE[kind] as 'reports')
      .withIndex('by_erase_parked', (q) => q.gt('eraseParkedAt', 0))
      .take(k),
  ) as Promise<ErasableDoc[]>;
}

/**
 * **What the erasure has parked** — for the console's Machinery: per kind and for photo settlements,
 * how many (counted to the list's bound, `capped` past it) and each with its attempts, its last
 * error's class and when it was parked. No content: ids, counts, classes and times.
 */
export const parked = query({
  args: {},
  handler: async (ctx) => {
    await requireCapability(ctx, 'machinery.read');
    const reads = new ReadBudget(TX_BUDGET - ROW_MAX.profile);
    const settlements = await reads.take('settleQueue', PARKED_LIST + 1, (n) =>
      ctx.db
        .query('photoSettlementQueue')
        .withIndex('by_parked_queued', (q) => q.gt('parkedAt', 0))
        .take(n),
    );
    const items: {
      kind: Erasable;
      id: string;
      attempts: number;
      errorClass: string | null;
      parkedAt: number;
    }[] = [];
    let capped = settlements.length > PARKED_LIST;
    for (const kind of ERASED_KINDS) {
      const per = Math.max(1, Math.floor(reads.bytes / ROW_MAX[kind] / (ERASED_KINDS.length + 1)));
      const rows = await parkedOf(ctx, reads, kind, Math.min(per, 8) + 1);
      if (rows.length > Math.min(per, 8)) capped = true;
      for (const doc of rows.slice(0, Math.min(per, 8))) {
        items.push({
          kind,
          id: doc._id,
          attempts: doc.eraseAttempts ?? 0,
          errorClass: doc.eraseErrorClass ?? null,
          parkedAt: doc.eraseParkedAt as number,
        });
      }
    }
    return {
      settlements: settlements.slice(0, PARKED_LIST).map((row) => ({
        uploaderId: row.uploaderId,
        attempts: row.attempts ?? 0,
        errorClass: row.lastErrorClass ?? null,
        parkedAt: row.parkedAt as number,
      })),
      items,
      capped,
    };
  },
});

/**
 * What an author wrote before each edit — their words too, and gone before the item is. An edit adds
 * one each time, with no cap, so they go a budget at a time; `false` while any remain.
 */
function eraseRevisions(
  ctx: MutationCtx,
  tick: Tick,
  targetType: 'report' | 'post',
  targetId: string,
  reserve: number,
): Promise<boolean> {
  return drain(
    tick,
    targetType === 'post' ? 'postRevision' : 'reportRevision',
    reserve,
    (n) =>
      ctx.db
        .query('contentRevisions')
        .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
        .take(n),
    (revision) => ctx.db.delete(revision._id),
  );
}

/**
 * A Report: the row, its words, its revisions, its photos and the joins derived from it.
 *
 * - **Hazards drawn in it stay exactly as they are**, with only their link to the Report removed
 *   (founder ruling, 2026-11-13): a hazard has its own life — others confirm it, it may be a live
 *   warning (D3) — and its author withdraws it separately.
 * - **Its recording returns to the author's private recordings** (founder ruling): the link goes
 *   both ways (`linkedReportId` cleared; the Report's `activityId` goes with the row), which is
 *   exactly D58's "not linked to a visible report" — an unpublished recording, as account deletion
 *   reads it — and the prompt is settled (`dismissed`), so nobody is asked again to report a skate
 *   they deleted the report of. It stays in their list of skates, and the path is theirs.
 * - **An access alert filed from it** keeps its own life too (others vote on it), with its link to
 *   the Report removed.
 * - **Point events stay** (founder ruling): they carry no content — a delta, a reason, the Report's
 *   id as `refId` and a time — and removing them would penalize deleting.
 * - **Its Post** drops it and re-derives its album, sort key, search words and clock in a job of its
 *   own (`dropErasedMember`): the Post and its other members are more than this pass can read beside
 *   the Report. Until it runs the Post lists an id that no longer resolves, which every reader skips,
 *   and the Post is held by that listing — never erased early.
 *
 * Other people's content attached to it stays theirs: comments on it (unreachable once the Report
 * is gone — `listByReport` answers `[]`), ratings and flags on it, bounties it answered (their
 * readers already skip a Report that isn't there).
 */
async function eraseReport(
  ctx: MutationCtx,
  tick: Tick,
  report: Doc<'reports'>,
  photos: PhotoWork[],
): Promise<boolean> {
  const reserve = TAIL.report;
  // Everything that holds its words or points at it first, a budget at a time; the row last, so a
  // pass that runs out leaves the Report whole, still due, and still findable by every step below.
  if (!(await eraseRevisions(ctx, tick, 'report', report._id, reserve))) return false;
  const joins = await drain(
    tick,
    'small',
    reserve,
    (n) =>
      ctx.db
        .query('reportSubAreas')
        .withIndex('by_report', (q) => q.eq('reportId', report._id))
        .take(n),
    (join) => ctx.db.delete(join._id),
  );
  if (!joins) return false;
  // A put-in a Report's point became (stored by the pre-D62 purge) is an access point on the
  // community record and stays, coordinate and all; only its pointer to the Report goes.
  const putIns = await drain(
    tick,
    'putIn',
    reserve,
    (n) =>
      ctx.db
        .query('putIns')
        .withIndex('by_origin_report', (q) => q.eq('originReportId', report._id))
        .take(n),
    (putIn) => ctx.db.patch(putIn._id, { originReportId: undefined }),
  );
  if (!putIns) return false;
  // An access alert filed from it keeps its own life (others vote on it); its link goes.
  const alerts = await drain(
    tick,
    'accessAlert',
    reserve,
    (n) =>
      ctx.db
        .query('accessAlerts')
        .withIndex('by_report', (q) => q.eq('reportId', report._id))
        .take(n),
    (alert) => ctx.db.patch(alert._id, { reportId: undefined }),
  );
  if (!alerts) return false;
  // A landmark proposal the Report's `where` filed keeps its own life (it is a request, theirs to
  // retract), and loses its pointer to the Report.
  const requests = await drain(
    tick,
    'waterBodyRequest',
    reserve,
    (n) =>
      ctx.db
        .query('waterBodyRequests')
        .withIndex('by_report', (q) => q.eq('reportId', report._id))
        .take(n),
    (request) => ctx.db.patch(request._id, { reportId: undefined }),
  );
  if (!requests) return false;
  // Its hazards stay as they are, unlinked (founder ruling, 2026-11-13).
  const hazards = await drain(
    tick,
    'hazard',
    reserve,
    (n) =>
      ctx.db
        .query('hazards')
        .withIndex('by_origin_report', (q) => q.eq('originReportId', report._id))
        .take(n),
    (hazard) => ctx.db.patch(hazard._id, { originReportId: undefined }),
  );
  if (!hazards) return false;
  // Its photos lose their link to it now (a Report owns its photos one-to-one, `assertOwnedPhotos`);
  // whether each is deleted waits for the settlement, which reads whether anything else uses it.
  const linked = await drain(
    tick,
    'photo',
    reserve,
    (n) =>
      ctx.db
        .query('photos')
        .withIndex('by_report', (q) => q.eq('reportId', report._id))
        .take(n),
    (photo) => ctx.db.patch(photo._id, { reportId: undefined }),
  );
  if (!linked) return false;
  const activityId = report.activityId;
  if (activityId !== undefined) {
    const activity = await tick.reads.one('activity', () => ctx.db.get(activityId));
    if (activity?.linkedReportId === report._id) {
      tick.reads.touch('activity');
      await ctx.db.patch(activity._id, { linkedReportId: undefined, promptState: 'dismissed' });
    }
  }

  tick.reads.touch('report');
  await ctx.db.delete(report._id);
  // Settled after the tick, by a job that reads everything else of the uploader's.
  photos.push({ uploaderId: report.authorId, photoIds: report.photoIds });
  if (report.postId !== undefined) {
    await ctx.scheduler.runAfter(0, internal.erasure.dropErasedMember, {
      postId: report.postId,
      reportId: report._id,
    });
  }
  return true;
}

/**
 * A Post loses an erased member: it drops the id and re-derives its album, sort key (over the visible
 * members; left alone with none, as `refreshPostLatestSkateEnd` leaves it) and search words from the
 * members left, each read once — the Post and at most ten Reports, inside one budget — and its clock
 * with them, in one write. The Post was held while this member was listed; it may be due now.
 */
export const dropErasedMember = internalMutation({
  args: { postId: v.id('posts'), reportId: v.id('reports') },
  handler: (ctx, args) =>
    traced('erasure.dropErasedMember', args, async () => {
      const { postId, reportId } = args;
      const reads = new ReadBudget();
      const post = await reads.one('post', () => ctx.db.get(postId));
      if (!post) return;
      const reportIds = post.reportIds.filter((id) => id !== reportId);
      // The plan: the Post, at most `POST_MAX_REPORTS` members each read once, and the Post's write —
      // twelve rows, the whole budget. Usually one fewer member (the erased one is listed); never more.
      if (reportIds.length > POST_MAX_REPORTS) {
        throw new Error(`erasure.dropErasedMember: a Post with ${post.reportIds.length} members`);
      }
      const members: Doc<'reports'>[] = [];
      for (const id of reportIds) {
        const member = await reads.one('report', () => ctx.db.get(id));
        if (member) members.push(member);
      }
      let latest: number | undefined;
      for (const member of members) {
        if (member.moderationStatus !== 'visible') continue;
        if (latest === undefined || member.skateEndTime > latest) latest = member.skateEndTime;
      }
      const derived = {
        reportIds,
        photoIds: postPhotoIds(members),
        searchText: postSearchText(post, members),
        ...(latest !== undefined ? { latestSkateEndTime: latest } : {}),
      };
      await refreshClockOf(ctx, reads, 'post', { ...post, ...derived }, Date.now(), {}, derived);
    }),
});

/**
 * A Post's hold moved (`lib/eraseClock.holdMoved`): its members' clocks follow, as many a transaction
 * as the budget affords — the Post's own hold read once, then each member and its own hold — skipping
 * the members `done` names. The first member always fits a fresh budget, so every pass moves.
 */
export const refreshMemberClocks = internalMutation({
  args: { postId: v.id('posts'), done: v.optional(v.array(v.id('reports'))) },
  handler: (ctx, args) =>
    traced('erasure.refreshMemberClocks', args, async () => {
      const { postId, done = [] } = args;
      const reads = new ReadBudget();
      const post = await reads.one('post', () => ctx.db.get(postId));
      if (!post) return { refreshed: 0, more: false };
      const postHeld = await postHoldOf(ctx, reads, post._id);
      const now = Date.now();
      const perMember = 2 * ROW_MAX.report + HOLD_COST.post;
      // By id, never by position: a member erased between passes leaves `reportIds`, and a position
      // would then skip the member after it — whose clock would never start.
      const seen = new Set<string>(done);
      const todo = post.reportIds.filter((id) => !seen.has(id));
      const refreshed: Id<'reports'>[] = [];
      for (const id of todo) {
        if (!reads.affords(perMember)) break;
        refreshed.push(id);
        await reads.row(perMember, async () => {
          const member = await reads.one('report', () => ctx.db.get(id));
          if (member) await refreshClockOf(ctx, reads, 'report', member, now, { postHeld });
        });
      }
      if (todo.length > 0 && refreshed.length === 0) {
        throw new Error('erasure.refreshMemberClocks: a pass reached no member');
      }
      const more = refreshed.length < todo.length;
      if (more) {
        await ctx.scheduler.runAfter(0, internal.erasure.refreshMemberClocks, {
          postId,
          done: [...done, ...refreshed],
        });
      }
      return { refreshed: refreshed.length, more };
    }),
});

/** A Post: reached only once every member is erased (`lib/eraseClock` holds it until then). */
async function erasePost(ctx: MutationCtx, tick: Tick, post: Doc<'posts'>): Promise<boolean> {
  if (post.reportIds.length > 0) {
    // The clock never lets this happen; refuse rather than strand members without their Post.
    throw new ConvexError('A post is erased only after its reports');
  }
  if (!(await eraseRevisions(ctx, tick, 'post', post._id, TAIL.post))) return false;
  tick.reads.touch('post');
  await ctx.db.delete(post._id);
  return true;
}

/**
 * A hazard its author withdrew (no other skater had said it was there): the row, its photos, and the
 * author's own vote on it. Other skaters' votes on it — only ever "it healed" or "it never existed",
 * or it could not have been withdrawn — stay theirs. The Report it was drawn in, if that still
 * stands, stops listing it.
 */
async function eraseHazard(
  ctx: MutationCtx,
  tick: Tick,
  hazard: Doc<'hazards'>,
  photos: PhotoWork[],
): Promise<boolean> {
  // One row a person, but older rows can hold more than one: drained, never capped.
  const own = await drain(
    tick,
    'small',
    TAIL.hazard,
    (n) =>
      ctx.db
        .query('hazardConfirmations')
        .withIndex('by_hazard_and_user', (q) =>
          q.eq('hazardId', hazard._id).eq('userId', hazard.createdByUserId),
        )
        .take(n),
    (vote) => ctx.db.delete(vote._id),
  );
  if (!own) return false;
  const originId = hazard.originReportId;
  if (originId !== undefined) {
    const report = await tick.reads.one('report', () => ctx.db.get(originId));
    if (report?.hazardIdsCreated.includes(hazard._id)) {
      tick.reads.touch('report');
      await ctx.db.patch(report._id, {
        hazardIdsCreated: report.hazardIdsCreated.filter((id) => id !== hazard._id),
      });
    }
  }
  tick.reads.touch('hazard');
  await ctx.db.delete(hazard._id);
  photos.push({ uploaderId: hazard.createdByUserId, photoIds: hazard.photoIds });
  return true;
}

/**
 * An access alert its author retracted: the row and the author's own vote on it. Other skaters'
 * votes stay theirs, pointing at an id that no longer resolves — their only readers are their own
 * export and the vote mutation, which refuses a missing alert. A flag on it shows as "(deleted)" in
 * the queue, as for any erased target.
 */
async function eraseAlert(
  ctx: MutationCtx,
  tick: Tick,
  alert: Doc<'accessAlerts'>,
): Promise<boolean> {
  const own = await drain(
    tick,
    'small',
    TAIL.accessAlert,
    (n) =>
      ctx.db
        .query('accessAlertVotes')
        .withIndex('by_alert_user', (q) =>
          q.eq('accessAlertId', alert._id).eq('userId', alert.createdByUserId),
        )
        .take(n),
    (vote) => ctx.db.delete(vote._id),
  );
  if (!own) return false;
  tick.reads.touch('accessAlert');
  await ctx.db.delete(alert._id);
  return true;
}

// ── The clocks' backfill ───────────────────────────────────────────────────────────────────────

const BACKFILL_PAGE = 200;

/**
 * Give every withdrawn row its clock (D248) — content its author deleted before the clock existed.
 * One kind per call, paged with a cursor (a row keeps its place, so the range does not shrink), then
 * the next kind. Idempotent: a running clock is never moved. Where the deletion time is unknown the
 * Part A backfill stamped it at its own run, so the 30 days start there; an alert its author retracted
 * before `retractedAt` existed is stamped here, at this run.
 *
 * Each page is sized so every row on it can be stamped and have its hold read and its clock written
 * inside one budget; at least one row a page, so every pass moves.
 *
 * **Run it after the verdict backfill** (`contentRecord.backfillVerdicts` chains here when it
 * finishes): a clock set before an old verdict is rebuilt would let the sweep erase evidence. The
 * sweep re-reads the holds at erasure, but only the holds that exist.
 *
 * `convex run erasure:backfillClocks '{}'`.
 */
export const backfillClocks = internalMutation({
  args: {
    kind: v.optional(v.string()),
    /** The creation time of the last row of this kind looked at: the walk resumes after it. */
    after: v.optional(v.number()),
    pageSize: v.optional(v.number()),
  },
  handler: (ctx, args) =>
    traced('erasure.backfillClocks', args, async () => {
      const { kind, after, pageSize } = args;
      const kinds = Object.keys(ERASABLE) as Erasable[];
      const current = (kind ?? kinds[0]) as Erasable;
      if (!kinds.includes(current)) throw new ConvexError(`Unknown kind ${kind}`);
      const size = Math.min(Math.max(pageSize ?? BACKFILL_PAGE, 1), BACKFILL_PAGE);
      const now = Date.now();
      const reads = new ReadBudget();
      // A withdrawn row's own work beside its read: a stamp, its hold, its clock. Kept back for one
      // row, so every pass gets through at least one; most rows are not withdrawn and cost only the read.
      const work = 2 * ROW_MAX[current] + HOLD_COST[current];
      // By creation time (which no write moves), resumed after the last row looked at — never by a
      // position on a page, since erasure deletes rows of these tables while the walk runs.
      const requested = sizePage(reads, current, { cap: size, reserve: work });
      const rows = (await reads.take(current, requested, (n) =>
        // Typed as one table: every erasable table has the same `by_creation_time` index.
        ctx.db
          .query(ERASABLE[current] as 'reports')
          .withIndex('by_creation_time', (q) =>
            after === undefined ? q : q.gt('_creationTime', after),
          )
          .take(n),
      )) as ErasableDoc[];
      let set = 0;
      let stamped = 0;
      let lookedTo = after;
      let looked = 0;
      for (const doc of rows) {
        const alertToStamp =
          current === 'accessAlert' &&
          authorRetracted(doc as Doc<'accessAlerts'>) &&
          (doc as Doc<'accessAlerts'>).retractedAt === undefined;
        const needsClock =
          alertToStamp || (withdrawnAtOf(current, doc) !== undefined && doc.eraseAt === undefined);
        if (needsClock && !reads.affords(work)) break;
        looked++;
        lookedTo = doc._creationTime;
        if (!needsClock) continue;
        if (
          await reads.row(work, async () => {
            let fresh = doc;
            if (alertToStamp) {
              // Retracted by its author before `retractedAt` existed: no time for its 30 days, and no
              // history row to recover one from. They start at the backfill — never in the past. A
              // moderator's retraction is not a withdrawal and is left alone.
              reads.touch('accessAlert');
              await ctx.db.patch(doc._id as Id<'accessAlerts'>, { retractedAt: now });
              fresh = { ...(doc as Doc<'accessAlerts'>), retractedAt: now };
              stamped++;
            }
            if (withdrawnAtOf(current, fresh) === undefined || fresh.eraseAt !== undefined)
              return false;
            return (await refreshClockOf(ctx, reads, current, fresh, now)) !== undefined;
          })
        )
          set++;
      }
      // The first row's work is kept back, so a pass that looked at none of its rows is a plan error.
      if (rows.length > 0 && looked === 0) {
        throw new Error(`erasure.backfillClocks: a pass looked at no ${current} row`);
      }
      // A short read, every row of it looked at, was the rest of this kind.
      const kindDone = looked === rows.length && rows.length < requested;
      const next = kindDone ? kinds[kinds.indexOf(current) + 1] : current;
      if (next !== undefined) {
        await ctx.scheduler.runAfter(0, internal.erasure.backfillClocks, {
          kind: next,
          ...(next === current && lookedTo !== undefined ? { after: lookedTo } : {}),
          ...(pageSize !== undefined ? { pageSize } : {}),
        });
      }
      return { kind: current, set, stamped, more: next !== undefined };
    }),
});
