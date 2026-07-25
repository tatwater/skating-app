/**
 * Reconnect flush for the offline draft queue (F2) — wires the pure `@skating/core` `flushDraft`
 * orchestration to the real effects (Convex mutations/queries + the storage upload + the sqlite
 * store). The hard logic (checkpointing, idempotency, transient-vs-permanent) lives in core; this is
 * the thin adapter. Untested native glue.
 */

import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  type DraftFlushEffects,
  flushableDrafts,
  flushableHazardItems,
  flushableTracks,
  flushDraft,
  flushHazardItem,
  flushTrack,
  type HazardFlushEffects,
  isFlushable,
  isHazardItemFlushable,
  isTrackFlushable,
  type ReportInput,
  type TrackFlushEffects,
} from '@skating/core';
import { uploadToStorage } from '../components/photoPipeline';
import { convex } from './convex';
import { deleteDraftPhotoFiles, draftPhotoUris } from './draftPhotos';
import {
  deleteDraft,
  deleteHazardItem,
  getDraft,
  getHazardItem,
  getTrack,
  listDrafts,
  listHazardItems,
  listTracks,
  saveDraft,
  saveHazardItem,
  saveTrack,
} from './draftStore';

/** Map the core report input to `reports.create` args (branded Convex ids reapplied). */
function toCreateArgs(
  input: ReportInput & { idempotencyKey: string; photoIds: string[]; activityId?: string },
) {
  return {
    waterBodyId: input.waterBodyId as Id<'waterBodies'>,
    idempotencyKey: input.idempotencyKey,
    skateEndTime: input.skateEndTime,
    skateStartTime: input.skateStartTime,
    iceTypes: input.iceTypes,
    surfaceTags: input.surfaceTags,
    skateQuality: input.skateQuality,
    iceThickness: input.iceThickness,
    snowCoverCm: input.snowCoverCm,
    conditions: input.conditions,
    notes: input.notes,
    point: input.point,
    photoIds: input.photoIds as Id<'photos'>[],
    ...(input.activityId !== undefined
      ? { activityId: input.activityId as Id<'gpsActivities'> }
      : {}),
  };
}

function effects(): DraftFlushEffects {
  return {
    resolveBody: async (coord) => {
      const res = await convex.query(api.waterBodies.resolveBodyForCoord, { coord });
      return res?.waterBodyId ?? null;
    },
    uploadPhoto: async (uri) => {
      const url = await convex.mutation(api.photos.generateUploadUrl, {});
      return uploadToStorage(url, uri);
    },
    createPhotoRow: async ({ storageId, thumbStorageId, placeOnMap, coord }) =>
      convex.mutation(api.photos.create, {
        storageId: storageId as Id<'_storage'>,
        thumbStorageId: thumbStorageId as Id<'_storage'>,
        placeOnMap,
        coord,
      }),
    createReport: async (input) => convex.mutation(api.reports.create, toCreateArgs(input)),
    // Phase 8: resolve a report draft's LOCAL track id to a server activity id, flushing the track
    // first if it hasn't landed. Best-effort — see `flushOneTrack`: a track that can't be sent must
    // never hold back the report it belongs to (D24).
    resolveActivityId: async (trackDraftId) => {
      const queued = getTrack(trackDraftId);
      if (!queued) return null;
      if (queued.activityId !== undefined) return queued.activityId;
      if (!isTrackFlushable(queued)) return null;
      const result = await flushOneTrack(queued.id, Date.now());
      return result?.activityId ?? null;
    },
    persist: async (draft) => {
      saveDraft(draft);
    },
  };
}

/** The recorded-track adapter (Phase 8) — ingest, then the optional Strava courtesy copy. */
function trackEffects(): TrackFlushEffects {
  const shared = effects();
  return {
    resolveBody: shared.resolveBody,
    ingestTrack: async (input) =>
      convex.mutation(api.gpsActivities.ingestTrack, {
        idempotencyKey: input.idempotencyKey,
        path: input.path,
        startTime: input.startTime,
        endTime: input.endTime,
        elapsedSeconds: input.elapsedSeconds,
        ...(input.waterBodyId !== undefined
          ? { waterBodyId: input.waterBodyId as Id<'waterBodies'> }
          : {}),
      }),
    persist: async (track) => {
      saveTrack(track);
    },
  };
}

/**
 * Flush one recorded track by local id, returning its result. Shared by the queue drain and by a
 * report draft that needs its linked track's server id *now* (`resolveActivityId`), so a skater who
 * records and reports in one offline session gets both, in the right order, without being told to
 * wait. A finished track's row is **kept** after a successful flush (unlike a report draft's, which is
 * deleted): the local id is what a not-yet-flushed report draft still points at, and the row now
 * carries the `activityId` that resolves it.
 */
async function flushOneTrack(id: string, now: number): Promise<{ activityId: string } | null> {
  const fresh = getTrack(id);
  if (!fresh || !isTrackFlushable(fresh)) return null;
  const result = await flushTrack(fresh, trackEffects(), now);
  return result.ok ? { activityId: result.activityId } : null;
}

/**
 * The hazard-queue adapter (Phase 9 offline). Shares the photo/body effects with the report queue —
 * an uploaded photo is an uploaded photo — and adds the two hazard mutations.
 */
