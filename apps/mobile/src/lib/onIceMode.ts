/**
 * On-ice mode (D54 Layer 2) — the runtime that turns the pure `advanceOnIceSession` fold into live
 * alerts, and the single owner of the session dedup set shared across the foreground banner and the
 * background notification.
 *
 * It's a plain module singleton (not React state) for one reason: the background location task runs
 * outside React, so the `alerted` set, the cached hazards, and the last fix must live somewhere both the
 * task and the UI can reach. React reads it through `useOnIceMode` (a `useSyncExternalStore` subscription
 * to `{ armed, cadence, banner }`); the layout's foreground watcher and the background task both push
 * fixes in through `ingestOnIceFix`.
 *
 * **Medium is decided by app state, and the dedup set is shared.** Foregrounded, a fresh alert becomes
 * the in-app banner (never swapped out from under a moving skater — `advanceOnIceSession` owns that).
 * Backgrounded (phone pocketed, screen asleep), there is no visible banner, so the same fresh alert fires
 * a **local** notification instead. Because both paths advance one shared `alerted` set, a hazard warned
 * about one way never re-fires the other.
 *
 * ⚠ **Silence is not an all-clear (D3).** A quiet session means nothing was *reported* on your path, not
 * that the ice is safe — so the disclaimer rides on every banner and notification, never buried away.
 */

import {
  type DirectionalFix,
  hazardTypeLabel,
  NO_ALERT_IS_NOT_ALL_CLEAR,
  type ProximityHazard,
} from '@skating/core';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { ensureForegroundPermission } from './location';
import { ensureNotificationPermission } from './notifications';
import {
  type AlertSession,
  advanceOnIceSession,
  dismissBanner,
  emptyAlertSession,
  type RealertCadence,
  type SessionAlert,
} from './onIce';
import {
  setOnIceLocationHandler,
  startOnIceLocationUpdates,
  stopOnIceLocationUpdates,
} from './onIceTask';

/** What React needs to render — the volatile session internals stay private to the module. */
export interface OnIceModePublic {
  armed: boolean;
  cadence: RealertCadence;
  banner: SessionAlert | null;
}

let armed = false;
let cadence: RealertCadence = 'once_per_session';
let session: AlertSession = emptyAlertSession();
let hazards: readonly ProximityHazard[] = [];
let lastFix: DirectionalFix | null = null;

// Cached immutable snapshot so `useSyncExternalStore` sees a stable reference between real changes
// (returning a fresh object every call would loop it forever).
let snapshot: OnIceModePublic = { armed, cadence, banner: null };
const listeners = new Set<() => void>();

