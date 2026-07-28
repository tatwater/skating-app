/**
 * The determinate orphan check, for an uploader the one-shot scan can't answer (PR #30 review).
 *
 * **The hole this fills.** `lib/photoOrphans.referencedPhotoIds` answers "which of this person's photos
 * are referenced?" by reading their reports and hazards in a single transaction, capped at
 * `REFERENCE_SCAN_CAP`. Hitting that cap returns `null` — *couldn't determine* — and every caller
 * correctly treats that as **keep the photo**, because deleting a referenced one tears an
 * unrecoverable hole in a public report.
 *
 * What nothing did was ever come back. The deletion sweep kept the page and advanced its cursor; the
 * daily orphan cron re-derived the same `null` and skipped again, every day, forever. For an uploader
 * past the cap that meant their abandoned images were retained permanently, with no automated path to
 * reclaim them — and after their account finalized, retained image bytes belonging to a person who had
 * asked to be erased, which is the strongest form of the photo-retention problem rather than a storage
 * nuisance.
 *
 * **Why a mark instead of a bigger cap.** The cap is not arbitrary: it stands in for a transaction's
 * read budget, so raising it just moves the wall. The only way to be *complete* is to stop trying to
 * hold the answer in one transaction. So the question is inverted and spread across as many
 * transactions as it needs:
 *
 * 1. **`mark`** — flag every photo of theirs that is old enough to be a candidate.
 * 2. **`reports`**, then **`hazards`** — page through everything that could reference a photo and clear
 *    the flag on each one it names.
 * 3. **`sweep`** — whatever is still flagged was named by nothing. Delete it.
 *
 * Each phase pages, each page is its own transaction, and the job re-schedules itself — so it is bounded
 * per transaction and unbounded in total, which is exactly the property the one-shot scan lacks. The
 * soundness argument is inherited unchanged from `lib/photoOrphans`: `assertOwnedPhotos` means only the
 * uploader's *own* reports and hazards can ever reference their photos, so phases 2–3 are complete.
 *
 * **It is strictly more conservative than the fast path**, which matters because this is a delete path.
 * A photo is removed only if a *complete* pass over every possible referrer named nothing, and only if
 * it is past `PHOTO_ORPHAN_GRACE_MS`. The fast path deletes on the same evidence gathered in one read.
 *
 * **Who starts it:** `storageHygiene.sweepOrphanPhotos`, when its per-uploader scan comes back `null`.
 * That is the automated path, and it is the right trigger for both cases — a live account that is
 * simply prolific, and a tombstoned one whose reports survive it (deletion keeps the observation, so a
 * departed account's report count is exactly as capped as it was in life). The job needs nothing but an
 * `uploaderId`, so it works perfectly well after the profile has become a tombstone and
 * `deletionRequestedAt` is gone.
 */

import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { deletePhotoAndBlobs, PHOTO_ORPHAN_GRACE_MS } from './lib/photoOrphans';

/**
 * The phases, in the order they must run. `mark` before the two clearing phases before `sweep` is not a
 * style choice: a flag cleared before it is set would make a referenced photo look unreferenced, which
 * is the one mistake this whole file exists to avoid.
 */
const PHASES = ['mark', 'reports', 'hazards', 'sweep'] as const;
type Phase = (typeof PHASES)[number];

/** Photos touched per page. */
const PHOTO_PAGE = 100;

/**
 * Referrers per page — deliberately smaller. Each report or hazard costs an extra `get` + `patch` for
 * every photo it names, so a page here is worth several times its length in reads.
 */
const REFERRER_PAGE = 50;

interface PhaseResult {
  more: boolean;
  cursor?: string;
  /** Rows the phase acted on — surfaced so a test or an operator can watch it converge. */
  touched?: number;
}

export const reconcileUploaderPhotos = internalMutation({
  args: {
    uploaderId: v.id('profiles'),
    phase: v.optional(v.union(...PHASES.map((p) => v.literal(p)))),
    cursor: v.optional(v.string()),
    /** Test seam for the continuation path, clamped to the real page sizes. */
    pageSize: v.optional(v.number()),
  },
  // Defaults to the *first* phase rather than naming one: an entry point that starts at `sweep` would
  // delete against marks nobody set this run.
  handler: async (ctx, { uploaderId, phase = PHASES[0], cursor, pageSize }) => {
    const result = await runPhase(ctx, uploaderId, phase, cursor, pageSize);

    if (result.more) {
      await ctx.scheduler.runAfter(0, internal.photoReconcile.reconcileUploaderPhotos, {
        uploaderId,
        phase,
        ...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
        ...(pageSize !== undefined ? { pageSize } : {}),
      });
      return { phase, done: false, touched: result.touched ?? 0 };
    }

    const next = PHASES[PHASES.indexOf(phase) + 1];
    if (next !== undefined) {
      await ctx.scheduler.runAfter(0, internal.photoReconcile.reconcileUploaderPhotos, {
        uploaderId,
        phase: next,
        ...(pageSize !== undefined ? { pageSize } : {}),
      });
      return { phase, done: true, next, touched: result.touched ?? 0 };
    }
    return { phase, done: true, next: null, touched: result.touched ?? 0 };
  },
});

