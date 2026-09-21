/**
 * Sub-areas by chord (D201) — two shoreline points, a side, and a sagitta; the polygon is derived.
 *
 * A bay's outline is not a drawing. Its shore is the parent's own shoreline, exactly, and the only
 * judgment in it is where the mouth is: two points on the shore and, when open water skaters treat
 * as the bay's should be in or out, a bow on the line between them. The A10 corpus seed tried to
 * find the mouth automatically and managed it on 1 of 39 bays; a person does it in ten seconds.
 * So the moderator supplies exactly that judgment, and everything else here is construction:
 *
 *  1. **Snap** both points to the parent's outline (`snapToOutline`) — the outer ring, or an
 *     island's ring, since an island bay's shore *is* the island (Keeler, Carry, City and Holcomb
 *     on Champlain are bays of Grand Isle and North Hero, which are inner rings of the lake).
 *  2. **Walk** the ring from `a` to `b` — there are two ways round, and each, closed by the chord,
 *     is a candidate region (`chordCandidates`). On the outer ring the two partition the lake; the
 *     moderator picks one by clicking it, and the click is stored as `side`.
 *  3. **Close** with the chord, or with a circular arc of the stored sagitta (`chordArc`) —
 *     outward to take in open water, inward to exclude it.
 *  4. **Clip** to the parent (`clipSubAreaToParent`), which is what drops islands out of the bay,
 *     and land out of an outward arc. (An island bay needs no special case: the short way round
 *     the island's ring between the two points *is* the notch's shore, and with the chord it
 *     encloses only water. The long way round encloses the island too, and the clip removes it.)
 *
 * The polygon is what every reader uses (nothing downstream changes); the mouth is what the editor
 * re-opens with and what A09's "skated past the mouth" evidence is about. **The server derives the
 * polygon from the mouth against the stored parent** — a client previews, it never supplies the
 * shape (the same "never stored as supplied" posture as a free-drawn sub-area, D60 / Decision 10).
 *
 * A chord between the mainland and an island is refused: the two "sides" of such a line are not
 * defined, and the region it would bound is not a bay. Both points must snap to the same ring.
 */

import type { MultiPolygon, Polygon, Position } from 'geojson';
import { type LatLng, pointInPolygon, surfaceAreaSqM } from './geometry';
import { clipSubAreaToParent, type SubAreaClipRejection } from './subArea';

// ── Vocabulary ─────────────────────────────────────────────────────────────────────────────────

/**
 * The stored fact behind a chord-drawn sub-area. `a` and `b` are on the parent's outline (snapped
 * before storage, re-snapped on every derivation — a re-import that moves the shoreline a few
 * meters must not orphan the mouth); `side` is a point inside the chosen region, which is what
 * makes the mouth reconstructible — two shoreline points bound *two* regions, and a walk direction
 * would not survive a re-import re-orienting the ring, where a point does. `sagittaM` is signed:
 * positive bows the closing line **away** from `side` (out into open water), negative bows it in.
 */
export interface SubAreaMouth {
  a: LatLng;
  b: LatLng;
  side: LatLng;
  sagittaM: number;
}

/** Where a point snapped to on the parent's outline. */
export interface OutlinePoint {
  point: LatLng;
  /** Index into a MultiPolygon's polygons (always 0 for a Polygon). */
  polygon: number;
  /** Ring index within that polygon: 0 is the outer ring, ≥ 1 an island. */
  ring: number;
  /** The point lies on the segment `ring[segment] → ring[segment + 1]`, at fraction `t`. */
  segment: number;
  t: number;
  /** How far the input was from the outline, in meters. */
  distanceM: number;
}

