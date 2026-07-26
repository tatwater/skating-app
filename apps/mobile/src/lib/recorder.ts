/**
 * The **track recorder** runtime (Phase 8, A-input #1) — start / pause / resume / stop over a durable
 * buffer, with the live session owned by a module singleton for the same reason `onIceMode` is: the
 * background location task runs outside React, so the buffer has to live somewhere both the task and
 * the UI can reach. React reads it through `useRecorder` (a `useSyncExternalStore` subscription).
 *
 * **Everything here is built around one fact: a skate cannot be re-recorded.** A report is a form you
 * can retype and a hazard is a pin you can re-drop, but three hours on the ice happen once. So:
 *
 * - The buffer is **checkpointed to sqlite while recording**, not at stop. A crash, an OS kill, or a
 *   dead battery loses at most `SAVE_INTERVAL_MS` of skating.
 * - On launch the recorder **adopts an unfinished session** rather than starting clean, so a crash on
 *   the ice doesn't silently split one skate in two.
 * - Stopping **finishes** the item and hands it to the flush queue; it never deletes anything. The
 *   only path that removes a track is an explicit user discard.
 *
 * **Battery is stated, not hidden (D3 copy).** Record mode runs the GPS radio at the upper end of the
 * ~5–12 %/hr range. The UI says so in plain words. We are not competing with a watch — this recorder
 * is for the phone-only skater and for capturing the path behind a report.
 */

import {
  appendPoint,
  createQueuedTrack,
  type QueuedTrack,
  type TrackPoint,
  trackStats,
} from '@skating/core';
import { randomUUID } from 'expo-crypto';
import { useSyncExternalStore } from 'react';
import { findUnfinishedTrack, saveTrack } from './draftStore';
import { ensureForegroundPermission } from './location';
import { setLocationDemand, setRecordLocationHandler } from './onIceTask';

/** How often the growing buffer is written to sqlite. The ceiling on what a crash can cost. */
const SAVE_INTERVAL_MS = 15_000;
/** ...or every this many new points, whichever comes first — a fast skater checkpoints by distance. */
const SAVE_INTERVAL_POINTS = 20;

/**
 * No accepted fix for this long ⇒ the phone hasn't moved ⇒ offer to stop ("I forgot to stop it").
 * The recorder never stops *itself* silently: a genuine rest on the ice must not truncate the skate,
 * so this raises a prompt and keeps recording until the skater answers.
 */
const STATIONARY_PROMPT_MS = 20 * 60_000;

/** What React renders from. The point buffer itself stays private — it's large and changes constantly. */
export interface RecorderPublic {
  /** `null` when nothing is being recorded. */
  status: 'idle' | 'recording' | 'paused';
  /** The live session's local id, for linking a report draft to it before either has a server id. */
  trackDraftId: string | null;
  pointCount: number;
  distanceMeters: number;
  elapsedSeconds: number;
  startedAt: number | null;
  /** True once we've seen no movement for a while — the UI offers "still skating?" / "stop". */
  stationaryPrompt: boolean;
  /** The per-session "also upload to Strava?" choice. */
  uploadToStrava: boolean;
}

const IDLE: RecorderPublic = {
  status: 'idle',
  trackDraftId: null,
  pointCount: 0,
  distanceMeters: 0,
  elapsedSeconds: 0,
  startedAt: null,
  stationaryPrompt: false,
  uploadToStrava: true,
};

let track: QueuedTrack | null = null;
let paused = false;
let lastAcceptedAt = 0;
let lastSavedAt = 0;
let pointsSinceSave = 0;
let snapshot: RecorderPublic = IDLE;
const listeners = new Set<() => void>();

function computeSnapshot(): RecorderPublic {
  if (!track) return IDLE;
  const stats = trackStats(track.points);
  return {
    status: paused ? 'paused' : 'recording',
    trackDraftId: track.id,
    pointCount: track.points.length,
    distanceMeters: stats.distanceMeters,
    elapsedSeconds: stats.elapsedSeconds,
    startedAt: track.startedAt,
    stationaryPrompt:
      !paused && lastAcceptedAt > 0 && Date.now() - lastAcceptedAt > STATIONARY_PROMPT_MS,
    uploadToStrava: track.uploadToStrava,
  };
}

