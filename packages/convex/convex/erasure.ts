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
 * while a page came back full. Erasing takes a row out of the range, so re-reading the first page
 * walks forward with no cursor; `pageSize` is the test seam for that continuation.
 */

import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { writeAudit } from './lib/audit';
import {
  ERASABLE,
  type Erasable,
  type ErasableDoc,
  refreshEraseClock,
  withdrawnAtOf,
} from './lib/eraseClock';
import { deletePhotoAndBlobs, referencedPhotoIds } from './lib/photoOrphans';
import { refreshPostLatestSkateEnd, refreshPostSearchText, syncPostPhotos } from './lib/postSync';

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
 * Photos an erased item carried, settled once the tick's erasures are done (`erasePhotos`): whether
 * one is still referenced takes a scan of everything its uploader posted, so a tick reads that once
 * per uploader, after every row of theirs it erases is gone — not once per item, which for a page of
 * one person's deletions would read their whole history a hundred times in one transaction.
 */
interface PhotoWork {
  uploaderId: Id<'profiles'>;
  photoIds: readonly Id<'photos'>[];
  /** The erased Report the photos hung from, whose back-link a kept photo loses. */
  fromReport?: Id<'reports'>;
}

type Eraser = (
  ctx: MutationCtx,
  doc: ErasableDoc,
  now: number,
  photos: PhotoWork[],
) => Promise<void>;

/**
 * Who erases each kind, in the order a tick runs them: a Post after its members (a Post is held
 * while a member is still stored), a member after the comments under it are sorted out. `null` is a
 * kind whose clock runs but nothing erases yet — the sweep never reads its range.
 *
 * **Access alerts wait on a founder call.** The alert's own doc keeps a retracted row "as the record
 * that something was claimed and withdrawn, which is what makes a pattern of bad claims visible", and
 * other skaters' votes hang off it; D248 says the author's retraction is erased at 30 days. The two
 * disagree, so the clock is set and the eraser is left to the call.
 */
const ERASERS: Record<Erasable, Eraser | null> = {
  comment: (ctx, doc, now) => eraseComment(ctx, doc as Doc<'comments'>, now),
  hazard: (ctx, doc, _now, photos) => eraseHazard(ctx, doc as Doc<'hazards'>, photos),
  report: (ctx, doc, _now, photos) => eraseReport(ctx, doc as Doc<'reports'>, photos),
  post: (ctx, doc) => erasePost(ctx, doc as Doc<'posts'>),
  contentFlag: (ctx, doc) => ctx.db.delete((doc as Doc<'contentFlags'>)._id),
  waterBodyRequest: (ctx, doc) => ctx.db.delete((doc as Doc<'waterBodyRequests'>)._id),
  accessAlert: null,
};

