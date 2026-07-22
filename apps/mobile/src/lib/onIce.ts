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
  DEFAULT_ALERT_BUFFER_M,
  type DirectionalFix,
  distanceToHazard,
  evaluateDirectionalAlert,
  evaluateOnIceAlert,
  type HazardAlert,
  type HazardShape,
  type HazardType,
  type ProximityHazard,
} from '@skating/core';

/** The hazard fields the cached list gives us, as `hazards.listForBody` returns them. */
export interface HazardRow {
  _id: string;
  type: HazardType;
  geometryKind: HazardShape['geometryKind'];
  geometry: unknown;
  radiusMeters?: number;
  bufferMeters?: number;
  /** The body-clipped footprint (Phase 9.5), when the server stored one. Broad, narrowed on use. */
  clippedFootprint?: unknown;
  confirmCount: number;
}

/** Narrow a stored clipped footprint to the areal geometry the distance math measures against. */
function arealFootprint(value: unknown): ProximityHazard['clippedFootprint'] {
  if (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    ((value as { type: unknown }).type === 'Polygon' ||
      (value as { type: unknown }).type === 'MultiPolygon')
  ) {
    return value as ProximityHazard['clippedFootprint'];
  }
  return undefined;
}

/** Narrow the server rows to what the pure evaluator needs. */
export function toProximityHazards(rows: readonly HazardRow[]): ProximityHazard[] {
  return rows.map((r) => {
    const clippedFootprint = arealFootprint(r.clippedFootprint);
    return {
      id: r._id,
      type: r.type,
      confirmCount: r.confirmCount,
      shape: {
        geometryKind: r.geometryKind,
        geometry: r.geometry as HazardShape['geometry'],
        ...(r.radiusMeters !== undefined ? { radiusMeters: r.radiusMeters } : {}),
        ...(r.bufferMeters !== undefined ? { bufferMeters: r.bufferMeters } : {}),
      },
      ...(clippedFootprint ? { clippedFootprint } : {}),
    };
  });
}

/** Re-alert cadence (founder call, 2026-07-21) — how often the same hazard may alert you. */
export type RealertCadence =
  /** One alert per hazard for the whole armed session; if you leave and come back, you remember. */
  | 'once_per_session'
  /** Re-alert on each genuine re-approach — for people who want the reminder. */
  | 'every_approach';

/**
 * How far past a hazard's alert buffer the skater must get before **every-approach** mode re-arms it,
 * as a multiple of the alert buffer. This hysteresis is what keeps "every approach" from collapsing
 * into "every fix": a skater loitering at the edge of the buffer can't machine-gun the same alert,
 * because the pin only re-arms once they've clearly skated *away* (past buffer × this).
 */
export const DEFAULT_HYSTERESIS_MULTIPLIER = 2;

/** A raised alert — a Layer-1 proximity hit, or a Layer-2 directional one carrying its lead time. */
export interface SessionAlert extends HazardAlert {
  /** Present only for a directional (Layer-2) alert: seconds until the projected path reaches it. */
  secondsToEncounter?: number;
}

/**
 * One skating session's alert state.
 *
 * `alerted` persists for the whole session rather than resetting per fix: skating laps on a pond
 * would otherwise re-fire the same banner every circuit and train the skater to ignore it, which is
 * worse than never alerting at all. It is **shared across the foreground banner and the background
 * notification path** (via the `onIceMode` store), so a hazard warned about one way never re-fires the
 * other. In every-approach mode it is selectively released; in once-per-session it never is.
 */
export interface AlertSession {
  alerted: ReadonlySet<string>;
  banner: SessionAlert | null;
}

export function emptyAlertSession(): AlertSession {
  return { alerted: new Set(), banner: null };
}

export interface AdvanceOnIceOptions {
  /** Once per session (default) vs re-alert on each genuine re-approach. */
  cadence?: RealertCadence;
  /**
   * Include the Layer-2 directional "hazard ahead" projection. Off (default) is Layer-1 proximity
   * only — the unarmed foreground behaviour. On is armed on-ice mode.
   */
  directional?: boolean;
  alertBufferMeters?: number;
  confirmThreshold?: number;
  leadMinSec?: number;
  leadMaxSec?: number;
  minSpeedMps?: number;
  sampleStepMeters?: number;
  /** Override the every-approach release distance; defaults to `alertBufferMeters × multiplier`. */
  hysteresisMeters?: number;
}