function hazardEffects(): HazardFlushEffects {
  const shared = effects();
  return {
    resolveBody: shared.resolveBody,
    uploadPhoto: shared.uploadPhoto,
    createPhotoRow: shared.createPhotoRow,
    createHazard: async (input) =>
      convex.mutation(api.hazards.create, {
        waterBodyId: input.waterBodyId as Id<'waterBodies'>,
        idempotencyKey: input.idempotencyKey,
        type: input.type,
        geometryKind: input.shape.geometryKind,
        geometry: input.shape.geometry,
        ...(input.shape.radiusMeters !== undefined
          ? { radiusMeters: input.shape.radiusMeters }
          : {}),
        ...(input.shape.bufferMeters !== undefined
          ? { bufferMeters: input.shape.bufferMeters }
          : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        photoIds: input.photoIds as Id<'photos'>[],
        capturedAt: input.capturedAt,
      }),
    confirmHazard: async (input) => {
      await convex.mutation(api.hazardConfirmations.confirm, {
        hazardId: input.hazardId as Id<'hazards'>,
        verdict: input.verdict,
        // Carry the real trigger through — a drawer confirmation must not masquerade as a stronger
        // proximity_alert just because it queued offline (the origin is preserved on the queue item).
        via: input.via,
        ...(input.atCoord ? { atCoord: input.atCoord } : {}),
        observedAt: input.observedAt,
      });
    },
    persist: async (item) => {
      saveHazardItem(item);
    },
  };
}

// A single in-flight flush at a time: reconnect + app-foreground + manual triggers can all fire, and
// the guard keeps them from double-sending (the report is idempotent, but this avoids wasted work).
let flushing = false;

// Ids currently being flushed. The edit form checks this (`isDraftFlushing`) and refuses to save
// over an in-flight draft — otherwise an edit-during-flush would be clobbered by the flush's
// checkpoint writes and then deleted, silently losing the edit (idempotency would re-serve the
// pre-edit report). Set membership is mutated synchronously around each draft, so the check +
// synchronous `saveDraft` in `handleSaveDraft` can't interleave with a flush claiming the same id.
const flushingIds = new Set<string>();

/** Is this draft currently being flushed? The edit form blocks a save over an in-flight draft. */
export function isDraftFlushing(id: string | undefined): boolean {
  return id !== undefined && flushingIds.has(id);
}

/**
 * Flush every pending draft once, oldest first. Each draft that succeeds has its photo files deleted
 * and its row removed; a transient failure leaves it `pending` (retried next flush), a permanent one
 * parks it in `error` for the user — both persisted by `flushDraft` itself. Re-entrant calls no-op.
 *
 * Each draft is **re-read from sqlite immediately before flushing** (not taken from the initial batch
 * snapshot) and held under `flushingIds` for the duration, so an edit saved after the snapshot is
 * either picked up fresh here or blocked by `isDraftFlushing` in the form — never silently lost.
 */
export async function flushDrafts(now: number = Date.now()): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    // Hazards first, deliberately. They're safety content that another skater may be about to need,
    // and a queue of report drafts with photos can take a while to drain on a weak connection —
    // sending the ridge before the trip write-up is the right order to lose a connection in.
    await flushHazardQueue(now);
    // Then tracks, before reports: a report draft linked to one needs its `activityId`. A report
    // whose track is still queued resolves it on demand anyway (`resolveActivityId`), so this is an
    // ordering optimization, not a correctness requirement.
    await flushTrackQueue(now);
    const eff = effects();
    for (const { id } of flushableDrafts(listDrafts())) {
      flushingIds.add(id);
      try {
        // Re-read the latest on-disk state — an edit between the snapshot and now must flush its
        // new content, not the stale snapshot.
        const fresh = getDraft(id);
        if (!fresh || !isFlushable(fresh)) continue;
        const result = await flushDraft(fresh, eff, now);
        if (result.ok) {
          deleteDraftPhotoFiles(draftPhotoUris(result.draft));
          deleteDraft(result.draft.id);
        }
      } finally {
        flushingIds.delete(id);
      }
    }
  } finally {
    flushing = false;
  }
}

/**
 * Drain the hazard queue once, oldest first. A successful item is deleted; a transient failure is
 * left `pending` for the next flush and a permanent one parks in `error` — both persisted by
 * `flushHazardItem` itself.
 *
 * Unlike report drafts there's no edit-during-flush race to guard: a queued hazard is immutable once
 * captured (the capture bar is gone by then), so there's nothing for an edit to clobber.
 */
async function flushHazardQueue(now: number): Promise<void> {
  const eff = hazardEffects();
  for (const { id } of flushableHazardItems(listHazardItems())) {
    const fresh = getHazardItem(id);
    if (!fresh || !isHazardItemFlushable(fresh)) continue;
    const result = await flushHazardItem(fresh, eff, now);
    if (result.ok) {
      if (result.item.kind === 'hazard') {
        deleteDraftPhotoFiles(result.item.photos.flatMap((p) => [p.fullUri, p.thumbUri]));
      }
      deleteHazardItem(result.item.id);
    }
  }
}

/**
 * Drain the recorded-track queue once, oldest first. Only **finished** sessions are flushable, so a
 * recording still in progress is never sent half-done.
 *
 * A successful track's row is deliberately **not deleted**: a report draft may still reference it by
 * local id, and the row now carries the `activityId` that resolves that reference. Rows are cleaned
 * up by the recorder's own history UI, not by the flush.
 */
async function flushTrackQueue(now: number): Promise<void> {
  for (const { id } of flushableTracks(listTracks())) {
    await flushOneTrack(id, now);
  }
}
