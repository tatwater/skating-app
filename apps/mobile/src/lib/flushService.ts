/**
 * Reconnect flush for the offline draft queue (F2) — wires the pure `@skating/core` `flushDraft`
 * orchestration to the real effects (Convex mutations/queries + the storage upload + the sqlite
 * store). The hard logic (checkpointing, idempotency, transient-vs-permanent) lives in core; this is
 * the thin adapter. Untested native glue.
 */

import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  compactTrack,
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
  trackRetention,
} from '@skating/core';
import { uploadToStorage } from '../components/photoPipeline';
import { convex } from './convex';
import { deleteDraftPhotoFiles, draftPhotoUris } from './draftPhotos';
import {
  deleteDraft,
  deleteHazardItem,
  deleteTrack,
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

/**
 * Push failures that mean *we never sent anything* — an unconfigured deployment, an unconnected
 * account, a recording too short to be a GPX. The "also upload to Strava" toggle defaults on, so for
 * every phone-only skater who never linked an account this is the normal answer; recording it as a
 * failure would manufacture an error out of a feature they simply don't use. Settled, but the history
 * list still offers "Send to Strava" — connecting an account later is exactly the case this covers.
 */
const PUSH_NOT_ATTEMPTED = new Set(['not_configured', 'not_connected', 'too_short']);

/**
 * Failures a retry cannot fix: the activity is gone, isn't theirs, or has no path to send. Everything
 * *else* — a 5xx, a rate limit, an upload still processing when we stopped polling, an auth token not
 * attached yet — is temporary, so it goes back in the queue rather than being written off after one
 * bad moment. That default matters more than the list: a wrongly-terminal push is silently lost,
 * while a wrongly-retried one costs three attempts and then settles anyway.
 */
const PUSH_TERMINAL = new Set(['not_found', 'not_owner', 'no_path']);

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
    // The courtesy copy — "record once, get both" only holds if this is actually wired. `pushActivity`
    // is an action (it talks to Strava over HTTP and may refresh a token first) and it *returns* its
    // failures rather than throwing, so a bad result has to be translated here; only a transport
    // error escapes as an exception, which `flushTrack` already treats as `failed`.
    pushToStrava: async ({ activityId }) => {
      const res = await convex.action(api.strava.pushActivity, {
        activityId: activityId as Id<'gpsActivities'>,
      });
      // A duplicate is Strava telling us the skate is already on the account (a watch got there
      // first). Nothing to send, nothing to retry — that's an upload, not a failure.
      if (res.ok || res.reason === 'duplicate') return 'uploaded';
      if (res.reason !== undefined && PUSH_NOT_ATTEMPTED.has(res.reason)) return 'skipped';
      return res.reason !== undefined && PUSH_TERMINAL.has(res.reason) ? 'failed' : 'retry';
    },
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
    // Last, deliberately: the drafts that just flushed have released their track references, so a
    // track finished with weeks ago is free to go on this pass rather than the next one.
    sweepTracks(now);
  } finally {
    flushing = false;
  }
}

/**
 * Apply the retention policy to the recorded-track rows (Phase 8).
 *
 * Runs after every drain rather than on a timer: a flush is exactly when rows change state, it's
 * already off the render path, and a device that never syncs has nothing worth sweeping. The policy
 * itself — what may be compacted, what may be deleted, and the report-draft reference guard that
 * stops a still-composing report from losing its path — lives in `@skating/core` where it's tested.
 */
function sweepTracks(now: number): void {
  try {
    applyTrackRetention(now);
  } catch {
    // Housekeeping must never surface as a failed flush. A sweep that can't run today runs next time;
    // the rows it would have tidied are inert either way.
  }
}

function applyTrackRetention(now: number): void {
  const referencedIds = new Set(
    listDrafts()
      .map((d) => d.trackDraftId)
      .filter((id): id is string => id !== undefined),
  );
  const { compact, remove } = trackRetention(listTracks(), { now, referencedIds });
  for (const track of compact) saveTrack(compactTrack(track, now));
  for (const track of remove) deleteTrack(track.id);
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
 * local id, the row now carries the `activityId` that resolves that reference, and `TrackHistory`
 * reads those rows to show what became of each skate's Strava copy. Nothing prunes them yet — the
 * rows are small (points included) but they do accumulate; a retention pass is still owed.
 *
 * A track whose Strava push is still unanswered is re-admitted here even though it's `done` (see
 * `isTrackFlushable`), which is what makes the bounded push retry happen at all.
 */
async function flushTrackQueue(now: number): Promise<void> {
  for (const { id } of flushableTracks(listTracks())) {
    await flushOneTrack(id, now);
  }
}
