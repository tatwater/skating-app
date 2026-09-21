/**
 * What the sheet's two buttons do (A10-3): *Save draft* holds the Post on the phone; *Post*
 * queues it and flushes at once if there is signal, so it never fails for lack of bars (D187's
 * "one Post button, and a draft"). An edit of a published Report saves through `reports.update`
 * and `posts.update` directly — edits are not queued, as before (A06f).
 *
 * Native glue over the pure model (`sheetModel.ts`) and the queue (`draftStore`, `flushService`);
 * every decision is made in core or the model, and this only carries it out.
 */

import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  confirmableVerdict,
  createQueuedConfirmation,
  type DraftPhoto,
  flushErrorMessage,
  photoUploadCoord,
  selectedValues,
  toReportInput,
} from '@skating/core';
import { randomUUID } from 'expo-crypto';
import { uploadToStorage } from '../components/photoPipeline';
import { convex } from './convex';
import { isPersistedUri, persistDraftPhoto } from './draftPhotos';
import { getDraft, saveDraft, saveHazardItem } from './draftStore';
import { flushDrafts, takeFlushResult } from './flushService';
import { type PostSheet, type SheetReport, toPostDraft } from './sheetModel';

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

/** Hold the sheet as a draft on the phone. Returns the sheet with its photos on durable paths. */
export async function saveSheetAsDraft(post: PostSheet, now: number): Promise<PostSheet> {
  const persisted = await withPersistedPhotos(post);
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
  const persisted = await withPersistedPhotos(post);
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

/** Upload one picked photo and create its row — the edit path's inline upload (no queue). */
async function uploadPhoto(p: DraftPhoto): Promise<Id<'photos'>> {
  if (p.photoId !== undefined) return p.photoId as Id<'photos'>;
  const [storageId, thumbStorageId] = await Promise.all(
    [p.fullUri, p.thumbUri].map(async (uri) => {
      const url = await convex.mutation(api.photos.generateUploadUrl, {});
      return (await uploadToStorage(url, uri)) as Id<'_storage'>;
    }),
  );
  return convex.mutation(api.photos.create, {
    storageId: storageId as Id<'_storage'>,
    thumbStorageId: thumbStorageId as Id<'_storage'>,
    placeOnMap: p.placeOnMap,
    coord: photoUploadCoord(p.placeOnMap, p.coord),
  });
}

/**
 * *Save changes* on the edit door: the Report's whole content block (last-write-wins, so the kept
 * photos lead and the new uploads follow), then the Post's words when it has a Post. Online only —
 * an edit is not queued. Throws with the server's sentence on refusal.
 */
export async function saveSheetEdit(post: PostSheet, now: number): Promise<string> {
  if (post.mode.kind !== 'edit') throw new Error('Not an edit');
  const { reportId, postId } = post.mode;
  const report = post.reports[0];
  if (!report) throw new Error('Nothing to save');
  try {
    const uploaded = await Promise.all(report.photos.map(uploadPhoto));
    const { waterBodyId: _body, ...content } = toReportInput(report.sheet);
    await convex.mutation(api.reports.update, {
      ...content,
      reportId,
      photoIds: [...(report.keptPhotoIds as Id<'photos'>[]), ...uploaded],
    });
    if (postId !== undefined) {
      await convex.mutation(api.posts.update, {
        postId,
        ...(post.title.trim() ? { title: post.title.trim() } : {}),
        ...(post.body.trim() ? { body: post.body.trim() } : {}),
      });
    }
    queueConfirmations(post, now);
    void flushDrafts();
    return reportId;
  } catch (error) {
    throw new Error(flushErrorMessage(error));
  }
}
