/**
 * The background-location TaskManager task behind **on-ice mode** (D54 Layer 2) **and the Phase 8
 * track recorder** — one task, two consumers, one GPS profile at a time.
 *
 * `TaskManager.defineTask` must run at module load, in global scope — so this module is imported once
 * (from the `(map)` layout) purely to register the task. While either consumer is active,
 * `expo-location` delivers fixes here even with the app backgrounded and the screen asleep, via an
 * Android foreground service (its persistent notification *is* the "we're using your location"
 * indicator) / iOS background-location updates. Positions never leave the device except as a track the
 * skater chose to record (D12).
 *
 * **Why one task and not two.** You cannot run two `startLocationUpdatesAsync` sessions, and two
 * Android foreground-service notifications for "we're watching your GPS" would be both impossible and
 * dishonest. So the two user choices — (a) *keep watching for hazards*, (b) *record my skate* — are
 * **orthogonal demands** on one session, and the profile is derived from whichever is active.
 *
 * **Record fidelity wins the knob.** On-ice alerts run at `Balanced`/20 m because cold-weather battery
 * matters more than sub-metre precision for a fuzzy hazard alert. A recorded track needs
 * `BestForNavigation`/~5 m or it produces a jagged line, inflated distance and an ugly activity. When
 * both are on, record wins — **you can always alert off a finer stream; you can't refine a coarse one
 * after the fact.** Changing profile means stop-then-start (the OS gives no way to retune a live
 * session), which `applyDemands` serializes so the two consumers can't race each other.
 *
 * The task does **not** import `onIceMode` or `recorder` directly: both start/stop this task, so
 * importing back would be a cycle. They register handlers instead.
 */

import type { DirectionalFix, TrackPoint } from '@skating/core';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { AppState } from 'react-native';

export const ONICE_LOCATION_TASK = 'skating-on-ice-location';

/** Who currently wants background location. Both may be on at once. */
export type LocationDemand = 'on_ice' | 'record';

/**
 * The two GPS profiles (the research doc's table). `hazard` is deliberately cheap; `record` is
 * deliberately not, and the recorder UI says so plainly rather than hiding the cost (D3 copy).
 */
const PROFILES = {
  hazard: {
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: 20,
    notificationTitle: 'On-ice mode is on',
    notificationBody:
      'Watching for reported ice hazards ahead while you skate. Tap to open Skating.',
  },
  record: {
    // BestForNavigation keeps the GPS radio on more than Balanced — this is the upper end of the
    // ~5–12 %/hr budget, and it's the price of a track worth uploading.
    accuracy: Location.Accuracy.BestForNavigation,
    distanceInterval: 5,
    notificationTitle: 'Recording your skate',
    notificationBody: 'Keeping a GPS track until you stop it. This uses more battery. Tap to open.',
  },
} as const;

type ProfileName = keyof typeof PROFILES;

let onIceHandler: ((fix: DirectionalFix) => void) | null = null;
let recordHandler: ((point: TrackPoint) => void) | null = null;

const demands: Record<LocationDemand, boolean> = { on_ice: false, record: false };
let activeProfile: ProfileName | null = null;
/** Serializes profile changes — two consumers toggling at once must not interleave stop/start. */
let applying: Promise<void> = Promise.resolve();

/** Register the on-ice fix handler (called once by `onIceMode`). Keeps this module cycle-free. */
export function setOnIceLocationHandler(fn: (fix: DirectionalFix) => void): void {
  onIceHandler = fn;
}

/** Register the recorder's fix handler (called once by `recorder`). */
export function setRecordLocationHandler(fn: (point: TrackPoint) => void): void {
  recordHandler = fn;
}

/** Turn an OS location into the motion vector the hazard projection needs. Unknown ⇒ `-1`. */
function toDirectionalFix(loc: Location.LocationObject): DirectionalFix {
  return {
    coord: { lat: loc.coords.latitude, lng: loc.coords.longitude },
    headingDeg: loc.coords.heading ?? -1,
    speedMps: loc.coords.speed ?? -1,
  };
}