/** The kinds the sweep erases, in order. */
export const ERASED_KINDS = (Object.keys(ERASERS) as Erasable[]).filter((k) => ERASERS[k] !== null);

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
    let held = 0;
    let more = false;
    for (const kind of ERASED_KINDS) {
      const eraser = ERASERS[kind];
      if (!eraser) continue;
      const due = (await dueRows(ctx, kind, now, size)) as ErasableDoc[];
      if (due.length >= size) more = true;
      for (const doc of due) {
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
        await eraser(ctx, current, now, photos);
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
    // After every row they hung from is gone, so each uploader's reference scan runs once and no
    // longer counts any of this tick's erased rows.
    await erasePhotos(ctx, photos);
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
async function eraseComment(ctx: MutationCtx, comment: Doc<'comments'>, now: number) {
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
}

/**
 * Photos the tick's erased items carried: deleted with their blobs unless something else of the
 * uploader's still references them (the one rule `lib/photoOrphans` keeps for every destructive
 * path). A photo kept — still referenced, or its blob could not be deleted, or the reference scan
 * could not answer — loses its link back and, unless still referenced, everything that says anything
 * about a person. One reference scan per uploader, read after all of the tick's erasures.
 */
async function erasePhotos(ctx: MutationCtx, work: readonly PhotoWork[]) {
  const byUploader = new Map<string, Set<string> | null>();
  for (const { uploaderId, photoIds, fromReport } of work) {
    if (photoIds.length === 0) continue;
    if (!byUploader.has(uploaderId)) {
      byUploader.set(uploaderId, await referencedPhotoIds(ctx, uploaderId));
    }
    const referenced = byUploader.get(uploaderId) ?? null;
    for (const photoId of photoIds) {
      const photo = await ctx.db.get(photoId);
      if (!photo) continue;
      const unlink =
        fromReport !== undefined && photo.reportId === fromReport ? { reportId: undefined } : {};
      if (referenced?.has(photoId)) {
        if (Object.keys(unlink).length > 0) await ctx.db.patch(photoId, unlink);
        continue;
      }
      if (referenced !== null && (await deletePhotoAndBlobs(ctx, photo))) continue;
      // Kept: the scan couldn't answer, or a blob outlived the attempt. The row stays as the only
      // pointer to its blobs (the orphan sweep retries), and stops being a record of anything.
      await ctx.db.patch(photoId, {
        ...unlink,
        caption: undefined,
        takenAt: undefined,
        coord: undefined,
        placeOnMap: false,
      });
    }
  }
}

/** What an author wrote before each edit — their words too, and gone with the item. */
async function eraseRevisions(ctx: MutationCtx, targetType: 'report' | 'post', targetId: string) {
  const revisions = await ctx.db
    .query('contentRevisions')
    .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
    .take(500);
  for (const revision of revisions) await ctx.db.delete(revision._id);
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
async function eraseReport(ctx: MutationCtx, report: Doc<'reports'>, photos: PhotoWork[]) {
  for (const hazardId of report.hazardIdsCreated) {
    const hazard = await ctx.db.get(hazardId);
    if (hazard?.originReportId === report._id) {
      await ctx.db.patch(hazardId, { originReportId: undefined });
    }
  }
  if (report.activityId !== undefined) {
    const activity = await ctx.db.get(report.activityId);
    if (activity?.linkedReportId === report._id) {
      await ctx.db.patch(activity._id, { linkedReportId: undefined, promptState: 'dismissed' });
    }
  }
  // An author's alerts are a handful; bounded anyway, and only theirs can name their Report.
  const alerts = await ctx.db
    .query('accessAlerts')
    .withIndex('by_author', (q) => q.eq('createdByUserId', report.authorId))
    .take(1000);
  for (const alert of alerts) {
    if (alert.reportId === report._id) await ctx.db.patch(alert._id, { reportId: undefined });
  }
  const joins = await ctx.db
    .query('reportSubAreas')
    .withIndex('by_report', (q) => q.eq('reportId', report._id))
    .take(100);
  for (const join of joins) await ctx.db.delete(join._id);
  await eraseRevisions(ctx, 'report', report._id);

  await ctx.db.delete(report._id);
  // Settled at the end of the tick, after the row is gone, so the reference scan no longer counts
  // this Report's own list.
  photos.push({ uploaderId: report.authorId, photoIds: report.photoIds, fromReport: report._id });

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
}

/** A Post: reached only once every member is erased (`lib/eraseClock` holds it until then). */
async function erasePost(ctx: MutationCtx, post: Doc<'posts'>) {
  if (post.reportIds.length > 0) {
    // The clock never lets this happen; refuse rather than strand members without their Post.
    throw new ConvexError('A post is erased only after its reports');
  }
  await eraseRevisions(ctx, 'post', post._id);
  await ctx.db.delete(post._id);
}

/**
 * A hazard its author withdrew (no other skater had said it was there): the row, its photos, and the
 * author's own vote on it. Other skaters' votes on it — only ever "it healed" or "it never existed",
 * or it could not have been withdrawn — stay theirs. The Report it was drawn in, if that still
 * stands, stops listing it.
 */
async function eraseHazard(ctx: MutationCtx, hazard: Doc<'hazards'>, photos: PhotoWork[]) {
  const own = await ctx.db
    .query('hazardConfirmations')
    .withIndex('by_hazard_and_user', (q) =>
      q.eq('hazardId', hazard._id).eq('userId', hazard.createdByUserId),
    )
    .take(10);
  for (const vote of own) await ctx.db.delete(vote._id);
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
}

// ── The clocks' backfill ───────────────────────────────────────────────────────────────────────

const BACKFILL_PAGE = 200;

/**
 * Give every withdrawn row its clock (D248) — content its author deleted before the clock existed.
 * One kind per call, paged with a cursor (a row keeps its place, so the range does not shrink), then
 * the next kind. Idempotent: a running clock is never moved. Where the deletion time is unknown the
 * Part A backfill stamped it at its own run, so the 30 days start there.
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
    const page = await ctx.db
      .query(ERASABLE[current])
      .paginate({ cursor: cursor ?? null, numItems: size });
    let set = 0;
    for (const doc of page.page as ErasableDoc[]) {
      if (withdrawnAtOf(current, doc) === undefined || doc.eraseAt !== undefined) continue;
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
    return { kind: current, set, more: next !== undefined };
  },
});