/** Why a mouth could not become a polygon. Each maps to a distinct thing the moderator did. */
export type ChordRejection =
  /** The parent has no usable ring — a degenerate outline. */
  | 'no_outline'
  /** One point is on the mainland and the other on an island (or two different islands). */
  | 'different_rings'
  /** The two points snapped to the same spot. */
  | 'coincident'
  /** `side` lies on neither candidate region — on the chord line, or off the ring entirely. */
  | 'side_ambiguous'
  /** The closing line (chord or arc) cuts across the bay's own shoreline. */
  | 'crosses_shore'
  | SubAreaClipRejection;

export type ChordResult =
  | {
      ok: true;
      /** What to store — the walked shore, the closing line, clipped to the parent. */
      polygon: Polygon | MultiPolygon;
      /** The un-clipped construction, for the editor's preview of what the clip removed. */
      constructed: Polygon;
      clipped: boolean;
    }
  | { ok: false; reason: ChordRejection };

/** The moderator-facing half of a refusal, so the editor and the server agree (one string set). */
export const CHORD_MESSAGES: Record<ChordRejection, string> = {
  no_outline: 'This water body has no usable outline to snap to.',
  different_rings:
    'Both points have to be on the same shore — the mainland, or one island. A line from the ' +
    'mainland to an island does not enclose a bay.',
  coincident: 'The two points are on the same spot. Click two different places on the shore.',
  side_ambiguous: 'Click inside one of the two shaded regions to say which side is the bay.',
  crosses_shore:
    'The mouth line crosses the bay’s own shoreline. Move a point, or bow the line the other way.',
  degenerate: 'That mouth encloses no water.',
  disjoint: 'That mouth encloses no water inside this water body.',
  mostly_outside: 'That mouth encloses no water inside this water body.',
  clip_failed:
    'We couldn’t fit that mouth to the outline. Try moving a point a little, or draw the bay freehand.',
};

/**
 * The most a line can bow: a semicircle. Past it the arc would curl back toward the chord and the
 * region would stop being "the water off this mouth" — and the drag handle would have to go past
 * the far side of the circle to ask for it, which nobody means.
 */
export const MAX_SAGITTA_RATIO = 0.5;

/** How finely an arc is sampled: one vertex per this many meters, and never fewer than 16. */
const ARC_SEGMENT_M = 10;
const ARC_MIN_SEGMENTS = 16;

/** Below this, a sagitta is a straight chord — sub-meter bows are drag noise, not a judgment. */
const STRAIGHT_SAGITTA_M = 0.5;

// ── Local projection ───────────────────────────────────────────────────────────────────────────

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/** Equirectangular meters around `origin` — the same flat-earth-around-the-point math as `geometry.ts`. */
function toLocal(p: LatLng, origin: LatLng): [number, number] {
  return [
    (p.lng - origin.lng) * DEG * EARTH_RADIUS_M * Math.cos(origin.lat * DEG),
    (p.lat - origin.lat) * DEG * EARTH_RADIUS_M,
  ];
}

function fromLocal([x, y]: readonly [number, number], origin: LatLng): LatLng {
  return {
    lat: origin.lat + y / (DEG * EARTH_RADIUS_M),
    lng: origin.lng + x / (DEG * EARTH_RADIUS_M * Math.cos(origin.lat * DEG)),
  };
}

function toPosition(p: LatLng): Position {
  return [p.lng, p.lat];
}

function polygonsOf(geom: Polygon | MultiPolygon): Position[][][] {
  return geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
}

// ── Snap ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The nearest point on any ring of the parent — outer or island — and which ring and segment it is
 * on. Unbounded on purpose: the editor's camera is locked to the parent (A02 Decision 5), so every
 * click is *somewhere* on this lake and the nearest shore is always the shore meant. Rings with
 * fewer than three distinct vertices are skipped. `null` only when the parent has no usable ring.
 */
