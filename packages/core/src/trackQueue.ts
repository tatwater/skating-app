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
import { processTrack, type TrackPoint, trackStats } from './track';

/** How far the Strava push has got for this track — `null`/absent when the user didn't ask for one. */
export type StravaPushState = 'pending' | 'uploaded' | 'skipped' | 'failed';

/**
 * What a push attempt came back as. Deliberately not a boolean: four different things can happen and
 * only the host adapter can tell them apart.
 *
 *  - `uploaded` — it's on Strava (including Strava's *duplicate* rejection: a watch beat us to it).
 *  - `skipped`  — we never tried, and trying again now wouldn't change that: no connection, nothing
 *                 to send. Settled, but the user can still ask for it by hand.
 *  - `failed`   — Strava (or we) said no in a way a retry can't fix: the activity is gone, isn't
 *                 theirs, has no path.
 *  - `retry`    — a *temporary* refusal: a 5xx, a rate limit, an upload still processing when we
 *                 stopped polling, a dropped connection. Nothing is wrong with the skate, so it goes
 *                 back in the queue for a later drain, up to `MAX_STRAVA_PUSH_ATTEMPTS`.
 *
 * `retry` is an outcome, never a stored state: it persists as `pending`, which is what
 * `isTrackFlushable` reads as "no answer yet".
 */
export type StravaPushOutcome = 'uploaded' | 'skipped' | 'failed' | 'retry';

/**
 * How many times a requested push may be attempted before a temporary failure is treated as a final
 * one.
 *
 * There has to be a ceiling *and* it has to be small. Drains fire on every reconnect and every
 * foreground, so an uncapped retry would re-hit Strava for the life of the row on behalf of a skate
 * that is already safely ours — and Strava rate-limits per application, meaning one skater's stuck
 * track spends everyone's budget. Three attempts covers the failure this is actually for (an outage
 * or a dead tunnel during the flush) without turning into a background job. Past the cap the state
 * settles as `failed`, which the history UI offers to retry by hand — an unbounded machine loop and
 * a person deciding to try again are not the same thing.
 */
export const MAX_STRAVA_PUSH_ATTEMPTS = 3;

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
  /** Attempts made so far, against `MAX_STRAVA_PUSH_ATTEMPTS`. Reset when a person asks by hand. */
  stravaPushAttempts?: number;
  /**
   * Distance and duration kept when the fixes are dropped (`compactTrack`).
   *
   * Everywhere else in this codebase a derivable number is *not* stored — `ingestTrack` deliberately
   * refuses `distanceMeters` because the server has the path to measure. Here the opposite holds: once
   * the points are gone this is the only copy left on the device, and the history row would otherwise
   * have to claim every compacted skate was 0 miles.
   */
  distanceMeters?: number;
  elapsedSeconds?: number;
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
 * The user asked for a Strava copy and we hold no answer about it — either the push hasn't been
 * attempted or we were killed mid-flight (`pending` is written *before* the attempt, precisely so an
 * interrupted one is distinguishable afterwards).
 *
 * Deliberately **not** true for `failed`: that's a settled answer. Retrying it on every drain would
 * hammer Strava forever on behalf of a skate that is already safely ours, and there's no retry budget
 * here to bound it. Unsettled means *unknown*, not *unsuccessful*.
 */
function pushUnsettled(track: QueuedTrack): boolean {
  return (
    track.uploadToStrava &&
    (track.stravaPushState === undefined || track.stravaPushState === 'pending')
  );
}

/**
 * Is this track ready to send? **Unfinished recordings are excluded** — a session still in progress is
 * persisted for crash-safety, not for flushing, and shipping half a skate would create an activity the
 * rest of the recording could never join.
 *
 * `done` means *ingested*, not *finished with*. A track is marked done the moment the activity is ours
 * (a Strava outage must never make a safely-stored skate look unsaved), so if the app is suspended
 * between that and the push settling, the requested upload would be stranded in a row nothing ever
 * looks at again. Such a track stays flushable until its push has an answer; the re-run skips ingest
 * (it has an `activityId`) and does only the outstanding half.
 */