function emit(): void {
  const next = computeSnapshot();
  // Cheap identity guard so a fix that changes nothing observable doesn't re-render mid-skate.
  if (
    next.status === snapshot.status &&
    next.trackDraftId === snapshot.trackDraftId &&
    next.pointCount === snapshot.pointCount &&
    next.stationaryPrompt === snapshot.stationaryPrompt &&
    next.uploadToStrava === snapshot.uploadToStrava
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe a component to the live recorder state. */
export function useRecorder(): RecorderPublic {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

/** Write the buffer to disk. Called on the checkpoint interval and at every lifecycle transition. */
function persist(): void {
  if (!track) return;
  try {
    saveTrack(track);
    lastSavedAt = Date.now();
    pointsSinceSave = 0;
  } catch {
    // A failed checkpoint must not kill the in-memory recording — the next one may well succeed, and
    // an in-memory track is still better than none.
  }
}

/**
 * Fold one OS fix into the buffer. Registered with the shared background task, so this runs whether
 * the app is foregrounded, backgrounded, or the screen is off.
 *
 * Paused means *dropped*, not buffered: a pause is the skater saying "this bit isn't my skate"
 * (driving between put-ins), and keeping those fixes would draw a road across the map.
 */
function ingestFix(point: TrackPoint): void {
  if (!track || paused) return;
  const decision = appendPoint(track.points, point);
  if (decision.accept) {
    lastAcceptedAt = Date.now();
    pointsSinceSave++;
  }
  if (pointsSinceSave >= SAVE_INTERVAL_POINTS || Date.now() - lastSavedAt >= SAVE_INTERVAL_MS) {
    persist();
  }
  emit();
}

/**
 * Begin recording. Takes foreground location permission (background is requested by on-ice mode's
 * flow and is best-effort here too — without it the recorder still works while the app is open).
 * Returns whether it started.
 */
export async function startRecording(
  opts: { uploadToStrava?: boolean; waterBodyId?: string; bodyName?: string } = {},
): Promise<boolean> {
  if (track) return true;
  if (!(await ensureForegroundPermission())) return false;

  const now = Date.now();
  track = createQueuedTrack({
    id: randomUUID(),
    // The key is minted here, at session start, and becomes the row's `providerActivityId` — so
    // every retry of this skate, days later if need be, dedupes to the same activity.
    idempotencyKey: randomUUID(),
    now,
    uploadToStrava: opts.uploadToStrava ?? true,
    ...(opts.waterBodyId !== undefined ? { waterBodyId: opts.waterBodyId } : {}),
    ...(opts.bodyName !== undefined ? { bodyName: opts.bodyName } : {}),
  });
  paused = false;
  lastAcceptedAt = now;
  lastSavedAt = 0;
  pointsSinceSave = 0;
  persist(); // an empty session on disk from the first moment — nothing depends on a later save
  await setLocationDemand('record', true);
  emit();
  return true;
}

/** Pause: keep the session, stop adding fixes. The GPS session stays up so resume is instant. */
export function pauseRecording(): void {
  if (!track || paused) return;
  paused = true;
  persist();
  emit();
}

export function resumeRecording(): void {
  if (!track || !paused) return;
  paused = false;
  lastAcceptedAt = Date.now(); // don't inherit the pause as stationary time
  emit();
}

/**
 * Stop recording and hand the session to the flush queue.
 *
 * Marks the item `finished` (which is what makes it flushable — an in-progress session never is) and
 * releases the record demand on the location session, so on-ice mode drops back to its cheap profile
 * if it's still armed. Returns the finished item so the caller can offer "turn this into a report?".
 */
export async function stopRecording(): Promise<QueuedTrack | null> {
  if (!track) return null;
  const finished: QueuedTrack = { ...track, finished: true, updatedAt: Date.now() };
  track = finished;
  persist();
  track = null;
  paused = false;
  await setLocationDemand('record', false);
  emit();
  return finished;
}

/** Flip the per-session Strava choice while recording (the UI's toggle). */
export function setUploadToStrava(next: boolean): void {
  if (!track) return;
  track = { ...track, uploadToStrava: next };
  persist();
  emit();
}

/**
 * Adopt a session left unfinished by a crash or an OS kill, called once at app start.
 *
 * Deliberately does **not** resume GPS: the app may be launching hours later, in a car, at home. It
 * restores the buffer so the skater sees their skate and can stop (and file) it, rather than finding
 * it silently gone. Returns the adopted session, if any.
 */
export async function adoptUnfinishedRecording(): Promise<QueuedTrack | null> {
  if (track) return track;
  let orphan: QueuedTrack | null = null;
  try {
    orphan = findUnfinishedTrack();
  } catch {
    return null;
  }
  if (!orphan) return null;
  track = orphan;
  paused = true; // stopped adding fixes when the app died; make that state explicit and visible
  lastAcceptedAt = 0;
  emit();
  return orphan;
}

// Register the fix handler with the shared background task (breaks the import cycle with onIceTask).
setRecordLocationHandler(ingestFix);