export function snapToOutline(parent: Polygon | MultiPolygon, p: LatLng): OutlinePoint | null {
  let best: OutlinePoint | null = null;
  polygonsOf(parent).forEach((rings, polygonIndex) => {
    rings.forEach((ring, ringIndex) => {
      if (ring.length < 4) return;
      const local = ring.map((position) =>
        toLocal({ lat: position[1] as number, lng: position[0] as number }, p),
      );
      for (let i = 0; i + 1 < local.length; i++) {
        const [ax, ay] = local[i] as [number, number];
        const [bx, by] = local[i + 1] as [number, number];
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (-ax * dx - ay * dy) / len2));
        const x = ax + t * dx;
        const y = ay + t * dy;
        const distanceM = Math.hypot(x, y);
        if (best === null || distanceM < best.distanceM) {
          best = {
            point: fromLocal([x, y], p),
            polygon: polygonIndex,
            ring: ringIndex,
            segment: i,
            t,
            distanceM,
          };
        }
      }
    });
  });
  return best;
}

// ── The ring walk ──────────────────────────────────────────────────────────────────────────────

/**
 * The ring's vertices strictly between `from` and `to`, walking in one direction. The ring is
 * closed (`ring[n] === ring[0]`), so there are `n` distinct vertices and `n` segments; `from` sits on
 * segment `i` and `to` on segment `j`.
 *
 * Forward from a point on segment `i` visits `ring[i+1], ring[i+2], …` until it reaches segment `j`,
 * whose end it does not include (the walk ends at `to`, which is on it). Reverse visits
 * `ring[i], ring[i-1], …` down to `ring[j+1]`. When both points share a segment, one direction is
 * the empty walk and the other is the whole ring — which one depends on their order along it.
 */
function walkBetween(
  ring: readonly Position[],
  from: { segment: number; t: number },
  to: { segment: number; t: number },
  direction: 'forward' | 'reverse',
): Position[] {
  const n = ring.length - 1;
  const wrap = (k: number) => ((k % n) + n) % n;
  const out: Position[] = [];
  if (from.segment === to.segment) {
    const empty = direction === 'forward' ? from.t <= to.t : from.t >= to.t;
    if (empty) return out;
    for (let step = 0; step < n; step++) {
      const k = direction === 'forward' ? from.segment + 1 + step : from.segment - step;
      out.push(ring[wrap(k)] as Position);
    }
    return out;
  }
  if (direction === 'forward') {
    for (let k = from.segment + 1; wrap(k) !== wrap(to.segment + 1); k++) {
      out.push(ring[wrap(k)] as Position);
    }
  } else {
    for (let k = from.segment; wrap(k) !== wrap(to.segment); k--) {
      out.push(ring[wrap(k)] as Position);
    }
  }
  return out;
}

/** A closed ring from an open path — `first` repeated at the end, as GeoJSON wants it. */
function closeRing(path: readonly Position[]): Position[] {
  const first = path[0] as Position;
  return [...path, first];
}

/**
 * Drop consecutive repeats. A point snapped exactly onto a ring vertex is that vertex, and the walk
 * would otherwise visit it twice — a zero-length segment that the crossing test reads as the
 * closing line touching the shore.
 */
function dedupe(path: readonly Position[]): Position[] {
  const out: Position[] = [];
  for (const p of path) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push(p);
  }
  return out;
}

function candidateRings(
  parent: Polygon | MultiPolygon,
  a: OutlinePoint,
  b: OutlinePoint,
): [Position[], Position[]] {
  const ring = (polygonsOf(parent)[a.polygon] as Position[][])[a.ring] as Position[];
  const forward = dedupe([
    toPosition(a.point),
    ...walkBetween(ring, a, b, 'forward'),
    toPosition(b.point),
  ]);
  const reverse = dedupe([
    toPosition(a.point),
    ...walkBetween(ring, a, b, 'reverse'),
    toPosition(b.point),
  ]);
  return [forward, reverse];
}

/**
 * The two regions a chord bounds — the ring walked each way from `a` to `b`, closed by the straight
 * chord — **un-clipped**, so on an island ring each candidate includes the island's land. The
 * editor shades both (clipped, so the moderator sees water) and the click on one becomes `side`.
 * `smaller` is the default the plan names: right for every bay, wrong only for "everything but this
 * bay", which nobody draws.
 */
