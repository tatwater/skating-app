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

import { postPhotoIds } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { writeAudit } from './lib/audit';
import {
  authorRetracted,
  ERASABLE,
  type Erasable,
  type ErasableDoc,
  HOLD_COST,
  postHoldOf,
  refreshClockOf,
  withdrawnAtOf,
} from './lib/eraseClock';
import { deletePhotoAndBlobs } from './lib/photoOrphans';
import { postSearchText } from './lib/postSync';
import { ReadBudget, ROW_MAX, type RowKind } from './lib/readBudget';
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
 * about everything its uploader posted, and **an unknown is never "unused"**: so the tick only
 * collects them, per uploader, and hands each uploader's set to `settlePhotos`, which reads their
 * Reports and hazards a charged page per transaction until it has the whole answer, and only then
 * deletes what nothing uses.
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
  // The Report it was drawn in, read and patched; itself, deleted.
  hazard: 2 * ROW_MAX.report + ROW_MAX.hazard,
  // Its recording, read and patched; itself, deleted.
  report: 2 * ROW_MAX.activity + ROW_MAX.report,
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
    ROW_MAX[kind] + HOLD_COST[kind] + Math.max(ROW_MAX[kind], TAIL[kind] + ONE_DRAINED[kind]),
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
 * Cron entry: erase everything due. Self-continuing while any kind may have more, or a budget ran out
 * part-way through an item.
 */
