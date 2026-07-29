/**
 * Snap-to-shoreline (N5b) — turn two taps near a shore into the band of ice along it.
 *
 * `thin_ice` and `open_water` along a shore are **linear along the shore** (N5b Decision 1): rotten
 * shore ice, and a lead running along the ice edge. Drawing one by hand means tracing a shoreline the
 * app already knows exactly, because `waterBodies.polygon` *is* that line. So a skater picks two
 * points near the shore, and the geometry comes off the body's own boundary.
 *
 * What comes out is an **ordinary polygon draft** (Decision 3): the boundary arc buffered by the band
 * half-width, handed back as draft vertices. Nothing downstream knows a band was snapped rather than
 * drawn — one geometry kind, one lifecycle, one renderer. Snapping is an input convenience, not a
 * stored relationship.
 *
 * The band is buffered **symmetrically** and half of it lands on shore. That is deliberate, and it is
 * why this file does no clipping of its own: Phase 9.5's `clipFootprintToBody` already confines a
 * hazard footprint to the water at insert, and a shore band is the exact case it was written for.
 * Cutting the band here as well would mean two places that decide where the ice ends.
 *
 * Two things it **refuses rather than guesses** — the N2 clip-refusal spirit. A tap that lands far
 * from any shoreline isn't a shore band, it's a mis-tap; and two taps that resolve to *different
 * rings* (an island's shore and the mainland's, or two parts of a MultiPolygon) have no arc between
 * them at all, only a shape someone would have to invent.
 */

import buffer from '@turf/buffer';
import { feature } from '@turf/helpers';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import { haversineMeters, type LatLng, simplifyPath } from './geometry';
import { HAZARD_MAX_VERTICES } from './hazardGeometry';

/**
 * How far from the shoreline a tap may land and still be read as "on the shore", in metres.
 *
 * Generous, because a tap on a zoomed-out map is easily a couple of hundred metres out and the
 * affordance would be useless if it demanded precision it exists to avoid needing. But finite: without
 * a bound, a tap in the middle of a big lake snaps silently to whichever shore happens to be nearest,
 * and the skater gets a band nowhere near the thing they were pointing at.
 */
export const SHORE_BAND_MAX_TAP_DISTANCE_M = 500;

/**
 * Starting half-width of a shore band, in metres — how far out from the shoreline the ice is
 * affected.
 *
 * Not the type's `HAZARD_DEFAULT_BUFFER_M`, which is a *linear hazard's* uncertainty half-width
 * (10 m for both shore types) and describes how sure you are about where a line is. A shore band's
 * width is a claim about the ice itself: rotten shore ice runs tens of metres out, not ten. Stepped
 * on the same `HAZARD_BUFFER_STEPS_M` ladder, so the control is the same pair of −/+ buttons.
 */
export const SHORE_BAND_DEFAULT_HALF_WIDTH_M = 25;

/** Why a snap was refused. Each maps to a sentence a skater can act on. */
export type ShoreBandRefusal =
  /** The body has no usable boundary ring — bad geometry, not a bad tap. */
  | 'no_boundary'
  /** At least one tap was further than `SHORE_BAND_MAX_TAP_DISTANCE_M` from any shoreline. */
  | 'tap_off_shore'
  /** The taps landed on different rings — an island and the mainland, or two parts of one body. */
  | 'different_rings'
  /** Both taps resolved to the same shoreline vertex, so there is no arc between them. */
  | 'degenerate_arc'
  /** The buffered band came back as something other than one simple ring. */
  | 'unusable_band';

export interface ShoreBand {
  /** The shoreline arc the band was derived from — the preview line, before buffering. */
  arc: LatLng[];
  /** The band's ring as polygon-draft corners (unclosed, the way a draft holds them). */
  vertices: LatLng[];
  /** Length of the shoreline arc in metres — what the UI shows so "1.2 km of shore" is legible. */
  arcLengthMeters: number;
  /** True when the *longer* way round the ring was taken (Decision 4's "go the other way"). */
  theOtherWay: boolean;
}

export type ShoreBandResult =
  | { ok: true; band: ShoreBand }
  | { ok: false; reason: ShoreBandRefusal };

/** One resolved tap: which ring it landed on, and where. */
interface BoundaryHit {
  ringKey: string;
  /** The ring's distinct vertices, closure position dropped. */
  ring: LatLng[];
  index: number;
  distanceMeters: number;
}

