/**
 * Notification-permission request, serialized through a single shared promise — the on-ice-mode sibling
 * of `location.ts`'s `ensureForegroundPermission` (D54 Layer 2).
 *
 * The Phase 9.5 on-ice directional alert (`hazardProjection`) is delivered as a **local** notification
 * (no push token, no server — computed and fired on-device, so D12 holds). Permission is asked for
 * **lazily, the first time the skater arms on-ice mode** — never on cold launch — because a permission
 * prompt the moment the app opens is exactly the friction that gets it denied. Arming the map watcher and
 * arming notifications can both fire in the same tick, so both route through this singleton to avoid
 * stacking two prompts.
 */

import * as Notifications from 'expo-notifications';

let inflight: Promise<boolean> | null = null;

/**
 * Ensure notification permission is granted, prompting once if it hasn't been decided yet. Concurrent
 * callers share the in-flight request; sequential callers re-check (so a grant made later in Settings is
 * picked up). Never throws — a failure resolves to `false`, because on-ice mode must degrade to the
 * in-app foreground banner rather than hard-fail when the skater declines notifications.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const current = await Notifications.getPermissionsAsync();
      if (current.granted) return true;
      // Already denied and the OS won't show the dialog again — don't bother prompting.
      if (!current.canAskAgain) return false;
      const requested = await Notifications.requestPermissionsAsync();
      return requested.granted;
    } catch {
      return false;
    } finally {
      // Cleared once settled so the *next* call re-checks live status rather than caching a stale "no".
      // Concurrent callers already latched onto this same promise before it resolved.
      inflight = null;
    }
  })();
  return inflight;
}