export const eraseDue = internalMutation({
  args: { pageSize: v.optional(v.number()) },
  handler: async (ctx, { pageSize }) => {
    const size = pageSizeFor(pageSize);
    const now = Date.now();
    const erased: Partial<Record<Erasable, number>> = {};
    const photos: PhotoWork[] = [];
    // The seam scales the write budget, so a test can force any item across passes.
    const tick: Tick = { reads: new ReadBudget(), writes: size * WRITES_PER_ROW };
    let held = 0;
    let more = false;
    kinds: for (const kind of ERASED_KINDS) {
      const eraser = ERASERS[kind];
      for (let taken = 0; ; taken++) {
        if (taken >= size) {
          more = true;
          break;
        }
        // Out of budget: the rest waits for the next pass, still due.
        if (!tick.reads.affords(ITEM_NEED[kind]) || tick.writes <= 0) {
          more = true;
          break kinds;
        }
        const doc = await dueHead(ctx, tick.reads, kind, now);
        if (!doc) break;
        // The second guard: re-read the withdrawal and the holds now. A row that is held (or no
        // longer withdrawn) has its clock cleared or moved, which takes it out of the range.
        const next = await refreshClockOf(ctx, tick.reads, kind, doc, now);
        if (next === undefined || next > now) {
          held++;
          continue;
        }
        if (!(await eraser(ctx, tick, doc, now, photos))) {
          // Part-way: what it removed is gone, the item itself is whole and still due.
          more = true;
          break kinds;
        }
        await writeAudit(ctx, {
          action: 'erase',
          targetType: kind,
          targetId: doc._id,
          reason: ERASE_REASON[kind],
          createdAt: now,
        });
        erased[kind] = (erased[kind] ?? 0) + 1;
      }
    }
    // After every row they hung from is gone: each uploader's set is settled by a job that can read
    // their whole history, a charged page at a time.
    await queuePhotoSettlement(ctx, photos);
    if (more) {
      await ctx.scheduler.runAfter(0, internal.erasure.eraseDue, {
        ...(pageSize !== undefined ? { pageSize } : {}),
      });
    }
    return { erased, held, more };
  },
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

/** Photo ids per settlement job: a scheduled function's arguments are bounded too. */
const SETTLE_CHUNK = 500;

/** One settlement job per uploader per chunk, for every photo of theirs the tick's erasures let go of. */
async function queuePhotoSettlement(ctx: MutationCtx, work: readonly PhotoWork[]) {
  const byUploader = new Map<Id<'profiles'>, Set<Id<'photos'>>>();
  for (const { uploaderId, photoIds } of work) {
    const set = byUploader.get(uploaderId) ?? new Set<Id<'photos'>>();
    for (const id of photoIds) set.add(id);
    byUploader.set(uploaderId, set);
  }
  for (const [uploaderId, set] of byUploader) {
    const ids = [...set];
    for (let i = 0; i < ids.length; i += SETTLE_CHUNK) {
      await ctx.scheduler.runAfter(0, internal.erasure.settlePhotos, {
        uploaderId,
        photoIds: ids.slice(i, i + SETTLE_CHUNK),
      });
    }
  }
}

/** Settling one photo: the row, its access-photo check, and the delete or strip. */
const SETTLE_ONE = 2 * ROW_MAX.photo + ROW_MAX.small;

/**
 * Settle the photos an erasure let go of: delete each one nothing else of its uploader's still uses,
 * with its blobs; leave every other untouched (D248, and Greptile on #110 — "an unknown is not
 * unused"). The only rows that can name a photo are its uploader's own Reports and hazards and the
 * access photos that point at it (`lib/photoOrphans`), so the job reads the uploader's Reports, then
 * their hazards, a charged page per transaction, striking every photo it finds in use.
 *
 * **A photo is deleted only in a transaction that has itself read to the end of the uploader's
 * hazards** — resuming after the last hazard read (by creation time), so a hazard filed since (which
 * sets no back-link on its photos) is read before anything it shows can go — and checked there against
 * a Report that took it since (the photo's back-link) and the access photos. The deletes go as many as
 * the budget affords; the rest carry on with the same position, the list only ever shrinking (one
 * tick's photos, in chunks of `SETTLE_CHUNK`: a scheduled function's arguments are bounded too).
 * Every pass strikes, deletes, or reads a page further. A photo whose blob outlives the delete stays
 * as the orphan sweep's pointer, stripped and marked `erasedAt`, and leaves its uploader's export.
 */
export const settlePhotos = internalMutation({
  args: {
    uploaderId: v.id('profiles'),
    photoIds: v.array(v.id('photos')),
    phase: v.optional(literals(['reports', 'hazards'] as const)),
    /** The Reports' page cursor. */
    cursor: v.optional(v.string()),
    /** The creation time of the last hazard read: the hazards' read resumes after it. */
    after: v.optional(v.number()),
    /** Test seam: rows per page, clamped to what the page can afford. */
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, { uploaderId, photoIds, phase = 'reports', cursor, after, pageSize }) => {
    const reads = new ReadBudget();
    const cap = pageSize ?? Number.POSITIVE_INFINITY;
    const carryOn = (
      rest: Id<'photos'>[],
      next: { phase: 'reports'; cursor?: string } | { phase: 'hazards'; after?: number },
    ) =>
      ctx.scheduler.runAfter(0, internal.erasure.settlePhotos, {
        uploaderId,
        photoIds: rest,
        ...next,
        ...(pageSize !== undefined ? { pageSize } : {}),
      });
    if (phase === 'reports') {
      const page = await reads.page('report', reads.rows('report', cap), (numItems) =>
        ctx.db
          .query('reports')
          .withIndex('by_author', (q) => q.eq('authorId', uploaderId))
          .paginate({ cursor: cursor ?? null, numItems }),
      );
      const used = new Set<string>(page.page.flatMap((row) => row.photoIds));
      const remaining = photoIds.filter((id) => !used.has(id));
      if (remaining.length === 0) return { settled: 0, more: false };
      await carryOn(
        remaining,
        page.isDone ? { phase: 'hazards' } : { phase: 'reports', cursor: page.continueCursor },
      );
      return { settled: 0, more: true };
    }
    // Creation order, which no write moves (a hazard refiled to another lake would move under
    // `by_author_and_water_body` and could slip behind a cursor unread), resumed after the last one
    // read — creation times in a table are strictly increasing — so a hazard filed since is read too.
    const n = Math.max(1, reads.rows('hazard', cap, SETTLE_ONE));
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
    if (remaining.length === 0) return { settled: 0, more: false };
    const readTo = hazards.at(-1)?._creationTime ?? after;
    const position = readTo !== undefined ? { after: readTo } : {};
    if (hazards.length === n) {
      await carryOn(remaining, { phase: 'hazards', ...position });
      return { settled: 0, more: true };
    }
    // This transaction read to the end of their hazards: what is left, nothing of theirs uses but a
    // Report that took it since or an access point — read here, beside the delete.
    const now = Date.now();
    let settled = 0;
    let done = 0;
    while (done < remaining.length && reads.affords(SETTLE_ONE)) {
      const photoId = remaining[done] as Id<'photos'>;
      done++;
      const photo = await reads.one('photo', () => ctx.db.get(photoId));
      if (!photo || photo.erasedAt !== undefined) continue;
      if (photo.reportId !== undefined) continue;
      const onAccess = await reads.one('small', () =>
        ctx.db
          .query('accessPhotos')
          .withIndex('by_photo', (q) => q.eq('photoId', photoId))
          .first(),
      );
      if (onAccess) continue;
      reads.touch('photo');
      settled++;
      if (await deletePhotoAndBlobs(ctx, photo)) continue;
      // A blob outlived the attempt: the row is the only pointer to it (the orphan sweep retries),
      // and no longer anything of its uploader's.
      await ctx.db.patch(photoId, {
        caption: undefined,
        takenAt: undefined,
        coord: undefined,
        placeOnMap: false,
        erasedAt: now,
      });
    }
    const rest = remaining.slice(done);
    if (rest.length > 0) await carryOn(rest, { phase: 'hazards', ...position });
    return { settled, more: rest.length > 0 };
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
 * members left, each read once — the Post and at most nine Reports, inside one budget — and its clock
 * with them, in one write. The Post was held while this member was listed; it may be due now.
 */
export const dropErasedMember = internalMutation({
  args: { postId: v.id('posts'), reportId: v.id('reports') },
  handler: async (ctx, { postId, reportId }) => {
    const reads = new ReadBudget();
    const post = await reads.one('post', () => ctx.db.get(postId));
    if (!post) return;
    const reportIds = post.reportIds.filter((id) => id !== reportId);
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
  },
});

/**
 * A Post's hold moved (`lib/eraseClock.holdMoved`): its members' clocks follow, as many a transaction
 * as the budget affords — the Post's own hold read once, then each member and its own hold — skipping
 * the members `done` names. The first member always fits a fresh budget, so every pass moves.
 */
export const refreshMemberClocks = internalMutation({
  args: { postId: v.id('posts'), done: v.optional(v.array(v.id('reports'))) },
  handler: async (ctx, { postId, done = [] }) => {
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
      const member = await reads.one('report', () => ctx.db.get(id));
      if (member) await refreshClockOf(ctx, reads, 'report', member, now, { postHeld });
    }
    const more = refreshed.length < todo.length;
    if (more) {
      await ctx.scheduler.runAfter(0, internal.erasure.refreshMemberClocks, {
        postId,
        done: [...done, ...refreshed],
      });
    }
    return { refreshed: refreshed.length, more };
  },
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
    cursor: v.optional(v.string()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, { kind, cursor, pageSize }) => {
    const kinds = Object.keys(ERASABLE) as Erasable[];
    const current = (kind ?? kinds[0]) as Erasable;
    if (!kinds.includes(current)) throw new ConvexError(`Unknown kind ${kind}`);
    const size = Math.min(Math.max(pageSize ?? BACKFILL_PAGE, 1), BACKFILL_PAGE);
    const now = Date.now();
    const reads = new ReadBudget();
    // The row, a stamp, its hold, its clock.
    const perRow = 3 * ROW_MAX[current] + HOLD_COST[current];
    const page = await reads.page(current, reads.rows(current, size, 0, perRow), (numItems) =>
      ctx.db.query(ERASABLE[current]).paginate({ cursor: cursor ?? null, numItems }),
    );
    let set = 0;
    let stamped = 0;
    for (const doc of page.page as ErasableDoc[]) {
      let fresh = doc;
      if (current === 'accessAlert') {
        const alert = doc as Doc<'accessAlerts'>;
        // Retracted by its author before `retractedAt` existed: no time for its 30 days, and no
        // history row to recover one from. They start at the backfill — never in the past. A
        // moderator's retraction is not a withdrawal and is left alone.
        if (authorRetracted(alert) && alert.retractedAt === undefined) {
          reads.touch('accessAlert');
          await ctx.db.patch(alert._id, { retractedAt: now });
          fresh = { ...alert, retractedAt: now };
          stamped++;
        }
      }
      if (withdrawnAtOf(current, fresh) === undefined || fresh.eraseAt !== undefined) continue;
      if ((await refreshClockOf(ctx, reads, current, fresh, now)) !== undefined) set++;
    }
    const next = page.isDone ? kinds[kinds.indexOf(current) + 1] : current;
    if (next !== undefined) {
      await ctx.scheduler.runAfter(0, internal.erasure.backfillClocks, {
        kind: next,
        ...(page.isDone ? {} : { cursor: page.continueCursor }),
        ...(pageSize !== undefined ? { pageSize } : {}),
      });
    }
    return { kind: current, set, stamped, more: next !== undefined };
  },
});
