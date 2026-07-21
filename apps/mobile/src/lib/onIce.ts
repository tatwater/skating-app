/**
 * The on-ice alert session (D54 Layer 1) — the pure half of "being warned", kept out of the GPS
 * watcher so the banner rules are testable without a device fix or a map.
 *
 * `@skating/core`'s `evaluateOnIceAlert` answers *what is near me*. This answers the questions that
 * are specific to showing it to someone moving on ice: which single alert becomes a banner, when a
 * banner may be replaced, and what "already alerted" means across a session.
 *
 * ⚠ **Silence is not an all-clear (D3).** An empty result means "nothing *reported* nearby", never
 * "the ice is fine" — and in v1 the watcher only runs while the app is foregrounded, which makes the
 * statement weaker still. Every surface built on this says so out loud.
 */

import {
  evaluateOnIceAlert,
  type HazardAlert,
  type HazardShape,
  type HazardType,
  type LatLng,
  type ProximityHazard,
} from '@skating/core'

/** The hazard fields the cached list gives us, as `hazards.listForBody` returns them. */
export interface HazardRow {
  _id: string
  type: HazardType
  geometryKind: HazardShape['geometryKind']
  geometry: unknown
  radiusMeters?: number
  bufferMeters?: number
  confirmCount: number
}

/** Narrow the server rows to what the pure evaluator needs. */
export function toProximityHazards(rows: readonly HazardRow[]): ProximityHazard[] {
  return rows.map((r) => ({
    id: r._id,
    type: r.type,
    confirmCount: r.confirmCount,
    shape: {
      geometryKind: r.geometryKind,
      geometry: r.geometry as HazardShape['geometry'],
      ...(r.radiusMeters !== undefined ? { radiusMeters: r.radiusMeters } : {}),
      ...(r.bufferMeters !== undefined ? { bufferMeters: r.bufferMeters } : {}),
    },
  }))
}

/**
 * One skating session's alert state.
 *
 * `alerted` persists for the whole session rather than resetting per fix: skating laps on a pond
 * would otherwise re-fire the same banner every circuit and train the skater to ignore it, which is
 * worse than never alerting at all.
 */
export interface AlertSession {
  alerted: ReadonlySet<string>
  banner: HazardAlert | null
}

export function emptyAlertSession(): AlertSession {
  return { alerted: new Set(), banner: null }
}

/**
 * Fold a GPS fix into the session.
 *
 * **A showing banner is never replaced.** Someone moving across ice generates a fix every couple of
 * seconds; swapping the banner underneath them would make it unreadable and, worse, could swap the
 * message between a warning and a confirm-prompt mid-tap. The current banner stands until it's
 * dismissed or acted on, and the newly-seen hazards simply wait their turn.
 *
 * A hazard is marked alerted the moment it becomes the banner, not when the banner is dismissed —
 * otherwise a skater who ignores a banner would be re-alerted about that same hazard forever.
 */
export function advanceAlertSession(
  session: AlertSession,
  coord: LatLng,
  hazards: readonly ProximityHazard[],
  options?: { alertBufferMeters?: number; confirmThreshold?: number },
): AlertSession {
  const alerts = evaluateOnIceAlert(coord, hazards, session.alerted, options)
  const next = alerts[0]
  if (!next) return session
  if (session.banner) {
    // Keep the visible banner, but don't let the queue behind it grow stale: the hazards we've now
    // decided not to show are left unalerted, so they can surface once this banner clears.
    return session
  }
  return { alerted: new Set([...session.alerted, next.hazardId]), banner: next }
}

/**
 * Dismiss the banner without saying anything about the hazard.
 *
 * Dismissing is emphatically **not** a verdict. "I swiped a banner away" and "that hazard is gone"
 * are different claims, and collapsing them is the D3 failure mode — so this touches the banner only
 * and never the hazard's lifecycle.
 */
export function dismissBanner(session: AlertSession): AlertSession {
  return { alerted: session.alerted, banner: null }
}

/**
 * Resolve which lake the skater is on from the two available sources (Phase 9 §Mobile "on-ice state").
 *
 * The **server** answer is authoritative and covers any listed lake, including one never opened on this
 * device. It arrives as `undefined` while loading and forever when offline, so until it answers we
 * fall back to the **offline cache** (drawer-viewed bodies only) — that's what keeps no-signal capture
 * resolving. Pure so the precedence is unit-tested rather than tangled into an effect.
 */
export function resolveOnIceBody(
  onlineBodyId: string | null | undefined,
  cachedBodyId: string | null,
): string | null {
  return onlineBodyId !== undefined ? onlineBodyId : cachedBodyId
}

/** Inputs to the once-per-open auto-select decision. */
export interface AutoSelectInput {
  resolvedBodyId: string | null
  alreadyAutoSelected: boolean
  /** True only when the app opened on the bare map (not a deep link into a drawer). */
  openedOnBareMap: boolean
  /** The live route — auto-select must not fire once the skater has navigated somewhere themselves. */
  onBareMapNow: boolean
}

/**
 * Whether to auto-select (navigate to) the on-ice lake. Fires at most once per app-open, only when the
 * app opened on the bare map and the skater hasn't since navigated away — so it frames the lake you're
 * standing on without ever yanking you out of something you deliberately opened.
 */
export function shouldAutoSelectOnIce(input: AutoSelectInput): boolean {
  return (
    input.resolvedBodyId !== null &&
    !input.alreadyAutoSelected &&
    input.openedOnBareMap &&
    input.onBareMapNow
  )
}