export function isTrackFlushable(track: QueuedTrack): boolean {
  if (!track.finished || track.status === 'error') return false;
  return track.status !== 'done' || pushUnsettled(track);
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
  /**
   * Ingest the processed track (`gpsActivities.ingestTrack`); returns its activityId.
   *
   * Deliberately **no `distanceMeters`**: `processTrack` derives it from the very points that become
   * `path`, so it's exactly `trackStats(path).distanceMeters` and carries no information the geometry
   * doesn't. Sending it would make the server look like it stores a distance it doesn't. If a future
   * read genuinely needs distance without loading paths, denormalize it *then*, with the consumer that
   * justifies it. (The recorder's live readout keeps its own `distanceMeters` — that's display state.)
   */
  ingestTrack(input: {
    idempotencyKey: string;
    path: { type: 'LineString'; coordinates: number[][] };
    startTime: number;
    endTime: number;
    elapsedSeconds: number;
    waterBodyId?: string;
  }): Promise<string>;
  /**
   * Kick off the Strava push (`strava.pushActivity`), when the user asked for one.
   *
   * Returns how it settled rather than resolving-means-success: the toggle defaults *on*, so the
   * overwhelmingly common answer from a phone-only skater is "you aren't connected to Strava" — which
   * is `skipped`, not `failed`. Throwing is still honoured (→ `failed`) so an adapter can just let a
   * transport error escape. Optional: a host with no Strava integration at all omits it entirely.
   */
  pushToStrava?(input: { activityId: string }): Promise<StravaPushOutcome>;
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
 *
 * **Every step is resumable, and the two halves resume independently.** An item carrying an
 * `activityId` never re-ingests; an item whose push never settled re-enters here and does only that.
 * A phone suspended between the two — the likeliest moment, since the push is the one step that waits
 * on a third party — loses neither.
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
    // Already ingested by a prior attempt — whose ack was lost, or which was killed before its Strava
    // push settled. Either way the activity exists and must not be re-sent; only what's left runs.
    let activityId = t.activityId;

    if (activityId === undefined) {
      await save({ status: 'uploading', errorMessage: undefined });

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
      activityId = await effects.ingestTrack({
        idempotencyKey: t.idempotencyKey,
        path: processed.path as { type: 'LineString'; coordinates: number[][] },
        startTime: processed.stats.startTime,
        endTime: processed.stats.endTime,
        elapsedSeconds: Math.round(processed.stats.movingSeconds),
        ...(waterBodyId !== undefined ? { waterBodyId } : {}),
      });
    }

    // Done the moment the skate is ours, *before* Strava is consulted: a courtesy copy that fails
    // (or hangs, or never gets attempted because the phone slept) must never make a safely-ingested
    // track look unsaved. `isTrackFlushable` is what keeps the unfinished push from being forgotten.
    await save({ activityId, status: 'done' });

    // Only when we have no answer yet — a resumed track whose push already settled must not re-send.
    if (pushUnsettled(t)) {
      if (effects.pushToStrava) {
        // Counted and persisted BEFORE the attempt, so an interruption is legible afterwards and a
        // phone that dies mid-push every single time still exhausts the cap instead of looping. A
        // push that in fact reached Strava before the app died is re-sent on the next attempt and
        // comes back as a *duplicate*, which the adapter reports as `uploaded` — safe by construction.
        const attempt = (t.stravaPushAttempts ?? 0) + 1;
        await save({ stravaPushState: 'pending', stravaPushAttempts: attempt });

        let outcome: StravaPushOutcome;
        try {
          outcome = await effects.pushToStrava({ activityId });
        } catch {
          // A throw is the connection dropping, not Strava's verdict — the most retryable thing there
          // is. Deliberately swallowed either way: the skate is safe in our store (D24).
          outcome = 'retry';
        }
        await save({
          stravaPushState:
            outcome !== 'retry'
              ? outcome
              : // Back to `pending` so a later drain picks it up — until the cap, after which a
                // temporary failure has to be called something, and `failed` is what the history UI
                // offers a person the chance to override.
                attempt >= MAX_STRAVA_PUSH_ATTEMPTS
                ? 'failed'
                : 'pending',
        });
      } else {
        await save({ stravaPushState: 'skipped' });
      }
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

// ─────────────────────────────────────────────────────────────────────────────
// The manual path
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ask for a Strava push by hand: clear the settled state and the attempt count so the next drain
 * treats the track as unpushed.
 *
 * This is the counterweight to the attempt cap. An automatic retry has to give up eventually — it's
 * guessing — but a person tapping "Retry" is new information (they reconnected, the outage ended,
 * they changed their mind about a skate they'd opted out of), so it also turns `uploadToStrava` on.
 * Resetting the counter rather than bumping it means the cap bounds *machine* retries only.
 */
export function requestStravaPush(track: QueuedTrack, now: number): QueuedTrack {
  return {
    ...track,
    uploadToStrava: true,
    stravaPushState: undefined,
    stravaPushAttempts: 0,
    updatedAt: now,
  };
}

/** How a track's Strava push should read in the history list, and what the user can do about it. */
export interface StravaPushView {
  label: string;
  /** `null` when there's nothing for a person to do — it's done, or the queue already has it. */
  action: 'retry' | 'send' | null;
}

/**
 * The push state as a sentence plus an offer. Lives here, not in the screen, because "can this be
 * retried?" is the same question `isTrackFlushable` answers and the two must not drift: a row that
 * offers a retry the queue would ignore, or hides one it would honour, is worse than no row at all.
 */
export function describeStravaPush(track: QueuedTrack): StravaPushView {
  // Not ours yet: the skate itself is still queued, and *that* retry is the flush's job, not a
  // button's. Offering "send to Strava" here would promise something we can't do first.
  if (track.activityId === undefined) return { label: 'Waiting to sync', action: null };
  if (!track.uploadToStrava) return { label: 'Not sent to Strava', action: 'send' };

  switch (track.stravaPushState) {
    case 'uploaded':
      return { label: 'On Strava', action: null };
    case 'skipped':
      return { label: 'Not sent — no Strava connection', action: 'send' };
    case 'failed':
      return { label: "Couldn't send to Strava", action: 'retry' };
    default:
      // Unsettled: the queue is on it. `pending` after an attempt means a later drain will try again.
      return {
        label: (track.stravaPushAttempts ?? 0) > 0 ? 'Will try Strava again' : 'Sending to Strava…',
        action: null,
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Retention
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long a finished skate's row survives on the device after it has nothing left to do.
 *
 * The row itself is tiny once compacted; the window exists for the *history list*, not for storage —
 * long enough that "did that skate reach Strava?" is still answerable weeks later, short enough that
 * a settings screen doesn't slowly become an archive of every skate you have ever taken. A month
 * covers a cold snap and the conversation that follows it.
 */
export const TRACK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Nothing left for the queue to do: ingested, and any requested Strava push has an answer. */
function trackSettled(track: QueuedTrack): boolean {
  return track.finished && track.activityId !== undefined && !pushUnsettled(track);
}

/**
 * May this row be dropped?
 *
 * One rule, two triggers — a person tapping Remove now, and the retention sweep later — because a
 * button that deletes something the sweep would have protected (or vice versa) is a bug waiting for
 * the right week to happen.
 *
 * The `referencedIds` guard is the load-bearing part: a report draft written on the ice points at its
 * track by **local** id, and deleting that row out from under it silently strips the path off a report
 * the skater is still composing. A permanently-errored recording *is* removable — that's the only way
 * to dismiss a skate the app has told you it can't save (the same courtesy the hazard queue extends).
 */
export function canRemoveTrack(track: QueuedTrack, referencedIds: ReadonlySet<string>): boolean {
  if (!track.finished || referencedIds.has(track.id)) return false;
  return track.status === 'error' || trackSettled(track);
}

/** Settled, and still carrying the fixes it no longer needs. */
export function isTrackCompactable(track: QueuedTrack): boolean {
  return trackSettled(track) && track.points.length > 0;
}

/**
 * Drop the fixes, keep the row.
 *
 * A recorded skate is by far the heaviest thing this queue stores — a three-hour session is thousands
 * of points, checkpointed to sqlite during recording precisely because it's unrepeatable. Once the
 * track is ingested, the server holds the path and nothing on the device reads those points again:
 * both the map and the report detail draw from server queries, and a manual Strava retry skips
 * straight to the push because the activity already exists. So the payload goes and the row stays —
 * which is what a report draft still needs (`activityId`) and what the history list renders.
 */
export function compactTrack(track: QueuedTrack, now: number): QueuedTrack {
  const stats = trackStats(track.points);
  return {
    ...track,
    points: [],
    distanceMeters: stats.distanceMeters,
    elapsedSeconds: stats.elapsedSeconds,
    updatedAt: now,
  };
}

/** Distance and duration for display, from whichever copy survives. */
export function trackSummary(track: QueuedTrack): {
  distanceMeters: number;
  elapsedSeconds: number;
} {
  if (track.points.length > 0) {
    const stats = trackStats(track.points);
    return { distanceMeters: stats.distanceMeters, elapsedSeconds: stats.elapsedSeconds };
  }
  return {
    distanceMeters: track.distanceMeters ?? 0,
    elapsedSeconds: track.elapsedSeconds ?? 0,
  };
}

export interface TrackRetention {
  /** Settled rows to rewrite without their fixes. */
  compact: QueuedTrack[];
  /** Rows past the window that nothing references — delete outright. */
  remove: QueuedTrack[];
}

/**
 * What the device should do with its recorded-track rows right now. Pure, so the policy is tested
 * rather than inferred from a sqlite loop.
 *
 * Removal is checked first: a row old enough to delete shouldn't be rewritten on its way out. Age is
 * measured from when the skate *happened*, not from the last write — otherwise a track that keeps
 * being retried keeps renewing its own lease.
 */
export function trackRetention(
  tracks: readonly QueuedTrack[],
  opts: { now: number; referencedIds: ReadonlySet<string>; retentionMs?: number },
): TrackRetention {
  const retentionMs = opts.retentionMs ?? TRACK_RETENTION_MS;
  const retention: TrackRetention = { compact: [], remove: [] };
  for (const track of tracks) {
    if (opts.now - track.startedAt >= retentionMs && canRemoveTrack(track, opts.referencedIds)) {
      retention.remove.push(track);
    } else if (isTrackCompactable(track)) {
      retention.compact.push(track);
    }
  }
  return retention;
}
