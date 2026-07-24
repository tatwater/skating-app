/**
 * The offline **track** queue (Phase 8) — a recorded skate waiting for signal.
 *
 * Third kind on the same contract as `draftQueue` (reports) and `hazardQueue` (hazards): one status
 * machine, one transient-vs-permanent classification, one "persist after every advance" rule, drained
 * by the same flush loop in capture order.
 *
 * **Why a recording needs the durable queue more than anything else does.** A report is a form you can
 * retype; a hazard is a pin you can re-drop. A three-hour skate is *unrepeatable* — if the app is
 * killed on the ice, or the phone dies in the car, the only copy is what we wrote to sqlite. So the
 * recorder checkpoints its buffer into this item **while recording**, not just at stop, and the item
 * survives to be flushed days later.
 *
 * **The link to a report is by local id, resolved at flush.** A skater on a lake with no signal records
 * a track and immediately files a report about it — neither has a server id yet. The report draft
 * therefore carries the track's *local* `id` (`ReportDraft.trackDraftId`), and the report flush asks
 * this queue for the corresponding server `activityId` once the track has landed. Ordering is handled
 * by the flush effects, not by the user.
 *
 * **A track failure never blocks the report.** If the track can't be ingested, the report is created
 * without a path (D24: a report never requires a path). The observation about the ice is the safety
 * artifact; the track is enrichment.
 */

import type { DraftStatus, FlushErrorKind } from './draftQueue';
import { classifyFlushError, PermanentFlushError } from './draftQueue';
import type { LatLng } from './geometry';
import { processTrack, type TrackPoint } from './track';

/** How far the Strava push has got for this track — `null`/absent when the user didn't ask for one. */
export type StravaPushState = 'pending' | 'uploaded' | 'skipped' | 'failed';

/** A recorded skate on the device, waiting to become a `gpsActivities` row. */
export interface QueuedTrack {
  kind: 'track';
  id: string;
  /**
   * Client-generated at session start and carried across every retry. Doubles as the row's
   * `providerActivityId` for the `native` provider, so the `by_provider_activity` index dedupes a
   * lost-ack replay to the same activity — the same discipline as the report/hazard idempotency keys.
   */
  idempotencyKey: string;
  status: DraftStatus;
  errorMessage?: string;
  /** The recorded fixes, gated by `track.appendPoint` as they arrived. Checkpointed during recording. */
  points: TrackPoint[];
  /** `true` once the user stopped the session — an unfinished recording is never flushed. */
  finished: boolean;
  /** Resolved on-device from the Layer-2 body cache when possible; else resolved server-side at ingest. */
  waterBodyId?: string;
  /** For the recorder UI's label while offline. */
  bodyName?: string;
  /** Set once the track has been ingested — what a linked report draft reads to fill `activityId`. */
  activityId?: string;
  /** The per-session "also upload to Strava?" choice (v1 default on for phone-only skaters). */
  uploadToStrava: boolean;
  stravaPushState?: StravaPushState;
  startedAt: number;
  createdAt: number;
  updatedAt: number;
}

/** Start a recording session's queue item. The buffer fills as fixes arrive. */
export function createQueuedTrack(args: {
  id: string;
  idempotencyKey: string;
  now: number;
  uploadToStrava: boolean;
  waterBodyId?: string;
  bodyName?: string;
  points?: TrackPoint[];
}): QueuedTrack {
  return {
    kind: 'track',
    id: args.id,
    idempotencyKey: args.idempotencyKey,
    status: 'pending',
    points: args.points ?? [],
    finished: false,
    waterBodyId: args.waterBodyId,
    bodyName: args.bodyName,
    uploadToStrava: args.uploadToStrava,
    startedAt: args.now,
    createdAt: args.now,
    updatedAt: args.now,
  };
}

/**
 * Is this track ready to send? **Unfinished recordings are excluded** — a session still in progress is
 * persisted for crash-safety, not for flushing, and shipping half a skate would create an activity the
 * rest of the recording could never join.
 */
export function isTrackFlushable(track: QueuedTrack): boolean {
  return track.finished && track.status !== 'done' && track.status !== 'error';
}