export function chordCandidates(
  parent: Polygon | MultiPolygon,
  a: LatLng,
  b: LatLng,
):
  | {
      ok: true;
      sides: [Polygon, Polygon];
      /** Each side clipped to the parent — what the editor shades. `null` where the clip failed. */
      water: [Polygon | MultiPolygon | null, Polygon | MultiPolygon | null];
      smaller: 0 | 1;
    }
  | { ok: false; reason: ChordRejection } {
  const snapped = snapPair(parent, a, b);
  if (!snapped.ok) return snapped;
  const [forward, reverse] = candidateRings(parent, snapped.a, snapped.b);
  const sides: [Polygon, Polygon] = [
    { type: 'Polygon', coordinates: [closeRing(forward)] },
    { type: 'Polygon', coordinates: [closeRing(reverse)] },
  ];
  const water = sides.map((side) => {
    const clip = clipSubAreaToParent(side, parent, 0);
    return clip.ok ? clip.polygon : null;
  }) as [Polygon | MultiPolygon | null, Polygon | MultiPolygon | null];
  const areas = sides.map((s) => surfaceAreaSqM(s));
  return {
    ok: true,
    sides,
    water,
    smaller: (areas[0] as number) <= (areas[1] as number) ? 0 : 1,
  };
}

function snapPair(
  parent: Polygon | MultiPolygon,
  a: LatLng,
  b: LatLng,
): { ok: true; a: OutlinePoint; b: OutlinePoint } | { ok: false; reason: ChordRejection } {
  const sa = snapToOutline(parent, a);
  const sb = snapToOutline(parent, b);
  if (!sa || !sb) return { ok: false, reason: 'no_outline' };
  if (sa.polygon !== sb.polygon || sa.ring !== sb.ring) {
    return { ok: false, reason: 'different_rings' };
  }
  const [ax, ay] = toLocal(sb.point, sa.point);
  if (Math.hypot(ax, ay) < STRAIGHT_SAGITTA_M) return { ok: false, reason: 'coincident' };
  return { ok: true, a: sa, b: sb };
}

// ── The arc ────────────────────────────────────────────────────────────────────────────────────

/**
 * The unit normal to chord `a → b` that points **away** from `side`, in local meters around the
 * chord's midpoint — the direction a positive sagitta bows. `null` when `side` is on the chord's
 * line, where "away" has no meaning.
 */
