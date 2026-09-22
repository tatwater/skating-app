/**
 * What the console's buttons do (A10-5 / §10.3): *Post* sends the whole Post in one go, and
 * *Save changes* on the edit door updates the Report and its Post's words.
 *
 * **There is no offline queue on web** (§10.3): a Post with no connection fails with a message.
 * What there is, instead, is the same orchestration the phone runs — core's `flushPost`, with the
 * browser's effects injected. That is deliberate: the order of operations (resolve the lake,
 * re-validate, resolve bundled hazards, ask the create-only rules in the server's words, upload
 * each photo with its id checkpointed, create the Post, then file the condition alerts with the
 * new Report as provenance) is a dozen rules that must not have two answers. Mobile and web differ
 * in where the draft is kept and whether a failure waits; they do not differ in what a Post is.
 * The tick-through's hazard verdicts are filed after the Post lands, as the phone files them
 * (`fileConfirmations`, the queue-less twin of mobile's `queueConfirmations`).
 *
 * The checkpointed draft a failed attempt returns is handed back to the caller, so a retry reuses
 * every photo that already landed instead of uploading it twice. A tab closed mid-attempt leaves
 * its uploads to the 30-day orphan sweep (`photoOrphans`), which is what that sweep is for.
 */

import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  type AccessConditionFiling,
  type AccessReason,
  confirmableVerdict,
  flushErrorMessage,
  flushPost,
  type PostDraft,
  type PostSheet,
  photoUploadCoord,
  selectedValues,
  toPostDraft,
  toReportInput,
} from '@skating/core';
import type { ConvexReactClient } from 'convex/react';
import { uploadToStorage } from '../components/photoPipeline';
import { sheetPhotoBlob } from './sheetPhotos';

export type WebPostOutcome =
  | { kind: 'posted'; postId: string; reportId: string }
  /** The attempt failed; `draft` carries what already landed, so a retry resumes rather than repeats. */
  | { kind: 'refused'; message: string; draft: PostDraft };

/**
 * Post the sheet. `previous` is the draft a prior failed attempt returned — pass it back to resume
 * from its checkpoints; omit it for a first try.
 */
export async function postSheetOnWeb(
  convex: ConvexReactClient,
  post: PostSheet,
  now: number,
  previous?: PostDraft | null,
): Promise<WebPostOutcome> {
  const draft = toPostDraft(post, 'pending', now, previous ?? null);
  // A resumed attempt keeps the prior draft's checkpoints — its uploaded photo ids, and the
  // `creating` mark that says the create was already sent once (a lost ack must not be refused as
  // a stale report, nor posted twice; the server's idempotent key settles it).
  const resumed: PostDraft =
    previous == null
      ? draft
      : {
          ...draft,
          status: previous.status === 'creating' ? 'creating' : draft.status,
          ...(previous.postId !== undefined ? { postId: previous.postId } : {}),
          reports: draft.reports.map((r) => {
            const prior = previous.reports.find((p) => p.id === r.id);
            if (!prior) return r;
            return {
              ...r,
              photos: r.photos.map((photo) => prior.photos.find((p) => p.id === photo.id) ?? photo),
              ...(prior.filedAccessReasons !== undefined
                ? { filedAccessReasons: prior.filedAccessReasons }
                : {}),
            };
          }),
        };

  const result = await flushPost(resumed, webEffects(convex), now);
  if (result.ok) {
    await fileConfirmations(convex, post);
    const reportId = result.reportIds[0];
    return reportId !== undefined
      ? { kind: 'posted', postId: result.postId, reportId }
      : { kind: 'refused', message: 'That post came back without a report.', draft: result.draft };
  }
  return { kind: 'refused', message: result.message, draft: result.draft };
}

/**
 * The tick-through's answers (§6.2 / §6 (d)) as confirmation votes — `via: 'report_flow'`, observed
 * at the end time — filed at Post, never before. *Didn't look* files nothing, so silence is never a
 * vote. The phone's `queueConfirmations` does this through the hazard queue; web has no queue
 * (§10.3), so each vote goes straight to the mutation.
 *
 * **Best effort, after the Post has landed.** One vote row per user per hazard server-side, so a
 * re-post of a resumed draft refreshes rather than double-counts. A vote that fails must not turn a
 * Post that succeeded into a refusal — the Report is up, and the author has nothing to retry.
 */
async function fileConfirmations(convex: ConvexReactClient, post: PostSheet): Promise<number> {
  let filed = 0;
  for (const report of post.reports) {
    const [end] = selectedValues(report.sheet, 'endTime');
    for (const [hazardId, verdict] of Object.entries(report.sheet.scalars.passedVerdicts)) {
      const v = confirmableVerdict(verdict);
      if (v === null) continue;
      try {
        await convex.mutation(api.hazardConfirmations.confirm, {
          hazardId: hazardId as Id<'hazards'>,
          verdict: v,
          via: 'report_flow',
          ...(end !== undefined ? { observedAt: end.ms } : {}),
        });
        filed++;
      } catch {
        // The hazard was merged away, archived, or the connection dropped. The Report stands.
      }
    }
  }
  return filed;
}