/** Every ring of a body, keyed so two hits can be compared for "same ring" without deep equality. */
function boundaryRings(body: Polygon | MultiPolygon): { key: string; ring: LatLng[] }[] {
  const parts: Position[][][] = body.type === 'Polygon' ? [body.coordinates] : body.coordinates;
  const rings: { key: string; ring: LatLng[] }[] = [];
  parts.forEach((part, p) => {
    part.forEach((positions, r) => {
      // A GeoJSON ring repeats its first position last; the distinct vertices are what an arc walks.
      const closed =
        positions.length > 1 &&
        positions[0]?.[0] === positions[positions.length - 1]?.[0] &&
        positions[0]?.[1] === positions[positions.length - 1]?.[1];
      const distinct = closed ? positions.slice(0, -1) : positions;
      if (distinct.length < 3) return;
      rings.push({
        key: `${p}:${r}`,
        ring: distinct.map(([lng = 0, lat = 0]) => ({ lat, lng })),
      });
    });
  });
  return rings;
}

/**
 * The nearest shoreline **vertex** to a tap, across every ring of the body.
 *
 * Vertex rather than nearest-point-on-segment: an arc is defined by indices into the ring, so a point
 * partway along a segment would have to be spliced in as a new vertex on both ends — extra machinery
 * for sub-vertex precision that the band's own half-width has already declared it doesn't have.
 */
function nearestBoundaryVertex(
  rings: readonly { key: string; ring: LatLng[] }[],
  tap: LatLng,
): BoundaryHit | null {
  let best: BoundaryHit | null = null;
  for (const { key, ring } of rings) {
    for (let i = 0; i < ring.length; i++) {
      const distanceMeters = haversineMeters(tap, ring[i] as LatLng);
      if (best === null || distanceMeters < best.distanceMeters) {
        best = { ringKey: key, ring, index: i, distanceMeters };
      }
    }
  }
  return best;
}

/** Walk a closed ring from `from` to `to`, stepping `+1` or `-1` and wrapping. Includes both ends. */
function walkRing(ring: readonly LatLng[], from: number, to: number, step: 1 | -1): LatLng[] {
  const n = ring.length;
  const out: LatLng[] = [];
  let i = from;
  for (let guard = 0; guard <= n; guard++) {
    out.push(ring[i] as LatLng);
    if (i === to) return out;
    i = (i + step + n) % n;
  }
  return out;
}

/** Total great-circle length of a path in metres. */
function pathLengthMeters(path: readonly LatLng[]): number {
  let total = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    total += haversineMeters(path[i] as LatLng, path[i + 1] as LatLng);
  }
  return total;
}

/**
 * Buffer an arc into the band's ring, simplifying until it fits under `HAZARD_MAX_VERTICES`.
 *
 * The tolerance starts at half the band's half-width — keeping shoreline detail finer than the
 * uncertainty the band already declares is storing precision the hazard doesn't have — and doubles
 * until the buffered ring fits. It always converges: each doubling strictly loses vertices until only
 * the two endpoints remain.
 */
function bandRing(arc: readonly LatLng[], halfWidthMeters: number): LatLng[] | null {
  let tolerance = Math.max(halfWidthMeters / 2, 1);
  for (let attempt = 0; attempt < 16; attempt++) {
    const simplified = attempt === 0 ? [...arc] : simplifyPath(arc, tolerance);
    if (simplified.length < 2) return null;
    let band: Feature<Polygon | MultiPolygon>;
    try {
      band = buffer(
        feature({
          type: 'LineString',
          coordinates: simplified.map((p) => [p.lng, p.lat]),
        }),
        halfWidthMeters,
        { units: 'meters' },
      ) as Feature<Polygon | MultiPolygon>;
    } catch {
      return null;
    }
    // One simple ring or nothing. A band that buffered into two lobes or grew a hole is a shape the
    // skater did not ask for, and Decision 3's "one geometry kind downstream" is only true if the
    // odd cases are refused rather than stored.
    if (!band?.geometry || band.geometry.type !== 'Polygon') return null;
    const ring = band.geometry.coordinates;
    if (ring.length !== 1) return null;
    const positions = ring[0] as Position[];
    if (positions.length <= HAZARD_MAX_VERTICES) {
      // Drop the closing position: a draft holds corners, and `polygonShape` closes them again.
      return positions.slice(0, -1).map(([lng = 0, lat = 0]) => ({ lat, lng }));
    }
    tolerance *= 2;
  }
  return null;
}