/** Turn an OS location into a track point. Unknown accuracy/altitude become absent, not zero. */
export function toTrackPoint(loc: Location.LocationObject): TrackPoint {
  return {
    lat: loc.coords.latitude,
    lng: loc.coords.longitude,
    t: loc.timestamp,
    ...(loc.coords.altitude !== null ? { elevation: loc.coords.altitude } : {}),
    ...(loc.coords.accuracy !== null ? { accuracy: loc.coords.accuracy } : {}),
    ...(loc.coords.speed !== null ? { speed: loc.coords.speed } : {}),
    ...(loc.coords.heading !== null ? { heading: loc.coords.heading } : {}),
  };
}

TaskManager.defineTask(ONICE_LOCATION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const { locations } = data as { locations: Location.LocationObject[] };
  const latest = locations.at(-1);
  if (!latest) return;

  // The recorder takes EVERY fix, foreground included — a dropped fix is a gap in an unrepeatable
  // track. Duplicate delivery is harmless: `appendPoint`'s out-of-order and stationary gates discard
  // a fix the buffer already has, so the recorder is idempotent w.r.t. the same timestamp. Background
  // delivery batches fixes, so feed them all: a screen-off stretch keeps its shape instead of
  // collapsing to one point per delivery.
  if (recordHandler) for (const loc of locations) recordHandler(toTrackPoint(loc));

  // On-ice alerts, unchanged: background updates are delivered in the foreground too, but there the
  // layout's own `watchPositionAsync` is already feeding every fix into the same session — so
  // forwarding here as well would evaluate each fix twice (and drain a cold phone for nothing). This
  // path exists for the *background* case; when the app is active, defer to the foreground watcher.
  if (AppState.currentState === 'active') return;
  if (onIceHandler) onIceHandler(toDirectionalFix(latest));
});

/** The profile the current demands call for — `null` when nobody wants location. */
function desiredProfile(): ProfileName | null {
  if (demands.record) return 'record'; // record fidelity wins the knob
  if (demands.on_ice) return 'hazard';
  return null;
}

/** Stop the OS session if it's running. Idempotent — safe when it was never started. */
async function stopUpdates(): Promise<void> {
  const started = await Location.hasStartedLocationUpdatesAsync(ONICE_LOCATION_TASK).catch(
    () => false,
  );
  if (started) await Location.stopLocationUpdatesAsync(ONICE_LOCATION_TASK);
}

async function startUpdates(profile: ProfileName): Promise<void> {
  const p = PROFILES[profile];
  await Location.startLocationUpdatesAsync(ONICE_LOCATION_TASK, {
    accuracy: p.accuracy,
    distanceInterval: p.distanceInterval,
    pausesUpdatesAutomatically: false, // the OS pausing a recording would silently lose the tail
    showsBackgroundLocationIndicator: true, // the iOS blue pill — the honest "we're using GPS" signal
    foregroundService: {
      notificationTitle: p.notificationTitle,
      notificationBody: p.notificationBody,
    },
  });
}

/**
 * Reconcile the OS session with the current demands. Queued behind any in-flight change so a rapid
 * "start recording" → "stop on-ice" can't leave the session running the wrong profile (or, worse,
 * throw from starting an already-started task).
 */
function applyDemands(): Promise<void> {
  applying = applying
    .catch(() => undefined)
    .then(async () => {
      const wanted = desiredProfile();
      if (wanted === activeProfile) return;
      await stopUpdates();
      activeProfile = null;
      if (wanted === null) return;
      try {
        await startUpdates(wanted);
        activeProfile = wanted;
      } catch {
        // Couldn't start (permission denied, service unavailable) — the caller degrades: on-ice mode
        // keeps foreground banners, the recorder keeps whatever the foreground watcher delivers.
      }
    });
  return applying;
}

/** Declare (or withdraw) one consumer's need for background location, then reconcile the session. */
export async function setLocationDemand(kind: LocationDemand, wanted: boolean): Promise<void> {
  demands[kind] = wanted;
  await applyDemands();
}

/** Which profile the OS session is actually running — for the recorder UI's battery copy and tests. */
export function currentLocationProfile(): ProfileName | null {
  return activeProfile;
}

/** Start background location for on-ice mode. Kept for the existing `onIceMode` call site. */
export async function startOnIceLocationUpdates(): Promise<void> {
  await setLocationDemand('on_ice', true);
}

/** Stop on-ice mode's demand. The session survives (at record fidelity) if the recorder wants it. */
export async function stopOnIceLocationUpdates(): Promise<void> {
  await setLocationDemand('on_ice', false);
}