function webEffects(convex: ConvexReactClient) {
  return {
    resolveBody: async (coord: { lat: number; lng: number }) => {
      const res = await convex.query(api.waterBodies.resolveBodyForCoord, { coord });
      return res?.waterBodyId ?? null;
    },
    uploadPhoto: async (uri: string) => {
      const blob = sheetPhotoBlob(uri);
      if (blob === null) throw new Error('That photo is no longer in this tab — re-add it.');
      const url = await convex.mutation(api.photos.generateUploadUrl, {});
      return uploadToStorage(url, blob);
    },
    createPhotoRow: async (input: {
      storageId: string;
      thumbStorageId: string;
      placeOnMap: boolean;
      coord?: { lat: number; lng: number };
    }) =>
      convex.mutation(api.photos.create, {
        storageId: input.storageId as Id<'_storage'>,
        thumbStorageId: input.thumbStorageId as Id<'_storage'>,
        placeOnMap: input.placeOnMap,
        ...(input.coord !== undefined ? { coord: input.coord } : {}),
      }),
    createPost: async (input: Parameters<typeof toCreateArgs>[0]) =>
      convex.mutation(api.posts.create, toCreateArgs(input)),
    createAccessAlert: async (
      input: AccessConditionFiling & { reportId: string; idempotencyKey: string },
    ) => {
      await convex.mutation(api.accessAlerts.create, {
        targetType: input.targetType,
        ...(input.putInId !== undefined ? { putInId: input.putInId as Id<'putIns'> } : {}),
        ...(input.parkingAreaId !== undefined
          ? { parkingAreaId: input.parkingAreaId as Id<'parkingAreas'> }
          : {}),
        reason: input.reason as AccessReason,
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.observedAt !== undefined ? { observedAt: input.observedAt } : {}),
        reportId: input.reportId as Id<'reports'>,
        idempotencyKey: input.idempotencyKey,
      });
    },
    // No queue to persist to. `flushPost` returns the checkpointed draft in its result either
    // way, and that is what a retry resumes from, so there is nothing for this to write.
    persist: async () => {},
  };
}

/**
 * Core's wire input for `posts.create`, with Convex's branded ids reapplied. The content goes
 * through **whole** — the args are core's `ReportInput` plus the ids — for the reason mobile's
 * `toReportArgs` learned the hard way: a version that listed the fields by name silently dropped
 * every field it did not list, and naming them again is how the next one goes missing.
 */
function toCreateArgs(input: {
  idempotencyKey: string;
  title?: string;
  body?: string;
  reports: (ReturnType<typeof toReportInput> & {
    waterBodyId: string;
    idempotencyKey: string;
    photoIds: string[];
    activityId?: string;
    attachHazardIds?: string[];
  })[];
}) {
  return {
    idempotencyKey: input.idempotencyKey,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    reports: input.reports.map((report) => {
      const { waterBodyId, photoIds, activityId, attachHazardIds, ...content } = report;
      return {
        ...content,
        waterBodyId: waterBodyId as Id<'waterBodies'>,
        photoIds: photoIds as Id<'photos'>[],
        ...(activityId !== undefined ? { activityId: activityId as Id<'gpsActivities'> } : {}),
        ...(attachHazardIds !== undefined
          ? { attachHazardIds: attachHazardIds as Id<'hazards'>[] }
          : {}),
      };
    }),
  };
}

/**
 * *Save changes* on the edit door: the Report's whole content block (last-write-wins, so the kept
 * photos lead and the new uploads follow), then the Post's words. Throws with the server's
 * sentence on refusal — an edit has no queue to park in on either surface.
 */
export async function saveSheetEditOnWeb(
  convex: ConvexReactClient,
  post: PostSheet,
): Promise<string> {
  if (post.mode.kind !== 'edit') throw new Error('Not an edit');
  const reportId = post.mode.reportId as Id<'reports'>;
  const postId = post.mode.postId as Id<'posts'> | undefined;
  const report = post.reports[0];
  if (!report) throw new Error('Nothing to save');
  try {
    const uploaded: Id<'photos'>[] = [];
    for (const photo of report.photos) {
      if (photo.photoId !== undefined) {
        uploaded.push(photo.photoId as Id<'photos'>);
        continue;
      }
      const [storageId, thumbStorageId] = await Promise.all(
        [photo.fullUri, photo.thumbUri].map(async (uri) => {
          const blob = sheetPhotoBlob(uri);
          if (blob === null) throw new Error('That photo is no longer in this tab — re-add it.');
          const url = await convex.mutation(api.photos.generateUploadUrl, {});
          return uploadToStorage(url, blob);
        }),
      );
      uploaded.push(
        await convex.mutation(api.photos.create, {
          storageId: storageId as Id<'_storage'>,
          thumbStorageId: thumbStorageId as Id<'_storage'>,
          placeOnMap: photo.placeOnMap,
          coord: photoUploadCoord(photo.placeOnMap, photo.coord),
        }),
      );
    }
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
    await fileConfirmations(convex, post);
    return reportId;
  } catch (error) {
    throw new Error(flushErrorMessage(error));
  }
}
