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
 * `gt(0).lte(now)` range is the work list and nothing in it is filtered away after the read. The hold
 * is re-read at the moment of erasure anyway — two guards for a job that cannot be undone, as the
 * account-deletion sweep keeps two (`accountDeletion.finalizeDueDeletions`).
 *
 * **One history entry per erasure**, with no actor (the system erased it) and no content — the row
 * says only that the item is gone, and when.
 *
 * Paged like account deletion: each tick erases up to a page per kind and schedules itself again
 * while a page came back full, or its write budget ran out part-way (`Budget`). Erasing takes a row
 * out of the range, so re-reading the first page walks forward with no cursor; `pageSize` is the
 * test seam for that continuation.
 */

import { COMMENT_BODY_MAX_LENGTH, POST_BODY_MAX_CHARS, POST_TITLE_MAX_CHARS } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { MAX_ALERT_NOTE_LENGTH } from './accessAlerts';
import { HAZARD_MAX_DESCRIPTION_LEN } from './hazards';
import { writeAudit } from './lib/audit';
import {
  authorRetracted,
  ERASABLE,
  type Erasable,
  type ErasableDoc,
  refreshEraseClock,
  withdrawnAtOf,
} from './lib/eraseClock';
import { deletePhotoAndBlobs } from './lib/photoOrphans';
import { refreshPostLatestSkateEnd, refreshPostSearchText, syncPostPhotos } from './lib/postSync';
import { literals } from './lib/validators';

/** Rows per kind per tick. Each erasure is a handful of writes; a page fits a transaction easily. */
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
 * Reports and hazards a bounded page per transaction until it has the whole answer, and only then
 * deletes what nothing uses.
 */
interface PhotoWork {
  uploaderId: Id<'profiles'>;
  photoIds: readonly Id<'photos'>[];
}

/**
 * What one tick may still write to the rows an item carries without a bound of its own (revisions,
 * joins, links, the author's own votes — `drain`). An item's bounded writes (its row, its Report's
 * hazard list, its recording) are not counted. When it runs out mid-item the item is left whole and
 * still due — its row is the last thing deleted, so nothing of it is ever stranded behind a row that
 * is already gone — and the next pass resumes it. Sized from the page seam, so a test can force an
 * item across passes.
 */
interface Budget {
  /** Writes left. */
  left: number;
  /** Read bytes left, every row charged at the largest its table allows (`ROW_MAX`). */
  bytes: number;
}

/** Writes per tick for every page row: an item rarely needs more than a few. */
const WRITES_PER_ROW = 20;

// ── What a read can weigh ───────────────────────────────────────────────────────────────────────
//
// A transaction may read 16 MiB; one document may weigh 1 MiB. Every read of an unbounded number of
// rows — the sweep's own pages, an item's revisions, its links, the backfills' pages — is sized from
// the largest row its table allows, never from how many writes it leads to, so no pass can exceed the
// limit however large every row is. Where a field has a cap (a comment's body, a Post's prose, an
// alert's note, a hazard's description and its vertex cap) the row's worst case is that cap in UTF-8
// (4 bytes a character) plus room for the rest; where any field is uncapped (a Report's notes and its
// chips' notes, a flag's note, a request's catalog polygon, a photo's caption) the worst case is the
// document limit itself. A fixed handful of reads per item (the item, its Post and that Post's ≤ 10
// Reports, its recording) is what every write to those rows already reads, and is not counted.

/** Convex's per-document size limit, the worst any row can weigh. */
const DOC_MAX = 1 << 20;
/**
 * What one sweep tick spends on the reads it counts — half the 16 MiB transaction limit. The due page
 * takes at most half of what is left, so the first item always has room for at least four of its
 * heaviest rows, and every pass erases or unlinks something: a pass never stalls where the last one
 * did.
 */
const TICK_READ_BYTES = 8 * DOC_MAX;
/** A row's fields other than its capped text, generously. */
const SLACK = 8 * 1024;
/** The worst case of one row, by what it is. */
export const ROW_MAX = {
  comment: COMMENT_BODY_MAX_LENGTH * 4 + SLACK,
  accessAlert: MAX_ALERT_NOTE_LENGTH * 4 + SLACK,
  // A description and up to 500 vertices, drawn and clipped.
  hazard: HAZARD_MAX_DESCRIPTION_LEN * 4 + 64 * 1024,
  report: DOC_MAX,
  post: DOC_MAX,
  contentFlag: DOC_MAX,
  waterBodyRequest: DOC_MAX,
  // A Post's snapshot is its title and prose (both capped); a Report's carries its uncapped notes.
  postRevision: (POST_TITLE_MAX_CHARS + POST_BODY_MAX_CHARS) * 4 + SLACK,
  reportRevision: DOC_MAX,
  // An approach path is capped at 256 vertices.
  putIn: 64 * 1024,
  photo: DOC_MAX,
  small: SLACK,
} as const;