export interface AdvanceOnIceResult extends AlertSession {
  /** The alert newly raised on this fix (to show as a banner or fire as a notification), else null. */
  fired: SessionAlert | null;
}

/**
 * Fold one GPS fix into the session — the unified Layer-1 (proximity) + Layer-2 (directional) step.
 * Pure, so the foreground banner and the background notification path run *identical* rules against one
 * shared dedup set, and so all of it is unit-tested without a device or a map.
 *
 * **A showing banner is never replaced.** Someone moving across ice generates a fix every couple of
 * seconds; swapping the banner underneath them would make it unreadable and, worse, could swap the
 * message between a warning and a confirm-prompt mid-tap. The current banner stands until it's
 * dismissed or acted on, and newly-seen hazards simply wait their turn. (The background path clears the
 * banner — there is nothing visible to protect — so a notification fires instead; see `onIceMode`.)
 *
 * A hazard is marked alerted the moment it fires, not when the banner is dismissed — otherwise a skater
 * who ignores it would be re-alerted forever. `fired` is what the caller presents (banner or
 * notification) and is null when nothing new fired.
 */
export function advanceOnIceSession(
  session: AlertSession,
  fix: DirectionalFix,
  hazards: readonly ProximityHazard[],
  options: AdvanceOnIceOptions = {},
): AdvanceOnIceResult {
  const {
    cadence = 'once_per_session',
    directional = false,
    alertBufferMeters = DEFAULT_ALERT_BUFFER_M,
    confirmThreshold,
    leadMinSec,
    leadMaxSec,
    minSpeedMps,
    sampleStepMeters,
    hysteresisMeters = alertBufferMeters * DEFAULT_HYSTERESIS_MULTIPLIER,
  } = options;

  // Every-approach: release any suppressed hazard the skater has clearly skated away from, so a real
  // re-approach can alert again. Distance is to the footprint edge (0 inside) — the same measure the
  // alert uses. Once-per-session never releases: you're expected to remember where the danger was.
  let alerted = session.alerted;
  if (cadence === 'every_approach' && alerted.size > 0) {
    const released = new Set(alerted);
    let changed = false;
    for (const hazard of hazards) {
      if (!released.has(hazard.id)) continue;
      let distance: number;
      try {
        distance = distanceToHazard(fix.coord, hazard.shape, hazard.clippedFootprint);
      } catch {
        continue;
      }
      if (Number.isFinite(distance) && distance > hysteresisMeters) {
        released.delete(hazard.id);
        changed = true;
      }
    }
    if (changed) alerted = released;
  }

  const proximity = evaluateOnIceAlert(fix.coord, hazards, alerted, {
    alertBufferMeters,
    confirmThreshold,
  });
  const ahead: SessionAlert[] = directional
    ? evaluateDirectionalAlert(fix, hazards, alerted, {
        leadMinSec,
        leadMaxSec,
        minSpeedMps,
        sampleStepMeters,
        confirmThreshold,
      })
    : [];
  // Nearest current edge wins: a proximity hit (distance = how far you are *now*) sorts ahead of a
  // directional one (distance = where the path meets the footprint), so "you're on it" beats "it's
  // ahead" when both apply to the same fix.
  const top = [...proximity, ...ahead].sort((a, b) => a.distanceMeters - b.distanceMeters)[0];

  if (!top) return { alerted, banner: session.banner, fired: null };
  if (session.banner) return { alerted, banner: session.banner, fired: null };
  return { alerted: new Set([...alerted, top.hazardId]), banner: top, fired: top };
}

/**
 * Dismiss the banner without saying anything about the hazard.
 *
 * Dismissing is emphatically **not** a verdict. "I swiped a banner away" and "that hazard is gone"
 * are different claims, and collapsing them is the D3 failure mode — so this touches the banner only
 * and never the hazard's lifecycle.
 */
export function dismissBanner(session: AlertSession): AlertSession {
  return { alerted: session.alerted, banner: null };
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
  return onlineBodyId !== undefined ? onlineBodyId : cachedBodyId;
}

/** Inputs to the once-per-open auto-select decision. */
export interface AutoSelectInput {
  resolvedBodyId: string | null;
  alreadyAutoSelected: boolean;
  /** True only when the app opened on the bare map (not a deep link into a drawer). */
  openedOnBareMap: boolean;
  /** The live route — auto-select must not fire once the skater has navigated somewhere themselves. */
  onBareMapNow: boolean;
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
  );
}