async function runPhase(
  ctx: MutationCtx,
  uploaderId: Id<'profiles'>,
  phase: Phase,
  cursor: string | undefined,
  pageSize: number | undefined,
): Promise<PhaseResult> {
  const now = Date.now();
  const cutoff = now - PHOTO_ORPHAN_GRACE_MS;
  const photoPage = clamp(pageSize, PHOTO_PAGE);
  const referrerPage = clamp(pageSize, REFERRER_PAGE);

  switch (phase) {
    case 'mark':
      return markCandidates(ctx, uploaderId, cursor, photoPage, cutoff);
    case 'reports':
      return clearFromReports(ctx, uploaderId, cursor, referrerPage);
    case 'hazards':
      return clearFromHazards(ctx, uploaderId, cursor, referrerPage);
    case 'sweep':
      return sweepStillMarked(ctx, uploaderId, cursor, photoPage, cutoff);
  }
}

function clamp(requested: number | undefined, ceiling: number): number {
  return Math.min(Math.max(requested ?? ceiling, 1), ceiling);
}

/**
 * Phase 1 — flag every candidate.
 *
 * Photos still inside the orphan grace are deliberately **not** marked. A photo uploaded minutes ago is
 * mid-submission rather than abandoned (the form uploads before `reports.create`, and an offline draft
 * can flush a day later), so it isn't a candidate this run and doesn't need a flag set only to be
 * cleared again.
 */
async function markCandidates(
  ctx: MutationCtx,
  uploaderId: Id<'profiles'>,
  cursor: string | undefined,
  size: number,
  cutoff: number,
): Promise<PhaseResult> {
  const page = await ctx.db
    .query('photos')
    .withIndex('by_uploader', (q) => q.eq('uploaderId', uploaderId))
    .paginate({ cursor: cursor ?? null, numItems: size });

  let touched = 0;
  for (const photo of page.page) {
    if (photo.createdAt >= cutoff) continue; // mid-submission, not abandoned
    if (photo.orphanCandidate === true) continue; // idempotent re-run
    await ctx.db.patch(photo._id, { orphanCandidate: true });
    touched++;
  }
  return { ...continuation(page), touched };
}

/** Phase 2 — anything a report names is referenced, so its mark comes off. */
async function clearFromReports(
  ctx: MutationCtx,
  uploaderId: Id<'profiles'>,
  cursor: string | undefined,
  size: number,
): Promise<PhaseResult> {
  const page = await ctx.db
    .query('reports')
    .withIndex('by_author', (q) => q.eq('authorId', uploaderId))
    .paginate({ cursor: cursor ?? null, numItems: size });

  let touched = 0;
  for (const report of page.page) {
    for (const photoId of report.photoIds) {
      if (await clearMark(ctx, photoId, uploaderId)) touched++;
    }
  }
  return { ...continuation(page), touched };
}

/** Phase 3 — the same, for hazards. */
async function clearFromHazards(
  ctx: MutationCtx,
  uploaderId: Id<'profiles'>,
  cursor: string | undefined,
  size: number,
): Promise<PhaseResult> {
  const page = await ctx.db
    .query('hazards')
    .withIndex('by_author_and_water_body', (q) => q.eq('createdByUserId', uploaderId))
    .paginate({ cursor: cursor ?? null, numItems: size });

  let touched = 0;
  for (const hazard of page.page) {
    for (const photoId of hazard.photoIds) {
      if (await clearMark(ctx, photoId, uploaderId)) touched++;
    }
  }
  return { ...continuation(page), touched };
}

/**
 * Take the mark off one photo, reporting whether it did anything.
 *
 * The `uploaderId` check is defensive rather than load-bearing — `assertOwnedPhotos` already means a
 * report can only carry its own author's photos. It costs one comparison and it means a future write
 * path that relaxed that rule would fail closed here (a photo left marked, and so deleted) rather than
 * silently clearing a mark this run didn't set.
 */
async function clearMark(
  ctx: MutationCtx,
  photoId: Id<'photos'>,
  uploaderId: Id<'profiles'>,
): Promise<boolean> {
  const photo = await ctx.db.get(photoId);
  if (!photo || photo.uploaderId !== uploaderId) return false;
  if (photo.orphanCandidate !== true) return false;
  await ctx.db.patch(photoId, { orphanCandidate: undefined });
  return true;
}

/**
 * Phase 4 — whatever is still marked was named by nothing, across a complete pass over every row that
 * could have named it. That is the guarantee the one-shot scan can't make, and it's what earns the
 * delete.
 *
 * A photo whose blob survives the attempt keeps its row (`lib/photoOrphans` explains why the row is the
 * only pointer to those blobs) and is **unmarked**, so the next run re-evaluates it from scratch rather
 * than inheriting a stale verdict.
 */
async function sweepStillMarked(
  ctx: MutationCtx,
  uploaderId: Id<'profiles'>,
  cursor: string | undefined,
  size: number,
  cutoff: number,
): Promise<PhaseResult> {
  const page = await ctx.db
    .query('photos')
    .withIndex('by_uploader', (q) => q.eq('uploaderId', uploaderId))
    .paginate({ cursor: cursor ?? null, numItems: size });

  let touched = 0;
  for (const photo of page.page) {
    if (photo.orphanCandidate !== true) continue;
    // Crossed into the grace since `mark` — vanishingly unlikely, but the flag shouldn't outlive the
    // run that set it.
    if (photo.createdAt >= cutoff) {
      await ctx.db.patch(photo._id, { orphanCandidate: undefined });
      continue;
    }
    if (await deletePhotoAndBlobs(ctx, photo)) {
      touched++;
      continue;
    }
    await ctx.db.patch(photo._id, { orphanCandidate: undefined });
  }
  return { ...continuation(page), touched };
}

/** `page.isDone` in the shape the phases return. */
function continuation(page: { isDone: boolean; continueCursor: string }): {
  more: boolean;
  cursor?: string;
} {
  return page.isDone ? { more: false } : { more: true, cursor: page.continueCursor };
}
