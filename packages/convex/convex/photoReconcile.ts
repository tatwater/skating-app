/**
 * The determinate photo check, for an uploader the one-shot scan can't answer (PR #30 review).
 *
 * Two questions run on this machine, selected by `mode` — see {@link MODES}. `orphan` asks "is this
 * referenced by anything?"; `season_expiry` asks "is this departed skater's photo referenced by a
 * *hazard*?" (D66/N5a). Everything below describes the shared mechanism; the difference between them
 * is one declarative table.
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
 * **Who starts it:** `storageHygiene.sweepOrphanPhotos` in `orphan` mode, and
 * `storageHygiene.expireDepartedPhotos` in `season_expiry` mode — each when its own per-uploader scan
 * comes back `null`. That is the automated path, and it is the right trigger for every case: a live
 * account that is simply prolific, and a tombstoned one whose reports survive it (deletion keeps the
 * observation, so a departed account's report count is exactly as capped as it was in life). The job
 * needs nothing but an `uploaderId`, so it works perfectly well after the profile has become a
 * tombstone and `deletionRequestedAt` is gone.
 *
 * **The escalating caller marks the account and walks away**, which is the half that took two passes to
 * get right. A capped scan that is merely *retried* is not just wasted work: the account it belongs to
 * never leaves its cron's bounded page, so it occupies a slot forever and the tombstones behind it are
 * never reached. Escalate-and-mark makes this job the owner, and this job's last phase writes the
 * marker itself — the only point at which the account has actually been answered.
 */

import { seasonOf, seasonStartMs } from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { deletePhotoAndBlobs, PHOTO_ORPHAN_GRACE_MS } from './lib/photoOrphans';

/**
 * The phases, in the order they must run. `mark` before the clearing phases before `sweep` is not a
 * style choice: a flag cleared before it is set would make a referenced photo look unreferenced, which
 * is the one mistake this whole file exists to avoid.
 */
const PHASES = ['mark', 'reports', 'hazards', 'sweep'] as const;
type Phase = (typeof PHASES)[number];

/**
 * **Two questions, one machine** (D66/N5a).
 *
 * `orphan` asks *"is this photo referenced by anything?"* — the original job. `season_expiry` asks
 * *"is this departed skater's photo referenced by a **hazard**?"*, because D66 keeps hazard photos
 * (a picture of an open lead is worth more than any sentence describing one) and expires the rest at
 * the boundary of the season they were taken in.
 *
 * A mode rather than a second file, for the reason `lib/photoOrphans` gives for existing at all: two
 * destructive passes over the same rows must agree exactly on the paging, the marking and the
 * fail-safe, and a copy would drift. What differs between them is declared here and nowhere else —
 * which phases run, which flag they use, which timestamp decides a candidate, and what "too new"
 * means.
 *
 * The `season_expiry` phase list omits **`reports`** on purpose, and that omission *is* the policy:
 * a surviving report must not protect a departed skater's photo. Deleting the phase is how you say
 * so; adding it back silently reverts D66.
 */
const MODES = {
  orphan: {
    phases: PHASES,
    mark: 'orphanCandidate',
    /** Uploaded inside the grace window ⇒ mid-submission, not abandoned. */
    tooNew: (photo: Doc<'photos'>, now: number) => photo.createdAt >= now - PHOTO_ORPHAN_GRACE_MS,
  },
  season_expiry: {
    phases: ['mark', 'hazards', 'sweep'],
    mark: 'seasonExpiryCandidate',
    /**
     * From the season still running ⇒ not due yet. `takenAt` where the skater kept EXIF (D42), else
     * the upload: a picture taken in February and uploaded in July belongs to the winter it shows.
     */
    tooNew: (photo: Doc<'photos'>, now: number) =>
      (photo.takenAt ?? photo.createdAt) >= seasonStartMs(seasonOf(now)),
  },
} as const satisfies Record<string, ReconcileMode>;

interface ReconcileMode {
  phases: readonly Phase[];
  mark: 'orphanCandidate' | 'seasonExpiryCandidate';
  tooNew: (photo: Doc<'photos'>, now: number) => boolean;
}

type ModeName = keyof typeof MODES;

/**
 * How long a staged run may go unheard-from before another may take it over.
 *
 * Generous, because the run is *supposed* to take many transactions and a slow one must not be
 * stolen mid-flight — every call refreshes the lease, so this bounds the gap between phases rather
 * than the whole run. A day without a single phase completing means the chain is dead, not slow.
 */
export const PHOTO_RECONCILE_LEASE_MS = 24 * 60 * 60 * 1000;

