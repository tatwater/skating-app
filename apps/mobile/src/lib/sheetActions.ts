/**
 * What the sheet's two buttons do (A10-3): *Save draft* holds the Post on the phone; *Post*
 * queues it and flushes at once if there is signal, so it never fails for lack of bars (D187's
 * "one Post button, and a draft"). An edit of a published Report saves through `reports.update`
 * and `posts.update` directly — edits are not queued, as before (A06f).
 *
 * Native glue over the pure model (core's `postSheet`) and the queue (`draftStore`, `flushService`);
 * every decision is made in core or the model, and this only carries it out.
 */

import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  confirmableVerdict,
  createQueuedConfirmation,
  type DraftPhoto,
  flushErrorMessage,
  type PostSheet,
  photoUploadCoord,
  type SheetReport,
  selectedValues,
  toPostDraft,
  toReportInput,
  updateReport,
} from '@skating/core';
import { randomUUID } from 'expo-crypto';
import { uploadToStorage } from '../components/photoPipeline';
import { convex } from './convex';
import { isPersistedUri, persistDraftPhoto } from './draftPhotos';
import { getDraft, saveDraft, saveHazardItem } from './draftStore';
import { flushDrafts, isDraftFlushing, takeFlushResult } from './flushService';
import { updateSheet } from './sheetStore';

/** Copy each picked photo out of the picker cache into the drafts dir, once. */
async function persistPhotos(draftId: string, report: SheetReport): Promise<DraftPhoto[]> {
  return Promise.all(
    report.photos.map(async (p) => ({
      ...p,
      fullUri: isPersistedUri(p.fullUri)
        ? p.fullUri
        : await persistDraftPhoto(p.fullUri, `${draftId}-${p.id}-full.jpg`),
      thumbUri: isPersistedUri(p.thumbUri)
        ? p.thumbUri
        : await persistDraftPhoto(p.thumbUri, `${draftId}-${p.id}-thumb.jpg`),
    })),
  );
}

async function withPersistedPhotos(post: PostSheet): Promise<PostSheet> {
  const reports = await Promise.all(
    post.reports.map(async (r) => ({ ...r, photos: await persistPhotos(post.draftId, r) })),
  );
  return { ...post, reports };
}

/** The sentence a save over a draft that is sending right now refuses with. */
export const DRAFT_SYNCING_MESSAGE = 'This post is sending right now — try again in a moment.';

/**
 * Refuse to write over a draft the flush is working on. The flush's checkpoint writes would clobber
 * the edit and its success would delete the row; the idempotent create then re-serves the pre-edit
 * Post, and the change is lost without a word. Checked synchronously right before `saveDraft`, with
 * no `await` in between, so a drain cannot claim the id between the check and the write (the guard
 * the pre-sheet form kept; see `flushService`'s `flushingIds`).
 */
function assertNotFlushing(post: PostSheet): void {
  if (isDraftFlushing(post.draftId)) throw new Error(DRAFT_SYNCING_MESSAGE);
}

/** Hold the sheet as a draft on the phone. Returns the sheet with its photos on durable paths. */
export async function saveSheetAsDraft(post: PostSheet, now: number): Promise<PostSheet> {
  assertNotFlushing(post);
  const persisted = await withPersistedPhotos(post);
  assertNotFlushing(post);
  saveDraft(toPostDraft(persisted, 'draft', now, getDraft(post.draftId)));
  return { ...persisted, dirty: false };
}

/**
 * The tick-through's answers (§6.2 / §6 (d)) as confirmation votes through the hazard queue —
 * `via: 'report_flow'`, observed at the end time — filed at Post, never before. *Didn't look*
 * files nothing. One row per hazard per user server-side, so a re-post of a reopened draft
 * refreshes rather than double-counts.
 */
export function queueConfirmations(post: PostSheet, now: number): number {
  let filed = 0;
  for (const r of post.reports) {
    const [end] = selectedValues(r.sheet, 'endTime');
    for (const [hazardId, verdict] of Object.entries(r.sheet.scalars.passedVerdicts)) {
      const v = confirmableVerdict(verdict);
      if (v === null) continue;
      saveHazardItem(
        createQueuedConfirmation({
          id: randomUUID(),
          now,
          hazardId,
          verdict: v,
          via: 'report_flow',
          ...(end !== undefined ? { observedAt: end.ms } : {}),
        }),
      );
      filed++;
    }
  }
  return filed;
}

export type PostOutcome =
  | { kind: 'posted'; reportId: string }
  | { kind: 'queued' }
  | { kind: 'refused'; message: string };

/**
 * *Post*: queue the Post and flush now. With signal the result is the live Report's id; without,
 * the draft waits on the *Waiting to send* screen. A server refusal at flush parks the draft with
 * the server's sentence, which is returned so the sheet can show it in place.
 */
