/**
 * The background-location TaskManager task behind on-ice mode (D54 Layer 2).
 *
 * `TaskManager.defineTask` must run at module load, in global scope — so this module is imported once
 * (from the `(map)` layout) purely to register the task. While on-ice mode is armed, `expo-location`
 * delivers fixes here even with the app backgrounded and the screen asleep, via an Android foreground
 * service (its persistent notification *is* the "on-ice mode is on" indicator) / iOS background-location
 * updates. Each fix is handed to whatever handler `onIceMode` registered — positions never leave the
 * device (D12); the alert is evaluated and fired entirely on-device.
 *
 * The task does **not** import `onIceMode` directly: `onIceMode` starts/stops this task, so importing it
 * back would be a cycle. Instead `onIceMode` registers its fix handler via `setOnIceLocationHandler`.
 */

import type { DirectionalFix } from '@skating/core';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

export const ONICE_LOCATION_TASK = 'skating-on-ice-location';

let handler: ((fix: DirectionalFix) => void) | null = null;

/** Register the on-ice fix handler (called once by `onIceMode`). Keeps this module cycle-free. */
export function setOnIceLocationHandler(fn: (fix: DirectionalFix) => void): void {
  handler = fn;
}

/** Turn an OS location into the motion vector the projection needs. Heading/speed are `-1` when unknown. */
function toDirectionalFix(loc: Location.LocationObject): DirectionalFix {
  return {
    coord: { lat: loc.coords.latitude, lng: loc.coords.longitude },
    headingDeg: loc.coords.heading ?? -1,
    speedMps: loc.coords.speed ?? -1,
  };
}

TaskManager.defineTask(ONICE_LOCATION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const { locations } = data as { locations: Location.LocationObject[] };
  const latest = locations.at(-1);
  if (latest && handler) handler(toDirectionalFix(latest));
});

/**
 * Start background location for the session. Idempotent — starting an already-started task throws, so
 * we check first. The foreground service (Android) shows the persistent "on-ice mode is on" notification;
 * `showsBackgroundLocationIndicator` is the iOS blue pill. `Balanced` accuracy, not `BestForNavigation`,
 * because cold-weather battery matters more than sub-metre precision for a fuzzy hazard alert.
 */
export async function startOnIceLocationUpdates(): Promise<void> {
  const already = await Location.hasStartedLocationUpdatesAsync(ONICE_LOCATION_TASK).catch(
    () => false,
  );
  if (already) return;
  await Location.startLocationUpdatesAsync(ONICE_LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: 20,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'On-ice mode is on',
      notificationBody:
        'Watching for reported ice hazards ahead while you skate. Tap to open Skating.',
    },
  });
}

/** Stop background location. Idempotent — safe to call when it was never started. */
export async function stopOnIceLocationUpdates(): Promise<void> {
  const already = await Location.hasStartedLocationUpdatesAsync(ONICE_LOCATION_TASK).catch(
    () => false,
  );
  if (already) await Location.stopLocationUpdatesAsync(ONICE_LOCATION_TASK);
}
