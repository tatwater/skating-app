/**
 * On-ice **directional** projection (D54 Layer 2) — "⚠ open water ~45 s ahead". Pure, so the same
 * "hazard ahead" math runs on device and in tests without a GPS, a compass, or a map.
 *
 * **How it differs from Layer 1.** `hazardProximity.evaluateOnIceAlert` answers *what is near me right
 * now* — a radius around a stationary point. This answers *what am I skating toward* — it projects the
 * skater's path forward from their **course over ground** and speed and asks which hazards that path
 * runs into within the next 30–60 seconds. Layer 1 fires when you pull the phone out of your pocket;
 * this fires while you skate, as a background local notification, so you hear about the lead ahead before
 * you reach it.
 *
 * **Course over ground, not a compass (2026-07-21 founder call).** Nobody skates holding the phone out
 * in front; it's face-down in a jacket pocket, tumbling, so a magnetometer heading is noise. GPS course
 * (`LocationObject.coords.heading`) is only meaningful while actually moving, so below a walking-pace
 * speed floor — or when the OS reports heading unknown (`< 0`) — this evaluator stays silent and Layer 1
 * covers the "you're right on it" case.
 *
 * **The path is tested against the same footprint the map draws and Layer 1 measures.** We walk the
 * projected course forward in fixed steps and test each step with `distanceToHazard` — the *identical*
 * buffered-footprint function behind the rendered halo and the proximity alert — so "warned about ahead"
 * can never drift from "drawn" or from "warned about near." Sampling (not an analytic segment-∩-polygon)
 * is deliberate: it keeps the module small and matches the footprint's honest fuzziness. Its one limit —
 * a footprint narrower than the sample step, dead ahead, can be stepped over — is bounded by keeping the
 * step small and, more importantly, backstopped by Layer 1's non-directional radius, which still catches
 * that hazard as the skater closes to within its buffer.
 *
 * ⚠ **Silence is not an all-clear (D3).** No directional alert means "nothing *reported* on your
 * projected path", never "the ice ahead is fine" — weaker still because heading/speed must be valid for
 * this to run at all. Every surface built on this says so out loud (see `hazardCopy.ts`).
 */

import { destinationPoint, type LatLng } from './geometry';
import { distanceToHazard } from './hazardGeometry';
import { isProvisional } from './hazardLifecycle';
import type { HazardAlert, ProximityHazard } from './hazardProximity';
import { isPassageMarker } from './types';

/** One GPS fix with the motion vector the projection needs. */
export interface DirectionalFix {
  coord: LatLng;
  /** Course over ground, degrees clockwise from north. `< 0` (or absent) ⇒ heading unknown → no alert. */
  headingDeg: number;
  /** Ground speed, m/s. Below `minSpeedMps` (or `< 0`) ⇒ heading isn't trustworthy → no alert. */
  speedMps: number;
}

/** A Layer-1 alert plus *when* the projected path reaches the hazard. */
export interface DirectionalAlert extends HazardAlert {
  /** Seconds until the projected course first enters the footprint; always in `[leadMinSec, leadMaxSec]`. */
  secondsToEncounter: number;
}

/** Alert about a hazard the skater will reach no sooner than this — nearer than this is Layer 1's job. */
export const DEFAULT_LEAD_MIN_SEC = 30;
/** ...and no later than this — beyond a minute out, heading noise makes the projection a guess. */
export const DEFAULT_LEAD_MAX_SEC = 60;
/** Below ~walking pace (≈2.9 km/h) GPS course over ground is junk, so the projection doesn't run. */
export const DEFAULT_MIN_SPEED_MPS = 0.8;
/**
 * Forward-path sampling granularity, metres. Small enough to not step over the footprints a directional
 * warning is actually for (open water ~40 m, thin-ice zones ~50 m, thaw-rotten ~60 m, buffered ridges
 * tens of metres wide); the small point-source holes it might skip are the ones Layer 1's radius still
 * catches. Finer = more `distanceToHazard` calls per fix, which runs in a watcher on a cold phone.
 */
export const DEFAULT_SAMPLE_STEP_M = 10;

/**
 * Backstop against a pathological options set (e.g. a huge `leadMaxSec`) turning the sample loop into a
 * device-freezing march. Far past any real path length ÷ step; a real skate is well under 100 samples.
 */
const MAX_SAMPLES = 2_000;

