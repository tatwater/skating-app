/**
 * On-ice proximity evaluation (D54 Layer 1) — pure, so the identical logic runs on web, on mobile, and
 * in tests, and so the alerting path is unit-testable without a GPS or a map.
 *
 * **The architecture, and why it's shaped this way (D12/D54).** The server never learns where anyone
 * is. It syncs hazard *data* to devices that care about a lake; each phone evaluates its *own* GPS
 * against its own cached hazards. Positions never leave the device, there's no server fan-out, a
 * troll's blast radius is naturally limited to people physically on that same ice — and because the
 * hazards are already cached, the alert fires **with no cell signal**.
 *
 * **The confirm-gate _is_ the confirmation mechanism.** An unconfirmed hazard can't shout at anyone; it
 * can only ask "can you see it?" — and that ask is exactly how the lifecycle collects the confirmation
 * it needs. Only once a hazard is independently confirmed does it promote to a real warning.
 *
 * ⚠ **Silence is not an all-clear (D3).** This evaluator returning nothing means "nothing *reported*
 * nearby", never "the ice is fine". That is a much weaker statement than the absence of an alarm feels
 * like, and it gets weaker still in v1, where the watcher only runs while the app is foregrounded. Any
 * surface built on this module must say so — see `hazardCopy.ts`.
 */

import type { LatLng } from './geometry'
import { distanceToHazard, type HazardShape } from './hazardGeometry'
import { isProvisional } from './hazardLifecycle'
import { type HazardType, isPassageMarker } from './types'

/** The minimum a hazard must expose for proximity evaluation — a cache row, not a full document. */
export interface ProximityHazard {
  id: string
  type: HazardType
  shape: HazardShape
  confirmCount: number
}

/** Why a hazard surfaced, which decides how loudly the UI may speak. */
export type HazardAlertKind =
  /** Independently confirmed → the full "⚠ hazard ahead" warning. */
  | 'warning'
  /** Not yet confirmed → the soft "can you see it?" prompt, whose answer *is* the confirmation. */
  | 'confirm_request'

export interface HazardAlert {
  hazardId: string
  type: HazardType
  kind: HazardAlertKind
  /** Metres from the skater to the hazard footprint's edge; 0 when they are inside it. */
  distanceMeters: number
}

/**
 * How close (in metres beyond the hazard's own footprint) triggers an alert. Generous on purpose: the
 * footprint is already fuzzy, GPS on a cold phone is not great, and a skater with speed carries a long
 * way. Tunable in Phase 7 (D49).
 */
export const DEFAULT_ALERT_BUFFER_M = 150

export interface EvaluateOnIceAlertOptions {
  alertBufferMeters?: number
  confirmThreshold?: number
}

/**
 * Which cached hazards warrant an alert for a skater at `coord`, excluding any already alerted this
 * session. Returns nearest-first, so a UI that shows only one banner shows the most urgent.
 *
 * `alreadyAlerted` is the per-session dedup set — without it, skating laps on a pond would re-fire the
 * same alert every circuit and train the skater to ignore it, which would be worse than not alerting.
 * Callers own the set's lifetime (it resets per session, not per app launch).
 */
export function evaluateOnIceAlert(
  coord: LatLng,
  hazards: readonly ProximityHazard[],
  alreadyAlerted: ReadonlySet<string>,
  options: EvaluateOnIceAlertOptions = {},
): HazardAlert[] {
  const { alertBufferMeters = DEFAULT_ALERT_BUFFER_M, confirmThreshold } = options

  const alerts: HazardAlert[] = []
  for (const hazard of hazards) {
    if (alreadyAlerted.has(hazard.id)) continue
    // A ridge crossing marks where you *can* get across — it's a passage marker, not a danger (research
    // §4). Firing "⚠ hazard ahead" at someone approaching the safest point on the ridge would be
    // actively counterproductive, so it never alerts. It still renders on the map.
    if (isPassageMarker(hazard.type)) continue

    // One malformed cached row must never silence the alerts for every *other* hazard on the lake.
    // `isValidHazardShape` should keep such rows out of storage, but this loop runs in the on-ice
    // watcher against whatever the cache holds, so it defends itself: a hazard whose distance can't be
    // computed is skipped, not thrown. Failing safe here means failing *loud* — the other pins still
    // warn — which is the correct direction for safety content.
    let distanceMeters: number
    try {
      distanceMeters = distanceToHazard(coord, hazard.shape)
    } catch {
      continue
    }
    if (!Number.isFinite(distanceMeters) || distanceMeters > alertBufferMeters) continue

    alerts.push({
      hazardId: hazard.id,
      type: hazard.type,
      kind: isProvisional(hazard.confirmCount, confirmThreshold) ? 'confirm_request' : 'warning',
      distanceMeters,
    })
  }

  return alerts.sort((a, b) => a.distanceMeters - b.distanceMeters)
}

/**
 * Whether a skater is inside a hazard's footprint right now — the strongest possible signal, worth
 * distinguishing from "approaching" so the UI can escalate its tone.
 */
export function isInsideHazard(coord: LatLng, shape: HazardShape): boolean {
  return distanceToHazard(coord, shape) === 0
}