/**
 * Two taps near a shore → the band of ice along it, or why not.
 *
 * `theOtherWay` picks the longer arc round the ring (Decision 4). The shorter one is right almost
 * always and silently wrong on a small pond or a narrow bay, where the band a skater means is most of
 * the perimeter — so it's a control they flip, not something inferred from where they happen to be
 * looking.
 */
export function deriveShoreBand(
  body: Polygon | MultiPolygon,
  tapA: LatLng,
  tapB: LatLng,
  options: { halfWidthMeters: number; theOtherWay?: boolean },
): ShoreBandResult {
  const rings = boundaryRings(body);
  if (rings.length === 0) return { ok: false, reason: 'no_boundary' };

  const hitA = nearestBoundaryVertex(rings, tapA);
  const hitB = nearestBoundaryVertex(rings, tapB);
  if (!hitA || !hitB) return { ok: false, reason: 'no_boundary' };
  if (
    hitA.distanceMeters > SHORE_BAND_MAX_TAP_DISTANCE_M ||
    hitB.distanceMeters > SHORE_BAND_MAX_TAP_DISTANCE_M
  ) {
    return { ok: false, reason: 'tap_off_shore' };
  }
  // Refuse rather than guess. There is no arc along "the boundary" between an island and the
  // mainland, or between two parts of a MultiPolygon — only a shape we would have to invent, and a
  // hazard footprint is the last place to invent one.
  if (hitA.ringKey !== hitB.ringKey) return { ok: false, reason: 'different_rings' };
  if (hitA.index === hitB.index) return { ok: false, reason: 'degenerate_arc' };

  const forward = walkRing(hitA.ring, hitA.index, hitB.index, 1);
  const backward = walkRing(hitA.ring, hitA.index, hitB.index, -1);
  const forwardIsShorter = pathLengthMeters(forward) <= pathLengthMeters(backward);
  const takeForward = options.theOtherWay ? !forwardIsShorter : forwardIsShorter;
  const arc = takeForward ? forward : backward;

  const vertices = bandRing(arc, options.halfWidthMeters);
  if (!vertices) return { ok: false, reason: 'unusable_band' };

  return {
    ok: true,
    band: {
      arc,
      vertices,
      arcLengthMeters: pathLengthMeters(arc),
      theOtherWay: options.theOtherWay === true,
    },
  };
}

/**
 * The hazard types that offer snap-to-shoreline (Decision 1).
 *
 * The two existing types that are genuinely *shore-shaped*: rotten shore ice, and a lead running
 * along the ice edge. Research §4 described these as "thin ice along the shore" and "ice edge"; this
 * plan originally read that prose as two type names, and there are no such types. Others — a working
 * crack, overflow, shell ice — frequently *occur* near shore without being shore-shaped, so offering
 * them the affordance would be offering the wrong geometry.
 */
export const SHORE_BAND_TYPES = ['thin_ice', 'open_water'] as const;

/** Does this hazard type offer the snap-to-shoreline affordance? */
export function offersShoreBand(type: string): boolean {
  return (SHORE_BAND_TYPES as readonly string[]).includes(type);
}

/**
 * What to tell a skater when a snap is refused.
 *
 * Here rather than in each client because both have to say the same thing, and because every line
 * has to name **the next move**. A refusal that only reports a failure at someone standing on ice
 * with a hazard to file is worse than no affordance: the other two primitives always work, and each
 * message says so where it's the right answer.
 */
export function shoreBandRefusalText(reason: ShoreBandRefusal): string {
  switch (reason) {
    case 'no_boundary':
      return 'This lake’s outline isn’t detailed enough to snap to. Trace the hazard as a line instead.';
    case 'tap_off_shore':
      return 'That wasn’t close enough to the shore. Click nearer the edge of the lake — anywhere within a few hundred metres of it.';
    case 'different_rings':
      return 'Those two points are on different shorelines — an island and the main shore, or two separate parts of this lake. Pick two ends of the same stretch.';
    case 'degenerate_arc':
      return 'Both points landed on the same bit of shore. Pick two ends further apart.';
    case 'unusable_band':
      return 'Couldn’t make a clean band along that stretch of shore. Try a shorter section, or trace it as a line.';
  }
}