/** Rows of `rowMax` that `bytes` can afford, at least one: a pass that can read nothing does nothing. */
function rowsFor(bytes: number, rowMax: number, cap: number): number {
  return Math.max(1, Math.min(cap, Math.floor(bytes / rowMax)));
}

/**
 * Delete or unlink, up to the budget left, every row a range still holds — `rowMax` is what one of
 * its rows can weigh, and the page is sized by that as well as by the writes left. `take` returns
 * the head of the range; `act` removes each row from the range (a delete, or clearing the indexed
 * link), so the range shrinks. `true` when the range is empty; `false` when the budget ran out first.
 */
async function drain<Row>(
  budget: Budget,
  rowMax: number,
  take: (n: number) => Promise<Row[]>,
  act: (row: Row) => Promise<unknown>,
): Promise<boolean> {
  const n = Math.min(budget.left, Math.floor(budget.bytes / rowMax));
  if (n <= 0) return false;
  const page = await take(n);
  budget.bytes -= page.length * rowMax;
  for (const row of page) await act(row);
  budget.left -= page.length;
  // A short page was the whole range; a full one spent what it could, and one more row (if the
  // budget still affords one) says whether anything is owed.
  if (page.length < n) return true;
  if (budget.bytes < rowMax) return false;
  budget.bytes -= rowMax;
  return (await take(1)).length === 0;
}

/** `true` when the item was erased; `false` when the budget ran out first (it is still due). */
type Eraser = (
  ctx: MutationCtx,
  doc: ErasableDoc,
  now: number,
  photos: PhotoWork[],
  budget: Budget,
) => Promise<boolean>;

/**
 * Who erases each kind, in the order a tick runs them: a Post after its members (a Post is held
 * while a member is still stored), a member after the comments under it are sorted out.
 *
 * **An alert its author retracted follows the same 30 days** (founder call, 2026-11-13: "follow the
 * 30-day pattern"). A moderator who wants one kept as evidence of a pattern of bad claims records a
 * verdict on it (a retraction on the withdrawn alert), which holds it like any held content.
 */
const ERASERS: Record<Erasable, Eraser> = {
  comment: (ctx, doc, now) => eraseComment(ctx, doc as Doc<'comments'>, now),
  hazard: (ctx, doc, _now, photos, budget) =>
    eraseHazard(ctx, doc as Doc<'hazards'>, photos, budget),
  report: (ctx, doc, _now, photos, budget) =>
    eraseReport(ctx, doc as Doc<'reports'>, photos, budget),
  post: (ctx, doc, _now, _photos, budget) => erasePost(ctx, doc as Doc<'posts'>, budget),
  contentFlag: async (ctx, doc) => {
    await ctx.db.delete((doc as Doc<'contentFlags'>)._id);
    return true;
  },
  waterBodyRequest: async (ctx, doc) => {
    await ctx.db.delete((doc as Doc<'waterBodyRequests'>)._id);
    return true;
  },
  accessAlert: (ctx, doc, _now, _photos, budget) =>
    eraseAlert(ctx, doc as Doc<'accessAlerts'>, budget),
};

/** The kinds the sweep erases, in order. */
export const ERASED_KINDS = Object.keys(ERASERS) as Erasable[];

/** The due rows of one kind — every row the range returns is work. Bounded below: the index is not sparse. */
function dueRows(ctx: MutationCtx, kind: Erasable, now: number, size: number) {
  // Spelled per table: Convex types an index range per table, and a union would lose them.
  switch (kind) {
    case 'comment':
      return ctx.db
        .query('comments')
        .withIndex('by_erase_at', (q) => q.gt('eraseAt', 0).lte('eraseAt', now))
        .take(size);
    case 'hazard':
      return ctx.db
        .query('hazards')
        .withIndex('by_erase_at', (q) => q.gt('eraseAt', 0).lte('eraseAt', now))
        .take(size);
    case 'report':
      return ctx.db
        .query('reports')
        .withIndex('by_erase_at', (q) => q.gt('eraseAt', 0).lte('eraseAt', now))
        .take(size);
    case 'post':
      return ctx.db
        .query('posts')
        .withIndex('by_erase_at', (q) => q.gt('eraseAt', 0).lte('eraseAt', now))
        .take(size);
    case 'contentFlag':
      return ctx.db
        .query('contentFlags')
        .withIndex('by_erase_at', (q) => q.gt('eraseAt', 0).lte('eraseAt', now))
        .take(size);
    case 'waterBodyRequest':
      return ctx.db
        .query('waterBodyRequests')
        .withIndex('by_erase_at', (q) => q.gt('eraseAt', 0).lte('eraseAt', now))
        .take(size);
    case 'accessAlert':
      return ctx.db
        .query('accessAlerts')
        .withIndex('by_erase_at', (q) => q.gt('eraseAt', 0).lte('eraseAt', now))
        .take(size);
  }
}