/** The flushable subset, oldest first (capture order) — matching the other two queues. */
export function flushableTracks(tracks: readonly QueuedTrack[]): QueuedTrack[] {
  return tracks.filter(isTrackFlushable).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * The shortest track we'll send. Below this a "skate" is a handful of jittery fixes from someone who
 * opened the recorder by accident — it would resolve to a lake, prompt for a report, and pollute the
 * aggregate layer with a line that isn't a skate.
 */
export const MIN_TRACK_POINTS = 10;

export interface TrackFlushEffects {
  /** Resolve a coord to a lake (`waterBodies.resolveBodyForCoord`); null ⇒ no known body matched. */
  resolveBody(coord: LatLng): Promise<string | null>;
  /** Ingest the processed track (`gpsActivities.ingestTrack`); returns its activityId. */
  ingestTrack(input: {
    idempotencyKey: string;
    path: { type: 'LineString'; coordinates: number[][] };
    startTime: number;
    endTime: number;
    elapsedSeconds: number;
    distanceMeters: number;
    waterBodyId?: string;
  }): Promise<string>;
  /** Kick off the Strava push (`strava.pushActivity`), when the user asked for one. */
  pushToStrava?(input: { activityId: string }): Promise<void>;
  persist(track: QueuedTrack): Promise<void>;
}

export type TrackFlushResult =
  | { ok: true; track: QueuedTrack; activityId: string }
  | { ok: false; track: QueuedTrack; kind: FlushErrorKind; message: string };

/**
 * Flush one recorded track: post-process → resolve its lake → ingest → (optionally) push to Strava.
 *
 * Post-processing runs here rather than at stop-time so the stored geometry is always the output of the
 * current `processTrack` — a track queued by an older build gets today's smoothing when it finally
 * sends, and there's exactly one place the raw buffer becomes a path.
 *
 * **A failed Strava push is not a failed flush.** The activity is ours the moment it's ingested; Strava
 * is a courtesy copy. A push failure is recorded on the item and the flush still succeeds, so a Strava
 * outage can never strand a skate in the retry loop.
 */
export async function flushTrack(
  track: QueuedTrack,
  effects: TrackFlushEffects,
  now: number,
): Promise<TrackFlushResult> {
  let t = track;
  const save = async (patch: Partial<QueuedTrack>): Promise<void> => {
    t = { ...t, ...patch, updatedAt: now };
    await effects.persist(t);
  };

  try {
    await save({ status: 'uploading', errorMessage: undefined });

    // Already ingested by a prior attempt whose ack was lost — don't re-send, just finish.
    if (t.activityId !== undefined) {
      await save({ status: 'done' });
      return { ok: true, track: t, activityId: t.activityId };
    }

    if (t.points.length < MIN_TRACK_POINTS) {
      throw new PermanentFlushError('This recording is too short to save as a skate.');
    }

    const processed = processTrack(t.points);
    if (
      processed.path === null ||
      processed.stats.startTime === null ||
      processed.stats.endTime === null
    ) {
      throw new PermanentFlushError("This recording didn't capture a usable path.");
    }

    // Resolve the lake when the device didn't already (no body cache hit at record time). A miss is
    // NOT permanent here — unlike a report, a track that matches no known body is exactly the D14
    // "new water" case, so it ingests unresolved and the create-or-attach flow picks it up.
    let waterBodyId = t.waterBodyId;
    if (waterBodyId === undefined) {
      const mid = processed.points[Math.floor(processed.points.length / 2)] as TrackPoint;
      waterBodyId = (await effects.resolveBody({ lat: mid.lat, lng: mid.lng })) ?? undefined;
      if (waterBodyId !== undefined) await save({ waterBodyId });
    }

    await save({ status: 'creating' });
    const activityId = await effects.ingestTrack({
      idempotencyKey: t.idempotencyKey,
      path: processed.path as { type: 'LineString'; coordinates: number[][] },
      startTime: processed.stats.startTime,
      endTime: processed.stats.endTime,
      elapsedSeconds: Math.round(processed.stats.movingSeconds),
      distanceMeters: processed.stats.distanceMeters,
      ...(waterBodyId !== undefined ? { waterBodyId } : {}),
    });
    await save({ activityId, status: 'done' });

    if (t.uploadToStrava && effects.pushToStrava) {
      try {
        await save({ stravaPushState: 'pending' });
        await effects.pushToStrava({ activityId });
        await save({ stravaPushState: 'uploaded' });
      } catch {
        // Deliberately swallowed — see the note above. The skate is safe in our store either way.
        await save({ stravaPushState: 'failed' });
      }
    } else if (t.uploadToStrava) {
      await save({ stravaPushState: 'skipped' });
    }

    return { ok: true, track: t, activityId };
  } catch (error) {
    const kind = classifyFlushError(error);
    const message = error instanceof Error ? error.message : String(error);
    await save({
      status: kind === 'permanent' ? 'error' : 'pending',
      errorMessage: kind === 'permanent' ? message : undefined,
    });
    return { ok: false, track: t, kind, message };
  }
}