export interface EvaluateDirectionalOptions {
  leadMinSec?: number;
  leadMaxSec?: number;
  minSpeedMps?: number;
  sampleStepMeters?: number;
  confirmThreshold?: number;
}

/**
 * Which cached hazards the skater's projected course runs into within the lead-time window, excluding
 * any already alerted this session. Returned soonest-encounter-first, so a single-notification UI shows
 * the most imminent. Pure: never mutates `alreadyAlerted`.
 *
 * The suppressed set is owned by the caller (the session layer) — this evaluator is dedup-model-agnostic,
 * which is what lets the once-per-session and every-approach cadences share one function (the session
 * decides when an id enters or leaves the set; see `onIce.ts`).
 */
export function evaluateDirectionalAlert(
  fix: DirectionalFix,
  hazards: readonly ProximityHazard[],
  alreadyAlerted: ReadonlySet<string>,
  options: EvaluateDirectionalOptions = {},
): DirectionalAlert[] {
  const {
    leadMinSec = DEFAULT_LEAD_MIN_SEC,
    leadMaxSec = DEFAULT_LEAD_MAX_SEC,
    minSpeedMps = DEFAULT_MIN_SPEED_MPS,
    sampleStepMeters = DEFAULT_SAMPLE_STEP_M,
    confirmThreshold,
  } = options;

  // No honest forward path without motion and a valid course. Written as `!(x >= y)` so a NaN speed or
  // heading (a fix the OS couldn't fill) fails the guard rather than sneaking through a `<` comparison.
  if (!(fix.speedMps >= minSpeedMps) || !(fix.headingDeg >= 0)) return [];

  const step =
    sampleStepMeters > 0 && Number.isFinite(sampleStepMeters)
      ? sampleStepMeters
      : DEFAULT_SAMPLE_STEP_M;
  const maxDistance = fix.speedMps * leadMaxSec;

  const alerts: DirectionalAlert[] = [];
  for (const hazard of hazards) {
    if (alreadyAlerted.has(hazard.id)) continue;
    // A ridge crossing marks where you *can* get across — a passage marker, not a danger (research §4).
    // "Hazard ahead" aimed at the safest point on a ridge would be actively wrong, so it never fires.
    if (isPassageMarker(hazard.type)) continue;

    const encounterMeters = firstContactMeters(fix, hazard, maxDistance, step);
    if (encounterMeters === null) continue;
    const secondsToEncounter = encounterMeters / fix.speedMps;
    // Too soon is Layer 1's job (you're basically on it); too far out is guesswork given heading noise.
    if (secondsToEncounter < leadMinSec || secondsToEncounter > leadMaxSec) continue;

    alerts.push({
      hazardId: hazard.id,
      type: hazard.type,
      // The confirm gate still applies: an unconfirmed hazard ahead asks "can you see it?", it doesn't
      // assert. Only an independently-confirmed one becomes a plain "⚠ ahead".
      kind: isProvisional(hazard.confirmCount, confirmThreshold) ? 'confirm_request' : 'warning',
      distanceMeters: encounterMeters,
      secondsToEncounter,
    });
  }

  return alerts.sort((a, b) => a.secondsToEncounter - b.secondsToEncounter);
}

/**
 * Distance along the projected course, in metres, at which it first enters `hazard`'s footprint — or
 * `null` if it never does within `maxDistance`. Walks the course in `step`-metre increments and reuses
 * `distanceToHazard` (footprint edge distance, `0` inside), so contact means "a point on your path is
 * inside the same halo the map drew."
 */
function firstContactMeters(
  fix: DirectionalFix,
  hazard: ProximityHazard,
  maxDistance: number,
  step: number,
): number | null {
  const samples = Math.min(Math.ceil(maxDistance / step), MAX_SAMPLES);
  for (let i = 1; i <= samples; i++) {
    const along = i * step;
    const at = destinationPoint(fix.coord, fix.headingDeg, along);
    let d: number;
    try {
      // One malformed cached row must never take out the projection for every *other* hazard on the
      // lake — the same fail-loud defense `evaluateOnIceAlert` makes. A row whose distance can't be
      // computed is skipped, not thrown. The body-clip (when stored) is what the path is tested against,
      // in lockstep with Layer 1 and the render, so "ahead" never drifts from "drawn".
      d = distanceToHazard(at, hazard.shape, hazard.clippedFootprint);
    } catch {
      return null;
    }
    if (d === 0) return along;
  }
  return null;
}