/**
 * Cron entry: erase everything due. Self-continuing while any kind's page came back full.
 */
export const eraseDue = internalMutation({
  args: { pageSize: v.optional(v.number()) },
  handler: async (ctx, { pageSize }) => {
    const size = pageSizeFor(pageSize);
    const now = Date.now();
    const erased: Partial<Record<Erasable, number>> = {};
    const photos: PhotoWork[] = [];
    // The seam scales both budgets, so a test can force any item across passes.
    const budget: Budget = {
      left: size * WRITES_PER_ROW,
      bytes: Math.max(TICK_READ_BYTES * (size / PAGE), 2 * DOC_MAX),
    };
    let held = 0;
    let more = false;
    kinds: for (const kind of ERASED_KINDS) {
      const eraser = ERASERS[kind];
      // The page is what half the reads left can afford at this kind's heaviest, so the items read
      // always leave room to erase what they carry.
      if (budget.bytes < ROW_MAX[kind]) {
        more = true;
        break;
      }
      const n = rowsFor(budget.bytes / 2, ROW_MAX[kind], size);
      const due = (await dueRows(ctx, kind, now, n)) as ErasableDoc[];
      budget.bytes -= due.length * ROW_MAX[kind];
      if (due.length >= n) more = true;
      for (const doc of due) {
        // Out of budget: the rest waits for the next pass, still due.
        if (budget.left <= 0) {
          more = true;
          break kinds;
        }
        // The second guard: re-read the withdrawal and the holds now. A row that is held (or no
        // longer withdrawn) has its clock cleared or moved by the refresh, and is left alone.
        const next = await refreshEraseClock(ctx, kind, doc._id, now);
        if (next === undefined || next > now) {
          held++;
          continue;
        }
        // The refresh read the row again; erase what is stored now.
        const current = (await ctx.db.get(doc._id)) as ErasableDoc | null;
        if (!current || withdrawnAtOf(kind, current) === undefined) continue;
        if (!(await eraser(ctx, current, now, photos, budget))) {
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
    // their whole history, a bounded page at a time.
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
  comment: Doc<'comments'>,
  now: number,
): Promise<boolean> {
  const reply = await ctx.db
    .query('comments')
    .withIndex('by_parent', (q) => q.eq('parentCommentId', comment._id))
    .first();
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
  if (comment.parentCommentId !== undefined) {
    const parent = await ctx.db.get(comment.parentCommentId);
    if (parent?.erasedAt !== undefined) {
      const sibling = await ctx.db
        .query('comments')
        .withIndex('by_parent', (q) => q.eq('parentCommentId', parent._id))
        .first();
      if (!sibling) await ctx.db.delete(parent._id);
    }
  }
  return true;
}

/** One settlement job per uploader, for every photo of theirs the tick's erasures let go of. */
async function queuePhotoSettlement(ctx: MutationCtx, work: readonly PhotoWork[]) {
  const byUploader = new Map<Id<'profiles'>, Set<Id<'photos'>>>();
  for (const { uploaderId, photoIds } of work) {
    const set = byUploader.get(uploaderId) ?? new Set<Id<'photos'>>();
    for (const id of photoIds) set.add(id);
    byUploader.set(uploaderId, set);
  }
  for (const [uploaderId, set] of byUploader) {
    if (set.size === 0) continue;
    await ctx.scheduler.runAfter(0, internal.erasure.settlePhotos, {
      uploaderId,
      photoIds: [...set],
    });
  }
}

/**
 * Settle the photos an erasure let go of: delete each one nothing else of its uploader's still uses,
 * with its blobs; leave every other untouched (D248, and Greptile on #110 — "an unknown is not
 * unused"). The only rows that can name a photo are its uploader's own Reports and hazards and the
 * access photos that point at it (`lib/photoOrphans`), so the job reads the uploader's Reports, then
 * their hazards, a page per transaction sized by what a row can weigh, striking every photo it finds
 * in use; what is left when both are read is used by nothing, checked once more against the access
 * photos and a Report that took it since. A photo whose blob outlives the delete stays as the orphan
 * sweep's pointer, stripped and marked `erasedAt`, and leaves its uploader's export.
 */
export const settlePhotos = internalMutation({
  args: {
    uploaderId: v.id('profiles'),
    photoIds: v.array(v.id('photos')),
    phase: v.optional(literals(['reports', 'hazards'] as const)),
    cursor: v.optional(v.string()),
    /** Test seam: rows per page, clamped to what the page can afford. */
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, { uploaderId, photoIds, phase = 'reports', cursor, pageSize }) => {
    const rowMax = phase === 'reports' ? ROW_MAX.report : ROW_MAX.hazard;
    const numItems = rowsFor(TICK_READ_BYTES, rowMax, pageSize ?? Number.POSITIVE_INFINITY);
    const page =
      phase === 'reports'
        ? await ctx.db
            .query('reports')
            .withIndex('by_author', (q) => q.eq('authorId', uploaderId))
            .paginate({ cursor: cursor ?? null, numItems })
        : await ctx.db
            .query('hazards')
            .withIndex('by_author_and_water_body', (q) => q.eq('createdByUserId', uploaderId))
            .paginate({ cursor: cursor ?? null, numItems });
    const used = new Set<string>(
      (page.page as (Doc<'reports'> | Doc<'hazards'>)[]).flatMap((row) => row.photoIds),
    );
    const remaining = photoIds.filter((id) => !used.has(id));
    if (remaining.length === 0) return { settled: 0, kept: photoIds.length };
    if (!page.isDone || phase === 'reports') {
      await ctx.scheduler.runAfter(0, internal.erasure.settlePhotos, {
        uploaderId,
        photoIds: remaining,
        phase: page.isDone ? 'hazards' : phase,
        ...(page.isDone ? {} : { cursor: page.continueCursor }),
        ...(pageSize !== undefined ? { pageSize } : {}),
      });
      return { settled: 0, more: true };
    }
    // Every Report and hazard of theirs is read: what is left nothing of theirs uses.
    const now = Date.now();
    let settled = 0;
    for (const photoId of remaining) {
      const photo = await ctx.db.get(photoId);
      if (!photo || photo.erasedAt !== undefined) continue;
      // A Report that took it since the scan began, or an access point that shows it: in use.
      if (photo.reportId !== undefined) continue;
      const onAccess = await ctx.db
        .query('accessPhotos')
        .withIndex('by_photo', (q) => q.eq('photoId', photoId))
        .first();
      if (onAccess) continue;
      if (await deletePhotoAndBlobs(ctx, photo)) {
        settled++;
        continue;
      }
      // A blob outlived the attempt: the row is the only pointer to it (the orphan sweep retries),
      // and no longer anything of its uploader's.
      await ctx.db.patch(photoId, {
        caption: undefined,
        takenAt: undefined,
        coord: undefined,
        placeOnMap: false,
        erasedAt: now,
      });
      settled++;
    }
    return { settled, more: false };
  },
});

/**
 * What an author wrote before each edit — their words too, and gone before the item is. An edit adds
 * one each time, with no cap, so they go a budget at a time; `false` while any remain.
 */
function eraseRevisions(
  ctx: MutationCtx,
  targetType: 'report' | 'post',
  targetId: string,
  budget: Budget,
): Promise<boolean> {
  return drain(
    budget,
    targetType === 'post' ? ROW_MAX.postRevision : ROW_MAX.reportRevision,
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
 * - **Its Post** loses it from `reportIds` and re-derives its album, sort key and search words; a
 *   Post left with no member is erased on its own clock, next.
 *
 * Other people's content attached to it stays theirs: comments on it (unreachable once the Report
 * is gone — `listByReport` answers `[]`), ratings and flags on it, bounties it answered (their
 * readers already skip a Report that isn't there).
 */
async function eraseReport(
  ctx: MutationCtx,
  report: Doc<'reports'>,
  photos: PhotoWork[],
  budget: Budget,
): Promise<boolean> {
  // Everything that holds its words or points at it first, a budget at a time; the row last, so a
  // pass that runs out leaves the Report whole, still due, and still findable by every step below.
  if (!(await eraseRevisions(ctx, 'report', report._id, budget))) return false;
  const joins = await drain(
    budget,
    ROW_MAX.small,
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
    budget,
    ROW_MAX.putIn,
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
    budget,
    ROW_MAX.accessAlert,
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
    budget,
    ROW_MAX.waterBodyRequest,
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
    budget,
    ROW_MAX.hazard,
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
    budget,
    ROW_MAX.photo,
    (n) =>
      ctx.db
        .query('photos')
        .withIndex('by_report', (q) => q.eq('reportId', report._id))
        .take(n),
    (photo) => ctx.db.patch(photo._id, { reportId: undefined }),
  );
  if (!linked) return false;
  if (report.activityId !== undefined) {
    const activity = await ctx.db.get(report.activityId);
    if (activity?.linkedReportId === report._id) {
      await ctx.db.patch(activity._id, { linkedReportId: undefined, promptState: 'dismissed' });
    }
  }

  await ctx.db.delete(report._id);
  // Settled after the tick, by a job that reads everything else of the uploader's.
  photos.push({ uploaderId: report.authorId, photoIds: report.photoIds });

  if (report.postId !== undefined) {
    const post = await ctx.db.get(report.postId);
    if (post) {
      await ctx.db.patch(post._id, {
        reportIds: post.reportIds.filter((id) => id !== report._id),
      });
      await syncPostPhotos(ctx, post._id);
      await refreshPostLatestSkateEnd(ctx, post._id);
      await refreshPostSearchText(ctx, post._id);
      // The Post was held while this member was stored; it may be due now.
      await refreshEraseClock(ctx, 'post', post._id);
    }
  }
  return true;
}

/** A Post: reached only once every member is erased (`lib/eraseClock` holds it until then). */
async function erasePost(ctx: MutationCtx, post: Doc<'posts'>, budget: Budget): Promise<boolean> {
  if (post.reportIds.length > 0) {
    // The clock never lets this happen; refuse rather than strand members without their Post.
    throw new ConvexError('A post is erased only after its reports');
  }
  if (!(await eraseRevisions(ctx, 'post', post._id, budget))) return false;
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
  hazard: Doc<'hazards'>,
  photos: PhotoWork[],
  budget: Budget,
): Promise<boolean> {
  // One row a person, but older rows can hold more than one: drained, never capped.
  const own = await drain(
    budget,
    ROW_MAX.small,
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
  if (hazard.originReportId !== undefined) {
    const report = await ctx.db.get(hazard.originReportId);
    if (report?.hazardIdsCreated.includes(hazard._id)) {
      await ctx.db.patch(report._id, {
        hazardIdsCreated: report.hazardIdsCreated.filter((id) => id !== hazard._id),
      });
    }
  }
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
  alert: Doc<'accessAlerts'>,
  budget: Budget,
): Promise<boolean> {
  const own = await drain(
    budget,
    ROW_MAX.small,
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
 * before `retractedAt` existed is stamped here, at this run (`stampOldRetraction`).
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
    // Sized by what this kind's rows can weigh, as the sweep's pages are.
    const page = await ctx.db.query(ERASABLE[current]).paginate({
      cursor: cursor ?? null,
      numItems: rowsFor(TICK_READ_BYTES, ROW_MAX[current], size),
    });
    let set = 0;
    let stamped = 0;
    for (const doc of page.page as ErasableDoc[]) {
      const wasStamped =
        current === 'accessAlert' &&
        (await stampOldRetraction(ctx, doc as Doc<'accessAlerts'>, now));
      if (wasStamped) stamped++;
      // Only a stamp changed the row since the page read it.
      const fresh = wasStamped ? ((await ctx.db.get(doc._id)) as ErasableDoc) : doc;
      if (withdrawnAtOf(current, fresh) === undefined || fresh.eraseAt !== undefined) continue;
      if ((await refreshEraseClock(ctx, current, doc._id, now)) !== undefined) set++;
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

/**
 * An alert its author retracted before `retractedAt` existed carries no time for its 30 days: the old
 * writer saved only the status and who retracted it, and an author's retraction left no history row
 * to recover it from. Its 30 days start at the backfill — never in the past, the rule the comment
 * backfill keeps. A moderator's retraction is not a withdrawal and is left alone. `true` if stamped.
 */
async function stampOldRetraction(
  ctx: MutationCtx,
  alert: Doc<'accessAlerts'>,
  now: number,
): Promise<boolean> {
  if (!authorRetracted(alert) || alert.retractedAt !== undefined) return false;
  await ctx.db.patch(alert._id, { retractedAt: now });
  return true;
}