function outwardNormal(
  a: LatLng,
  b: LatLng,
  side: LatLng,
): { origin: LatLng; A: [number, number]; B: [number, number]; n: [number, number] } | null {
  const origin = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
  const A = toLocal(a, origin);
  const B = toLocal(b, origin);
  const S = toLocal(side, origin);
  const dx = B[0] - A[0];
  const dy = B[1] - A[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  // A left-hand normal; flipped if the side point is on that side, so it ends up pointing away.
  let n: [number, number] = [-dy / len, dx / len];
  const toSide = S[0] * n[0] + S[1] * n[1];
  if (Math.abs(toSide) < 1e-6) return null;
  if (toSide > 0) n = [-n[0], -n[1]];
  return { origin, A, B, n };
}

/** The longest sagitta a chord admits, either way: half its length (a semicircle). */
export function maxSagittaM(a: LatLng, b: LatLng): number {
  const origin = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
  const A = toLocal(a, origin);
  const B = toLocal(b, origin);
  return Math.hypot(B[0] - A[0], B[1] - A[1]) * MAX_SAGITTA_RATIO;
}

/** A sagitta clamped to what the chord admits — the write path and the drag handle both use it. */
export function clampSagitta(a: LatLng, b: LatLng, sagittaM: number): number {
  const max = maxSagittaM(a, b);
  const clamped = Math.max(-max, Math.min(max, sagittaM));
  return Math.abs(clamped) < STRAIGHT_SAGITTA_M ? 0 : clamped;
}

/**
 * The points of a circular arc from `a` to `b` with the given sagitta, `a` and `b` included, bowing
 * away from `side` when positive. A zero sagitta is the straight chord: just `[a, b]`.
 */
export function chordArc(a: LatLng, b: LatLng, side: LatLng, sagittaM: number): LatLng[] {
  const s = clampSagitta(a, b, sagittaM);
  const frame = outwardNormal(a, b, side);
  if (s === 0 || frame === null) return [a, b];
  const { origin, A, B, n } = frame;
  const c = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const h = Math.abs(s);
  // Circle through A and B with the apex `h` off the chord's midpoint: R from the intersecting
  // chords theorem, center on the far side of the chord from the bulge.
  const R = (c * c) / (8 * h) + h / 2;
  const bulge: [number, number] = s > 0 ? n : [-n[0], -n[1]];
  const center: [number, number] = [-bulge[0] * (R - h), -bulge[1] * (R - h)];
  const startAngle = Math.atan2(A[1] - center[1], A[0] - center[0]);
  const endAngle = Math.atan2(B[1] - center[1], B[0] - center[0]);
  // The arc is at most a semicircle, so it is the way round whose midpoint lies on the bulge side
  // of the chord. Take the short way first and flip it if its midpoint is on the wrong side.
  let sweep = endAngle - startAngle;
  while (sweep <= -Math.PI) sweep += 2 * Math.PI;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  const midAngle = startAngle + sweep / 2;
  const midDot =
    (center[0] + R * Math.cos(midAngle)) * bulge[0] +
    (center[1] + R * Math.sin(midAngle)) * bulge[1];
  if (midDot < 0) sweep = sweep > 0 ? sweep - 2 * Math.PI : sweep + 2 * Math.PI;
  const arcLength = Math.abs(sweep) * R;
  const segments = Math.max(ARC_MIN_SEGMENTS, Math.ceil(arcLength / ARC_SEGMENT_M));
  const points: LatLng[] = [a];
  for (let k = 1; k < segments; k++) {
    const angle = startAngle + (sweep * k) / segments;
    points.push(
      fromLocal([center[0] + R * Math.cos(angle), center[1] + R * Math.sin(angle)], origin),
    );
  }
  points.push(b);
  return points;
}

/** Where the arc's apex sits — the editor's drag handle. The chord's midpoint when straight. */
export function arcApex(a: LatLng, b: LatLng, side: LatLng, sagittaM: number): LatLng {
  const s = clampSagitta(a, b, sagittaM);
  const frame = outwardNormal(a, b, side);
  const origin = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
  if (frame === null || s === 0) return origin;
  return fromLocal([frame.n[0] * s, frame.n[1] * s], origin);
}

/**
 * The sagitta a dragged handle asks for: the handle's signed distance from the chord along the
 * outward normal, clamped. Dragging along the chord changes nothing, which is what keeps the handle
 * on the arc's apex rather than wandering.
 */
export function sagittaFromHandle(a: LatLng, b: LatLng, side: LatLng, handle: LatLng): number {
  const frame = outwardNormal(a, b, side);
  if (frame === null) return 0;
  const H = toLocal(handle, frame.origin);
  return clampSagitta(a, b, H[0] * frame.n[0] + H[1] * frame.n[1]);
}

// ── The construction ───────────────────────────────────────────────────────────────────────────

/** Twice the signed area of `o→a→b`; the sign says which side of `o→a` the point `b` is on. */
function orient(
  [ox, oy]: readonly [number, number],
  [ax, ay]: readonly [number, number],
  [bx, by]: readonly [number, number],
): number {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

/**
 * Do two segments cross **properly** — each passing from one side of the other to the other side?
 * Touching does not count: a closing line that starts on a shore vertex, or runs along the shore
 * for the few meters between a click and the corner it was aimed at, only touches. That leaves a
 * zero-width spike the clipper drops, not a ring that crosses itself.
 */
function properlyCross(
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
  p4: readonly [number, number],
): boolean {
  // "On the line" has to survive floating point: a closing line through a shore vertex (a chord
  // clipping the tip of a headland exactly) is a touch, and the orientation there is noise-sized,
  // not zero. Anything within this fraction of the two lengths' product is on the line.
  const eps =
    1e-12 * Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) * Math.hypot(p4[0] - p3[0], p4[1] - p3[1]);
  const sideOf = (d: number) => (Math.abs(d) <= eps ? 0 : Math.sign(d));
  const d1 = sideOf(orient(p3, p4, p1));
  const d2 = sideOf(orient(p3, p4, p2));
  const d3 = sideOf(orient(p1, p2, p3));
  const d4 = sideOf(orient(p1, p2, p4));
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Does the closing line cut across the walked shore? */
function closingCrossesShore(shore: readonly Position[], closing: readonly Position[]): boolean {
  for (let i = 0; i + 1 < shore.length; i++) {
    for (let j = 0; j + 1 < closing.length; j++) {
      if (
        properlyCross(
          shore[i] as [number, number],
          shore[i + 1] as [number, number],
          closing[j] as [number, number],
          closing[j + 1] as [number, number],
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The polygon a mouth describes, against this parent. Re-snaps `a` and `b`, picks the candidate
 * that contains `side`, closes it with the chord or the arc, and clips to the parent. Pure and
 * deterministic: the server runs it on the stored parent, the editor runs it on the same polygon
 * for the preview, and both get the same shape.
 */
export function chordSubArea(parent: Polygon | MultiPolygon, mouth: SubAreaMouth): ChordResult {
  const snapped = snapPair(parent, mouth.a, mouth.b);
  if (!snapped.ok) return snapped;
  const a = snapped.a.point;
  const b = snapped.b.point;
  const [forward, reverse] = candidateRings(parent, snapped.a, snapped.b);
  // The smallest candidate that contains `side`. On the outer ring the two partition the lake and
  // exactly one contains it; on an island ring they are *nested* — the long way round plus the
  // chord is the island's land together with the notch water, the short way is the notch alone —
  // and the smaller is the bay. (Both clip to the same water; the rule just makes it exact.)
  const chosen = [forward, reverse]
    .filter((path) => path.length >= 3)
    .map((path) => ({
      path,
      polygon: { type: 'Polygon', coordinates: [closeRing(path)] } as Polygon,
    }))
    .filter(({ polygon }) => pointInPolygon(mouth.side, polygon))
    .sort((x, y) => surfaceAreaSqM(x.polygon) - surfaceAreaSqM(y.polygon))[0]?.path;
  if (!chosen) return { ok: false, reason: 'side_ambiguous' };

  const closing = chordArc(b, a, mouth.side, mouth.sagittaM).map(toPosition);
  // A keyhole bay's straight mouth line, or an arc dragged in past the shore, cuts the walked
  // shore and the ring would cross itself — a shape the clipper may accept and nobody meant.
  if (closingCrossesShore(chosen, closing)) return { ok: false, reason: 'crosses_shore' };

  const constructed: Polygon = {
    type: 'Polygon',
    // `closing` starts at `b` (the walk's end) and ends at `a` (its start), which closes the ring.
    coordinates: [[...chosen, ...closing.slice(1)]],
  };
  // No retained-fraction bar: the shape is on the parent's own outline by construction, and on an
  // island ring most of it is the island — which the clip is *for*. Only "nothing left" refuses.
  const clip = clipSubAreaToParent(constructed, parent, 0);
  if (!clip.ok) return { ok: false, reason: clip.reason };
  return { ok: true, polygon: clip.polygon, constructed, clipped: clip.clipped };
}
