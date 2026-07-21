/**
 * Foreground-location permission, requested through a single shared promise (Phase 9 §Mobile).
 *
 * The map framing (`MapView`) and the on-ice watcher (`_layout`) both need location and mount at the
 * same time. If one *checks* the permission while the other is still *prompting*, the checker sees
 * `undetermined` and gives up for the whole session — which is what left on-ice detection dead on a
 * fresh install. Routing both through this serializes concurrent callers onto one prompt: whoever
 * arrives first drives the dialog, everyone else awaits its answer.
 */

import * as Location from 'expo-location'

let inflight: Promise<boolean> | null = null

/**
 * Ensure foreground location is granted, prompting once if it hasn't been decided yet. Concurrent
 * callers share the in-flight request; sequential callers re-check (so a grant made later in Settings
 * is picked up). Never throws — a failure resolves to `false`, because no feature here is allowed to
 * hard-depend on location.
 */
export async function ensureForegroundPermission(): Promise<boolean> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const current = await Location.getForegroundPermissionsAsync()
      if (current.status === 'granted') return true
      // Already denied and the OS won't show the dialog again — don't bother prompting.
      if (current.status === 'denied' && !current.canAskAgain) return false
      const requested = await Location.requestForegroundPermissionsAsync()
      return requested.status === 'granted'
    } catch {
      return false
    } finally {
      // Cleared once settled so the *next* call re-checks the live status rather than caching a stale
      // "no". Concurrent callers already latched onto this same promise before it resolved.
      inflight = null
    }
  })()
  return inflight
}