export async function postSheet(post: PostSheet, now: number): Promise<PostOutcome> {
  if (isDraftFlushing(post.draftId)) return { kind: 'refused', message: DRAFT_SYNCING_MESSAGE };
  const persisted = await withPersistedPhotos(post);
  if (isDraftFlushing(post.draftId)) return { kind: 'refused', message: DRAFT_SYNCING_MESSAGE };
  saveDraft(toPostDraft(persisted, 'pending', now, getDraft(post.draftId)));
  queueConfirmations(persisted, now);
  await flushDrafts();
  const result = takeFlushResult(post.draftId);
  if (result?.ok) {
    const reportId = result.reportIds[0];
    return reportId !== undefined ? { kind: 'posted', reportId } : { kind: 'queued' };
  }
  if (result && !result.ok && result.kind === 'permanent') {
    return { kind: 'refused', message: result.message };
  }
  return { kind: 'queued' };
}

async function uploadBlob(uri: string): Promise<string> {
  const url = await convex.mutation(api.photos.generateUploadUrl, {});
  return uploadToStorage(url, uri);
}

/**
 * Upload one picked photo and create its row — the edit path's inline upload (no queue), with the
 * queue's checkpoints: each blob and the row are written onto the open sheet's photo the moment
 * they land, so a *Save changes* retried after a partial failure re-sends only what is missing. A
 * blob uploaded twice is a leak nothing can reclaim — a storage id no photo row names is invisible
 * to `sweepOrphanPhotos` — while a row an abandoned edit never attaches is the sweep's to collect.
 */
async function uploadPhoto(
  p: DraftPhoto,
  checkpoint: (patch: Partial<DraftPhoto>) => void,
): Promise<Id<'photos'>> {
  if (p.photoId !== undefined) return p.photoId as Id<'photos'>;
  const landed = async (uri: string, field: 'fullStorageId' | 'thumbStorageId') => {
    const id = await uploadBlob(uri);
    checkpoint({ [field]: id });
    return id;
  };
  const [storageId, thumbStorageId] = await Promise.all([
    p.fullStorageId ?? landed(p.fullUri, 'fullStorageId'),
    p.thumbStorageId ?? landed(p.thumbUri, 'thumbStorageId'),
  ]);
  const photoId = await convex.mutation(api.photos.create, {
    storageId: storageId as Id<'_storage'>,
    thumbStorageId: thumbStorageId as Id<'_storage'>,
    placeOnMap: p.placeOnMap,
    coord: photoUploadCoord(p.placeOnMap, p.coord),
  });
  checkpoint({ photoId });
  return photoId;
}

/** Write a landed upload onto the open sheet's photo — the sheet's doing, so not a dirty edit. */
function checkpointPhoto(reportId: string, photoId: string, patch: Partial<DraftPhoto>): void {
  updateSheet((sheet) =>
    updateReport(
      sheet,
      reportId,
      (r) => ({ ...r, photos: r.photos.map((p) => (p.id === photoId ? { ...p, ...patch } : p)) }),
      { quiet: true },
    ),
  );
}

/**
 * *Save changes* on the edit door: the Report's whole content block (last-write-wins, so the kept
 * photos lead and the new uploads follow) and the Post's words when it has a Post, in one
 * `reports.update`. Online only — an edit is not queued. Throws with the server's sentence on
 * refusal.
 */
export async function saveSheetEdit(post: PostSheet, now: number): Promise<string> {
  if (post.mode.kind !== 'edit') throw new Error('Not an edit');
  // Core's model holds ids as plain strings; the cast is this surface's wire, like the photos'.
  const reportId = post.mode.reportId as Id<'reports'>;
  const report = post.reports[0];
  if (!report) throw new Error('Nothing to save');
  try {
    const uploaded = await Promise.all(
      report.photos.map((p) => uploadPhoto(p, (patch) => checkpointPhoto(report.id, p.id, patch))),
    );
    const { waterBodyId: _body, ...content } = toReportInput(report.sheet);
    // One mutation for both halves — the Report's content and its Post's words — so a refusal of
    // either lands neither, and the sheet's "couldn't save" is always true of the whole edit.
    await convex.mutation(api.reports.update, {
      ...content,
      reportId,
      photoIds: [...(report.keptPhotoIds as Id<'photos'>[]), ...uploaded],
      ...(post.mode.postId !== undefined
        ? {
            post: {
              ...(post.title.trim() ? { title: post.title.trim() } : {}),
              ...(post.body.trim() ? { body: post.body.trim() } : {}),
            },
          }
        : {}),
    });
    queueConfirmations(post, now);
    void flushDrafts();
    return reportId;
  } catch (error) {
    throw new Error(flushErrorMessage(error));
  }
}