/**
 * Take ownership of an uploader's photo reconciliation, or decline because someone already has it.
 *
 * **The escalating caller claims; only the finishing run releases.** That ordering is the whole point:
 * an escalation that marked the account complete would be claiming the work was *done* at the moment
 * it was merely *scheduled*, so a job that died left the account excluded from every later sweep with
 * its photos undeleted — permanently, since nothing would look at it again until the next season
 * boundary at best. Now a dead run simply stops refreshing, the lease goes stale, and the next daily
 * tick picks it up.
 *
 * A stale lease is taken over rather than respected, because the alternative to a wrong retry here is
 * no retry at all.
 */
export async function claimPhotoReconcile(
  ctx: MutationCtx,
  uploaderId: Id<'profiles'>,
  now: number,
): Promise<boolean> {
  const owner = await ctx.db.get(uploaderId);
  if (!owner) return false;
  const held = owner.photoReconcileStartedAt;
  if (held !== undefined && now - held < PHOTO_RECONCILE_LEASE_MS) return false;
  await ctx.db.patch(uploaderId, { photoReconcileStartedAt: now });
  return true;
}

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
    /** Which question this run is answering — see {@link MODES}. Absent ⇒ the orphan check. */
    mode: v.optional(v.union(...(Object.keys(MODES) as ModeName[]).map((m) => v.literal(m)))),
    /** Test seam for the continuation path, clamped to the real page sizes. */
    pageSize: v.optional(v.number()),
  },
  // Defaults to the *first* phase rather than naming one: an entry point that starts at `sweep` would
  // delete against marks nobody set this run.
  handler: async (ctx, { uploaderId, phase, cursor, mode = 'orphan', pageSize }) => {
    // Widened deliberately: `as const` narrows each mode's phase list to its own tuple, which would
    // make "is this phase part of this mode?" a compile error instead of the runtime check it has to be.
    const config: ReconcileMode = MODES[mode];
    const phases: readonly Phase[] = config.phases;
    const current = phase ?? phases[0];
    if (current === undefined || !phases.includes(current)) {
      // A phase this mode doesn't run — only reachable by hand, and silently doing nothing would look
      // like a completed pass.
      throw new Error(`photoReconcile: phase ${String(phase)} is not part of mode ${mode}`);
    }

    // A departed-photo run must not outlive the tombstone that justified it. If the deletion was
    // cancelled mid-run the account is ordinary again, and an ordinary account's photos are on no
    // clock at all — aging never removes anything (D62 second amendment). Checked every call rather
    // than at entry, because the phases are separate transactions with real time between them.
    if (mode === 'season_expiry') {
      const owner = await ctx.db.get(uploaderId);
      if (owner?.status !== 'deleted') {
        // Release on the way out: an abandoned run holding a lease would block the *next* legitimate
        // one for a day, for no reason.
        if (owner) await ctx.db.patch(uploaderId, { photoReconcileStartedAt: undefined });
        return { phase: current, mode, done: true, next: null, touched: 0, abandoned: true };
      }
    }

    // Refresh the lease on every call, so a long but healthy run is never mistaken for a dead one.
    // The lease bounds the gap *between phases*, not the run — a chain that hasn't completed a single
    // transaction in a day has stopped, however much work it had left.
    await ctx.db.patch(uploaderId, { photoReconcileStartedAt: Date.now() });

    const result = await runPhase(ctx, uploaderId, current, cursor, pageSize, config);

    if (result.more) {
      await ctx.scheduler.runAfter(0, internal.photoReconcile.reconcileUploaderPhotos, {
        uploaderId,
        phase: current,
        mode,
        ...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
        ...(pageSize !== undefined ? { pageSize } : {}),
      });
      return { phase: current, mode, done: false, touched: result.touched ?? 0 };
    }

    const next = phases[phases.indexOf(current) + 1];
    if (next !== undefined) {
      await ctx.scheduler.runAfter(0, internal.photoReconcile.reconcileUploaderPhotos, {
        uploaderId,
        phase: next,
        mode,
        ...(pageSize !== undefined ? { pageSize } : {}),
      });
      return { phase: current, mode, done: true, next, touched: result.touched ?? 0 };
    }

    // **Finished — the only honest place for the marker, and the only place that releases the lease.**
    // Everything before this point is work in progress; stamping "expired for this season" at the
    // moment the job was merely *scheduled* is what made a failed run into permanent retention.
    await ctx.db.patch(uploaderId, {
      photoReconcileStartedAt: undefined,
      ...(mode === 'season_expiry' ? { photosExpiredForSeason: seasonOf(Date.now()) } : {}),
    });
    return { phase: current, mode, done: true, next: null, touched: result.touched ?? 0 };
  },
});