function emit(): void {
  // Only wake subscribers when something they can observe actually changed. This is what keeps the
  // frequent no-op ingests (every GPS fix that raises nothing new, and the boot-time `setOnIceHazards([])`
  // before any hazard or fix exists) from poking React — including during the initial mount commit, which
  // is what produced the "state update on a component that hasn't mounted yet" warning. `session.banner`
  // keeps a stable reference across no-op advances, so identity comparison is correct here.
  if (
    snapshot.armed === armed &&
    snapshot.cadence === cadence &&
    snapshot.banner === session.banner
  ) {
    return;
  }
  snapshot = { armed, cadence, banner: session.banner };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe a component to `{ armed, cadence, banner }`. */
export function useOnIceMode(): OnIceModePublic {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

/**
 * Fold one fix into the session and present anything fresh. Called by the foreground watcher (layout)
 * and by the background task, so it decides its medium by live app state rather than by who called it.
 */
export function ingestOnIceFix(fix: DirectionalFix): void {
  lastFix = fix;
  const active = AppState.currentState === 'active';
  // Backgrounded, there is no banner to protect — clear it so a fresh alert can fire as a notification.
  // The dedup sets (`alerted` + `approached`) carry across regardless, so neither path re-fires the other.
  const base: AlertSession = active
    ? session
    : { alerted: session.alerted, approached: session.approached, banner: null };
  const result = advanceOnIceSession(base, fix, hazards, { cadence, directional: armed });

  if (active) {
    session = { alerted: result.alerted, approached: result.approached, banner: result.banner };
  } else {
    session = { alerted: result.alerted, approached: result.approached, banner: null };
    // Only fire while armed. `disarmOnIceMode` flips `armed` synchronously but stops the background task
    // asynchronously, so the OS can still deliver a straggler fix in that gap — this guard keeps it from
    // surprising someone who just tapped "Stop" with a fresh notification. (A background fix only reaches
    // here while the task is running, i.e. an armed session; the guard just covers the teardown race.)
    if (armed && result.fired) void fireHazardNotification(result.fired);
  }
  emit();
}

/**
 * Replace the cached hazards (the lake's `listForBody` result, pushed by the map UI) and re-evaluate
 * against the last fix — so a stationary skater whose lake just finished syncing, or near whom a hazard
 * was freshly posted, still gets the alert without waiting for a new GPS fix.
 */
export function setOnIceHazards(next: readonly ProximityHazard[]): void {
  hazards = next;
  if (lastFix) ingestOnIceFix(lastFix);
  else emit();
}

/** Dismiss the visible banner (never a verdict — see `dismissBanner`). */
export function dismissOnIceBanner(): void {
  session = dismissBanner(session);
  emit();
}

/** Switch the re-alert cadence (once-per-session ↔ every-approach). */
export function setOnIceCadence(next: RealertCadence): void {
  cadence = next;
  emit();
}

/**
 * Arm on-ice mode: take the permissions, then start the background location session. Foreground
 * location is required (no point otherwise); notifications and background location are best-effort — if
 * the skater declines them, on-ice mode still shows foreground banners, it just can't reach a pocketed
 * phone. Returns whether it armed.
 */
export async function armOnIceMode(): Promise<boolean> {
  if (armed) return true;
  const foreground = await ensureForegroundPermission();
  if (!foreground) return false;
  // Best-effort: the whole point is background delivery, but declining either only degrades to
  // foreground banners rather than failing — on-ice mode must never hard-depend on a granted prompt.
  await ensureNotificationPermission();
  try {
    await Location.requestBackgroundPermissionsAsync();
  } catch {
    // No background permission → foreground-only coverage. Still worth arming.
  }
  try {
    await startOnIceLocationUpdates();
  } catch {
    // Couldn't start the background session (e.g. permission denied) — foreground still works.
  }
  armed = true;
  emit();
  return true;
}

/** Disarm on-ice mode and stop the background session. The alerted set is left intact for the session. */
export function disarmOnIceMode(): void {
  if (!armed) return;
  armed = false;
  void stopOnIceLocationUpdates();
  emit();
}

/** The notification tapped-open payload the deep-link handler reads (Layer 2 lands on the confirm control). */
export interface HazardNotificationData {
  hazardId: string;
  action: 'confirm';
}

async function fireHazardNotification(alert: SessionAlert): Promise<void> {
  try {
    const label = hazardTypeLabel(alert.type);
    const ahead = alert.secondsToEncounter !== undefined;
    const title =
      alert.kind === 'warning'
        ? ahead
          ? `⚠ ${label} ahead`
          : `⚠ ${label} nearby`
        : `${label} reported near you`;
    const lead = ahead ? `About ${Math.round(alert.secondsToEncounter ?? 0)} s ahead. ` : '';
    // The tap lands pre-focused on the "is it still there?" confirm control (`action: 'confirm'`), so
    // the CTA names *reporting the hazard's presence* — never a bare "got it" acknowledgement. A
    // confirmed hazard asks whether it's still there; an unconfirmed one asks whether it's there at all.
    const ask =
      alert.kind === 'warning'
        ? 'Tap to view — is it still there?'
        : 'Tap to check — can you see it?';
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body: `${lead}${ask} ${NO_ALERT_IS_NOT_ALL_CLEAR}`,
        data: { hazardId: alert.hazardId, action: 'confirm' } satisfies HazardNotificationData,
      },
      trigger: null,
    });
  } catch {
    // A notification that fails to schedule is not worth interrupting someone on ice over.
  }
}

// Register this module's fix handler with the background task (breaks the import cycle), and make
// notifications actually surface while the app is foregrounded too (so a background alert that arrives
// as the skater pulls the phone out is still shown).
setOnIceLocationHandler(ingestOnIceFix);
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});