async function runPhase(
  ctx: MutationCtx,
  uploaderId: Id<'profiles'>,
  phase: Phase,
  cursor: string | undefined,
  pageSize: number | undefined,
  mode: ReconcileMode,
): Promise<PhaseResult> {
  const now = Date.now();
  const photoPage = clamp(pageSize, PHOTO_PAGE);
  const referrerPage = clamp(pageSize, REFERRER_PAGE);

  switch (phase) {
    case 'mark':
      return markCandidates(ctx, uploaderId, cursor, photoPage, now, mode);
    case 'reports':
      return clearFromReports(ctx, uploaderId, cursor, referrerPage, mode);
    case 'hazards':
      return clearFromHazards(ctx, uploaderId, cursor, referrerPage, mode);
    case 'sweep':
      return sweepStillMarked(ctx, uploaderId, cursor, photoPage, now, mode);
  }
}

function clamp(requested: number | undefined, ceiling: number): number {
  return Math.min(Math.max(requested ?? ceiling, 1), ceiling);
}

/**
 * Phase 1 — flag every candidate.
 *
 * Photos the mode calls too new are deliberately **not** marked: in `orphan` mode one uploaded minutes
 * ago is mid-submission rather than abandoned (the form uploads before `reports.create`, and an offline
 * draft can flush a day later); in `season_expiry` mode one from the season still running isn't due
 * yet. Either way it isn't a candidate this run and doesn't need a flag set only to be cleared again.
 */
async function markCandidates(
  ctx: MutationCtx,
  uploaderId: Id<'profiles'>,
  cursor: string | undefined,
  size: number,
  now: number,
  mode: ReconcileMode,
): Promise<PhaseResult> {
  const page = await ctx.db
    .query('photos')
    .withIndex('by_uploader', (q) => q.eq('uploaderId', uploaderId))
    .paginate({ cursor: cursor ?? null, numItems: size });

  let touched = 0;
  for (const photo of page.page) {
    if (mode.tooNew(photo, now)) continue;
    if (photo[mode.mark] === true) continue; // idempotent re-run
    await ctx.db.patch(photo._id, { [mode.mark]: true });
    touched++;
  }
  return { ...continuation(page), touched };
}

/**
 * Phase 2 — anything a report names is referenced, so its mark comes off.
 *
 * **`orphan` mode only.** `season_expiry` deliberately omits this phase: under D66 a surviving report
 * does *not* protect a departed skater's photo, which is the whole content of the rule.
 */
async function clearFromReports(
  ctx: MutationCtx,
  uploaderId: Id<'profiles'>,
  cursor: string | undefined,
  size: number,
  mode: ReconcileMode,
): Promise<PhaseResult> {
  const page = await ctx.db
    .query('reports')
    .withIndex('by_author', (q) => q.eq('authorId', uploaderId))
    .paginate({ cursor: cursor ?? null, numItems: size });

  let touched = 0;
  for (const report of page.page) {
    for (const photoId of report.photoIds) {
      if (await clearMark(ctx, photoId, uploaderId, mode)) touched++;
    }
  }
  return { ...continuation(page), touched };
}

/** Phase 3 — the same, for hazards. The **only** clearing phase `season_expiry` runs. */
async function clearFromHazards(
  ctx: MutationCtx,
  uploaderId: Id<'profiles'>,
  cursor: string | undefined,
  size: number,
  mode: ReconcileMode,
): Promise<PhaseResult> {
  const page = await ctx.db
    .query('hazards')
    .withIndex('by_author_and_water_body', (q) => q.eq('createdByUserId', uploaderId))
    .paginate({ cursor: cursor ?? null, numItems: size });

  let touched = 0;
  for (const hazard of page.page) {
    for (const photoId of hazard.photoIds) {
      if (await clearMark(ctx, photoId, uploaderId, mode)) touched++;
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
  mode: ReconcileMode,
): Promise<boolean> {
  const photo = await ctx.db.get(photoId);
  if (!photo || photo.uploaderId !== uploaderId) return false;
  if (photo[mode.mark] !== true) return false;
  await ctx.db.patch(photoId, { [mode.mark]: undefined });
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
  now: number,
  mode: ReconcileMode,
): Promise<PhaseResult> {
  const page = await ctx.db
    .query('photos')
    .withIndex('by_uploader', (q) => q.eq('uploaderId', uploaderId))
    .paginate({ cursor: cursor ?? null, numItems: size });

  let touched = 0;
  for (const photo of page.page) {
    if (photo[mode.mark] !== true) continue;
    // Became too new since `mark` — vanishingly unlikely, but the flag shouldn't outlive the run that
    // set it.
    if (mode.tooNew(photo, now)) {
      await ctx.db.patch(photo._id, { [mode.mark]: undefined });
      continue;
    }
    if (await deletePhotoAndBlobs(ctx, photo)) {
      touched++;
      continue;
    }
    await ctx.db.patch(photo._id, { [mode.mark]: undefined });
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
