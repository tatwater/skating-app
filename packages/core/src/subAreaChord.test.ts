import fc from 'fast-check';
import type { MultiPolygon, Polygon, Position } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  haversineMeters,
  type LatLng,
  polygonIoU,
  representativePoint,
  surfaceAreaSqM,
} from './geometry';
import { fetchOrigin } from './lakeGeometry';
import { clipSubAreaToParent } from './subArea';
import {
  arcApex,
  CHORD_MESSAGES,
  chordArc,
  chordCandidates,
  chordSubArea,
  clampSagitta,
  MAX_SAGITTA_RATIO,
  maxSagittaM,
  type SubAreaMouth,
  sagittaFromHandle,
  snapToOutline,
} from './subAreaChord';

// ── A synthetic lake, in meters ────────────────────────────────────────────────────────────────
//
// A 4 km × 3 km lake at Champlain's latitude with a **keyhole bay** on its north shore (a 400 m
// mouth opening into a 1,200 m × 600 m basin) and a square **island** with a notch cut into its
// east side — the two shapes the construction has to get right: a mouth that is narrower than the
// bay behind it, and a bay whose shore is an island's ring rather than the lake's.

const ORIGIN: LatLng = { lat: 44.5, lng: -73.0 };
const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/** Local meters → `{ lat, lng }`, the inverse of the module's equirectangular projection. */
function at(x: number, y: number): LatLng {
  return {
    lat: ORIGIN.lat + y / (DEG * EARTH_RADIUS_M),
    lng: ORIGIN.lng + x / (DEG * EARTH_RADIUS_M * Math.cos(ORIGIN.lat * DEG)),
  };
}
function pos(x: number, y: number): Position {
  const p = at(x, y);
  return [p.lng, p.lat];
}

const OUTER: Position[] = [
  pos(0, 0),
  pos(4000, 0),
  pos(4000, 3000),
  pos(2200, 3000), // the mouth's east point
  pos(2200, 3200),
  pos(2600, 3200),
  pos(2600, 3800),
  pos(1400, 3800),
  pos(1400, 3200),
  pos(1800, 3200),
  pos(1800, 3000), // the mouth's west point
  pos(0, 3000),
  pos(0, 0),
];
const ISLAND: Position[] = [
  pos(600, 600),
  pos(1200, 600),
  pos(1200, 800), // the notch's south point
  pos(1000, 800),
  pos(1000, 1000),
  pos(1200, 1000), // the notch's north point
  pos(1200, 1200),
  pos(600, 1200),
  pos(600, 600),
];
const LAKE: Polygon = { type: 'Polygon', coordinates: [OUTER, ISLAND] };

const LAKE_AREA = 4000 * 3000 + 400 * 200 + 1200 * 600 - (600 * 600 - 200 * 200);
const BAY_AREA = 400 * 200 + 1200 * 600;
const NOTCH_AREA = 200 * 200;

/** The mouth across the keyhole bay, looking in. */
const BAY_MOUTH: SubAreaMouth = {
  a: at(1800, 3000),
  b: at(2200, 3000),
  side: at(2000, 3500),
  sagittaM: 0,
};
/** The same chord, the other side chosen: everything but the bay. */
const REST_OF_LAKE: SubAreaMouth = { ...BAY_MOUTH, side: at(2000, 1500) };
/** The island's notch: both points on the island ring, the side point in the notch water. */
const NOTCH_MOUTH: SubAreaMouth = {
  a: at(1200, 800),
  b: at(1200, 1000),
  side: at(1100, 900),
  sagittaM: 0,
};

function areaOf(mouth: SubAreaMouth, parent: Polygon | MultiPolygon = LAKE): number {
  const result = chordSubArea(parent, mouth);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return surfaceAreaSqM(result.polygon);
}

/** Geodesic area against a flat-meter expectation: ~0.5% is projection, 2% is the bar. */
function expectArea(actual: number, expectedM2: number) {
  expect(Math.abs(actual - expectedM2) / expectedM2).toBeLessThan(0.02);
}

describe('snapToOutline', () => {
  it('snaps a click in the bay to the nearest shore, on the outer ring, and says which segment', () => {
    const hit = snapToOutline(LAKE, at(1450, 3500));
    expect(hit).not.toBeNull();
    if (!hit) return;
    expect(hit.polygon).toBe(0);
    expect(hit.ring).toBe(0);
    // The west wall of the basin, `pos(1400, 3800) → pos(1400, 3200)`, is segment 7.
    expect(hit.segment).toBe(7);
    expect(hit.distanceM).toBeCloseTo(50, 0);
    expect(haversineMeters(hit.point, at(1400, 3500))).toBeLessThan(1);
  });

  it("snaps a click in the island's notch to the island ring, not the far mainland", () => {
    const hit = snapToOutline(LAKE, at(1050, 900));
    expect(hit?.ring).toBe(1);
    // The notch's back wall, `pos(1000, 800) → pos(1000, 1000)`, is island segment 3.
    expect(hit?.segment).toBe(3);
    expect(hit?.distanceM).toBeCloseTo(50, 0);
  });

  it('snaps to a vertex when the click is past a segment end, with t clamped', () => {
    const hit = snapToOutline(LAKE, at(-100, -100));
    expect(hit?.t).toBe(0);
    expect(haversineMeters(hit?.point as LatLng, at(0, 0))).toBeLessThan(1);
  });

  it('reports the polygon index on a MultiPolygon parent', () => {
    const pond: Position[] = [
      pos(6000, 0),
      pos(7000, 0),
      pos(7000, 1000),
      pos(6000, 1000),
      pos(6000, 0),
    ];
    const two: MultiPolygon = { type: 'MultiPolygon', coordinates: [[OUTER, ISLAND], [pond]] };
    expect(snapToOutline(two, at(6500, 900))?.polygon).toBe(1);
    expect(snapToOutline(two, at(2000, 1500))?.polygon).toBe(0);
  });

  it('returns null when no ring has three distinct vertices', () => {
    const degenerate: Polygon = {
      type: 'Polygon',
      coordinates: [[pos(0, 0), pos(1, 1), pos(0, 0)]],
    };
    expect(snapToOutline(degenerate, at(0, 0))).toBeNull();
  });
});

describe('chordSubArea — the straight chord', () => {
  it('a mouth across the keyhole bay yields the bay: the channel and the basin behind it', () => {
    const result = chordSubArea(LAKE, BAY_MOUTH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectArea(surfaceAreaSqM(result.polygon), BAY_AREA);
    // The construction is the parent's own vertices, exactly — a walked outline, not a trace of
    // one. (The clipper still re-nodes it, so `clipped` may read true; the shape is unchanged.)
    expectArea(surfaceAreaSqM(result.constructed), BAY_AREA);
    const ring = result.constructed.coordinates[0] as Position[];
    for (const v of [pos(2600, 3800), pos(1400, 3800), pos(1400, 3200), pos(1800, 3200)]) {
      expect(ring).toContainEqual(v);
    }
  });

  it('the other side of the same chord is everything but the bay, with the island dropped out', () => {
    const result = chordSubArea(LAKE, REST_OF_LAKE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectArea(surfaceAreaSqM(result.polygon), LAKE_AREA - BAY_AREA);
    // The island is a hole in the parent, so the clip removed it from the candidate.
    expect(result.clipped).toBe(true);
    expect(result.polygon.type).toBe('Polygon');
    expect((result.polygon as Polygon).coordinates.length).toBe(2);
  });

  it('the two sides of a chord partition the lake', () => {
    expectArea(areaOf(BAY_MOUTH) + areaOf(REST_OF_LAKE), LAKE_AREA);
  });

  it('swapping a and b gives the same polygon', () => {
    const swapped = chordSubArea(LAKE, { ...BAY_MOUTH, a: BAY_MOUTH.b, b: BAY_MOUTH.a });
    const straight = chordSubArea(LAKE, BAY_MOUTH);
    expect(swapped.ok && straight.ok).toBe(true);
    if (!swapped.ok || !straight.ok) return;
    expect(polygonIoU(swapped.polygon, straight.polygon)).toBeGreaterThan(0.999);
  });

  it("an island bay: both points on the island's ring, and the clip leaves only the notch water", () => {
    const result = chordSubArea(LAKE, NOTCH_MOUTH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectArea(surfaceAreaSqM(result.polygon), NOTCH_AREA);
    // The short way round the island between the two points is the notch's own shore, so the
    // construction encloses only water — no island land to clip.
    expectArea(surfaceAreaSqM(result.constructed), NOTCH_AREA);
    const ring = result.constructed.coordinates[0] as Position[];
    expect(ring).toContainEqual(pos(1000, 800));
    expect(ring).toContainEqual(pos(1000, 1000));
  });

  it('on an island ring the long way round contains the notch too, and the smaller candidate wins', () => {
    // Walking the island the long way plus the chord encloses the island *and* the notch — so a
    // click in the notch is inside both candidates. The rule picks the smaller, and both clip to
    // the same water regardless; this pins that the choice is the notch, not the island.
    const candidates = chordCandidates(LAKE, NOTCH_MOUTH.a, NOTCH_MOUTH.b);
    expect(candidates.ok).toBe(true);
    if (!candidates.ok) return;
    const [big, small] = [
      candidates.sides[1 - candidates.smaller],
      candidates.sides[candidates.smaller],
    ];
    expectArea(surfaceAreaSqM(small as Polygon), NOTCH_AREA);
    expectArea(surfaceAreaSqM(big as Polygon), 600 * 600);
    const water = candidates.water[candidates.smaller];
    expect(water).not.toBeNull();
    expectArea(surfaceAreaSqM(water as Polygon), NOTCH_AREA);
  });

  it('re-snaps points that are near, not on, the shore — a moved shoreline does not orphan a mouth', () => {
    const near = chordSubArea(LAKE, {
      ...BAY_MOUTH,
      a: at(1800, 2990),
      b: at(2200, 3015),
      sagittaM: 5000,
    });
    expect(near.ok).toBe(true);
    if (!near.ok) return;
    // The mouth handed back is the one used: snapped points, clamped sagitta — what gets stored.
    expect(haversineMeters(near.mouth.a, at(1800, 3000))).toBeLessThan(1);
    // (2200, 3015) is already on the channel's east wall, so it snaps to itself.
    expect(haversineMeters(near.mouth.b, at(2200, 3015))).toBeLessThan(1);
    expect(near.mouth.sagittaM).toBeCloseTo(200, 0);
    expect(near.mouth.side).toEqual(BAY_MOUTH.side);
    const straight = chordSubArea(LAKE, { ...BAY_MOUTH, a: at(1800, 2990), b: at(2200, 3015) });
    if (straight.ok) expectArea(surfaceAreaSqM(straight.polygon), BAY_AREA);
  });
});

describe('chordSubArea — refusals', () => {
  it('refuses a chord from the mainland to an island', () => {
    const result = chordSubArea(LAKE, { ...BAY_MOUTH, a: at(1800, 3000), b: at(1200, 900) });
    expect(result).toEqual({ ok: false, reason: 'different_rings' });
  });

  it('refuses two points on the same spot', () => {
    const result = chordSubArea(LAKE, { ...BAY_MOUTH, b: BAY_MOUTH.a });
    expect(result).toEqual({ ok: false, reason: 'coincident' });
  });

  it('refuses a side point that is in neither candidate — off the island, when the chord is on it', () => {
    const result = chordSubArea(LAKE, { ...NOTCH_MOUTH, side: at(3000, 1500) });
    expect(result).toEqual({ ok: false, reason: 'side_ambiguous' });
  });

  it('refuses an inward arc swept so far in that it leaves the lake through a shore corner', () => {
    // The case fast-check found: from the lake's south-west corner to the basin's north-east
    // corner, bowed 1,700 m inward, the arc grazes the vertex at (0, 3000) from the land side —
    // no proper crossing, and a ring that encloses only land.
    const mouth: SubAreaMouth = {
      a: at(0, 0),
      b: at(2600, 3799),
      side: at(160, 1620),
      sagittaM: -1700,
    };
    expect(chordSubArea(LAKE, { ...mouth, sagittaM: 0 }).ok).toBe(true);
    expect(chordSubArea(LAKE, mouth)).toEqual({ ok: false, reason: 'crosses_shore' });
  });

  it('refuses an inward arc that cuts the mouth channel walls', () => {
    // A 600 m chord on the lake shore either side of the 400 m channel, bowed 200 m in: R = 325 m
    // around (2000, 2875), so at y = 3100 the arc is at x = 2000 ± 234 — through both walls.
    const wide: SubAreaMouth = { ...BAY_MOUTH, a: at(1700, 3000), b: at(2300, 3000) };
    expect(chordSubArea(LAKE, wide).ok).toBe(true);
    expect(chordSubArea(LAKE, { ...wide, sagittaM: -200 })).toEqual({
      ok: false,
      reason: 'crosses_shore',
    });
  });

  it('refuses a parent with no usable ring', () => {
    const degenerate: Polygon = {
      type: 'Polygon',
      coordinates: [[pos(0, 0), pos(1, 1), pos(0, 0)]],
    };
    expect(chordSubArea(degenerate, BAY_MOUTH)).toEqual({ ok: false, reason: 'no_outline' });
    expect(chordCandidates(degenerate, BAY_MOUTH.a, BAY_MOUTH.b)).toEqual({
      ok: false,
      reason: 'no_outline',
    });
  });

  it('a chord along a straight shore encloses nothing on one side and the whole lake on the other', () => {
    // Nobody draws this, but it must not crash: the empty side is not a candidate at all, and the
    // side point — a hair into the water — lands in the only region there is.
    const flat = chordSubArea(LAKE, {
      a: at(500, 0),
      b: at(1500, 0),
      side: at(1000, 1),
      sagittaM: 0,
    });
    expect(flat.ok).toBe(true);
    if (!flat.ok) return;
    expectArea(surfaceAreaSqM(flat.polygon), LAKE_AREA);
  });

  it('has a message for every refusal, the clip\u2019s included', () => {
    for (const message of Object.values(CHORD_MESSAGES)) expect(message.length).toBeGreaterThan(10);
    expect(CHORD_MESSAGES.clip_failed).toContain('freehand');
  });
});

describe('the arc', () => {
  it('a zero sagitta is the straight chord, and so is a side point on the chord line', () => {
    expect(chordArc(BAY_MOUTH.a, BAY_MOUTH.b, BAY_MOUTH.side, 0)).toEqual([
      BAY_MOUTH.a,
      BAY_MOUTH.b,
    ]);
    expect(chordArc(BAY_MOUTH.a, BAY_MOUTH.b, at(2000, 3000), 100)).toEqual([
      BAY_MOUTH.a,
      BAY_MOUTH.b,
    ]);
    expect(arcApex(BAY_MOUTH.a, BAY_MOUTH.b, at(2000, 3000), 100)).toEqual({
      lat: (BAY_MOUTH.a.lat + BAY_MOUTH.b.lat) / 2,
      lng: (BAY_MOUTH.a.lng + BAY_MOUTH.b.lng) / 2,
    });
  });

  it('bows away from the side by the sagitta, from a to b, through the apex', () => {
    const points = chordArc(BAY_MOUTH.a, BAY_MOUTH.b, BAY_MOUTH.side, 150);
    expect(points[0]).toEqual(BAY_MOUTH.a);
    expect(points[points.length - 1]).toEqual(BAY_MOUTH.b);
    expect(points.length).toBeGreaterThanOrEqual(17);
    // Away from the bay is south: the apex sits 150 m below the mouth line.
    const apex = arcApex(BAY_MOUTH.a, BAY_MOUTH.b, BAY_MOUTH.side, 150);
    expect(haversineMeters(apex, at(2000, 2850))).toBeLessThan(1);
    const nearest = Math.min(...points.map((p) => haversineMeters(p, apex)));
    expect(nearest).toBeLessThan(5);
    // Every sampled point is on the circle: equidistant from its center.
    const center = at(2000, 2850 + ((400 * 400) / (8 * 150) + 75));
    const radii = points.map((p) => haversineMeters(p, center));
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(2);
  });

  it('a negative sagitta bows toward the side', () => {
    const apex = arcApex(BAY_MOUTH.a, BAY_MOUTH.b, BAY_MOUTH.side, -150);
    expect(haversineMeters(apex, at(2000, 3150))).toBeLessThan(1);
  });

  it('clamps to a semicircle and treats sub-meter bows as straight', () => {
    expect(maxSagittaM(BAY_MOUTH.a, BAY_MOUTH.b)).toBeCloseTo(400 * MAX_SAGITTA_RATIO, 0);
    expect(clampSagitta(BAY_MOUTH.a, BAY_MOUTH.b, 5000)).toBeCloseTo(200, 0);
    expect(clampSagitta(BAY_MOUTH.a, BAY_MOUTH.b, -5000)).toBeCloseTo(-200, 0);
    expect(clampSagitta(BAY_MOUTH.a, BAY_MOUTH.b, 0.3)).toBe(0);
    const semicircle = chordArc(BAY_MOUTH.a, BAY_MOUTH.b, BAY_MOUTH.side, 5000);
    expect(
      haversineMeters(arcApex(BAY_MOUTH.a, BAY_MOUTH.b, BAY_MOUTH.side, 5000), at(2000, 2800)),
    ).toBeLessThan(1);
    expect(semicircle.length).toBeGreaterThan(17);
  });

  it('the drag handle round-trips: the apex asks for the sagitta that put it there', () => {
    for (const s of [-180, -40, 0, 40, 199]) {
      const apex = arcApex(BAY_MOUTH.a, BAY_MOUTH.b, BAY_MOUTH.side, s);
      expect(sagittaFromHandle(BAY_MOUTH.a, BAY_MOUTH.b, BAY_MOUTH.side, apex)).toBeCloseTo(s, 0);
    }
    // Dragging along the chord asks for nothing; dragging past the semicircle is clamped.
    expect(sagittaFromHandle(BAY_MOUTH.a, BAY_MOUTH.b, BAY_MOUTH.side, at(2150, 3000))).toBe(0);
    expect(sagittaFromHandle(BAY_MOUTH.a, BAY_MOUTH.b, BAY_MOUTH.side, at(2000, 0))).toBeCloseTo(
      200,
      0,
    );
    // A side point on the chord line has no outward: the handle is inert.
    expect(sagittaFromHandle(BAY_MOUTH.a, BAY_MOUTH.b, at(2000, 3000), at(2000, 2000))).toBe(0);
  });

  it('an outward arc takes in open water; an inward one gives it up', () => {
    const straight = areaOf(BAY_MOUTH);
    const out = areaOf({ ...BAY_MOUTH, sagittaM: 150 });
    const inward = areaOf({ ...BAY_MOUTH, sagittaM: -100 });
    expect(out).toBeGreaterThan(straight);
    expect(inward).toBeLessThan(straight);
    // The circular segment under a 150 m sagitta on a 400 m chord: ≈ R²·acos((R−h)/R) − (R−h)·√(2Rh−h²).
    const R = (400 * 400) / (8 * 150) + 75;
    const segment =
      R * R * Math.acos((R - 150) / R) - (R - 150) * Math.sqrt(2 * R * 150 - 150 * 150);
    expectArea(out - straight, segment);
  });
});

describe('chordCandidates', () => {
  it('names the smaller side, which is the bay', () => {
    const c = chordCandidates(LAKE, BAY_MOUTH.a, BAY_MOUTH.b);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expectArea(surfaceAreaSqM(c.sides[c.smaller]), BAY_AREA);
    expectArea(
      surfaceAreaSqM(c.sides[1 - c.smaller] as Polygon),
      LAKE_AREA - BAY_AREA + (600 * 600 - 200 * 200),
    );
    // The shaded water of the big side has the island cut out; the bay's is the bay.
    expectArea(surfaceAreaSqM(c.water[1 - c.smaller] as Polygon), LAKE_AREA - BAY_AREA);
    expectArea(surfaceAreaSqM(c.water[c.smaller] as Polygon), BAY_AREA);
  });

  it('refuses what the construction refuses', () => {
    expect(chordCandidates(LAKE, at(1800, 3000), at(1200, 900))).toEqual({
      ok: false,
      reason: 'different_rings',
    });
  });
});

// ── Properties ─────────────────────────────────────────────────────────────────────────────────

/** A point a fraction `u` of the way along the outer ring's perimeter. */
function alongOuter(u: number): LatLng {
  const verts = OUTER.map(([lng, lat]) => ({ lat, lng }) as LatLng);
  const lengths = verts.slice(1).map((v, i) => haversineMeters(verts[i] as LatLng, v));
  const total = lengths.reduce((s, l) => s + l, 0);
  let remaining = u * total;
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i] as number;
    if (remaining <= l) {
      const t = l === 0 ? 0 : remaining / l;
      const p = verts[i] as LatLng;
      const q = verts[i + 1] as LatLng;
      return { lat: p.lat + (q.lat - p.lat) * t, lng: p.lng + (q.lng - p.lng) * t };
    }
    remaining -= l;
  }
  return verts[0] as LatLng;
}

/** Two distinct positions on the outer ring, at least 50 m apart along it. */
const chordArb = fc
  .tuple(
    fc.double({ min: 0, max: 1, noNaN: true }),
    fc.double({ min: 0.005, max: 0.995, noNaN: true }),
  )
  .map(([u, gap]) => ({ a: alongOuter(u), b: alongOuter((u + gap) % 1) }));

describe('properties', () => {
  it('the result lies inside the parent', () => {
    fc.assert(
      fc.property(chordArb, fc.double({ min: -1, max: 1, noNaN: true }), ({ a, b }, k) => {
        const c = chordCandidates(LAKE, a, b);
        if (!c.ok || degenerate(c)) return true;
        const side = sideOf(c.sides[c.smaller]);
        const result = chordSubArea(LAKE, { a, b, side, sagittaM: k * maxSagittaM(a, b) });
        if (!result.ok) return result.reason === 'crosses_shore';
        const back = clipSubAreaToParent(result.polygon, LAKE, 0);
        return back.ok && back.retainedFraction > 0.999;
      }),
      { numRuns: 60 },
    );
  });

  it('the two sides partition the ring', () => {
    fc.assert(
      fc.property(chordArb, ({ a, b }) => {
        const c = chordCandidates(LAKE, a, b);
        if (!c.ok) return true;
        const whole = surfaceAreaSqM({ type: 'Polygon', coordinates: [OUTER] });
        const sum = surfaceAreaSqM(c.sides[0]) + surfaceAreaSqM(c.sides[1]);
        return Math.abs(sum - whole) / whole < 1e-6;
      }),
      { numRuns: 60 },
    );
  });

  it('swapping a and b gives the same polygon', () => {
    fc.assert(
      fc.property(chordArb, fc.double({ min: -0.9, max: 0.9, noNaN: true }), ({ a, b }, k) => {
        const c = chordCandidates(LAKE, a, b);
        if (!c.ok || degenerate(c)) return true;
        const side = sideOf(c.sides[c.smaller]);
        const s = k * maxSagittaM(a, b);
        const one = chordSubArea(LAKE, { a, b, side, sagittaM: s });
        const two = chordSubArea(LAKE, { a: b, b: a, side, sagittaM: s });
        if (!one.ok || !two.ok) return one.ok === two.ok;
        return polygonIoU(one.polygon, two.polygon) > 0.999;
      }),
      { numRuns: 60 },
    );
  });

  it('a zero sagitta is the straight chord', () => {
    fc.assert(
      fc.property(chordArb, ({ a, b }) => {
        const c = chordCandidates(LAKE, a, b);
        if (!c.ok || degenerate(c)) return true;
        const side = sideOf(c.sides[c.smaller]);
        const result = chordSubArea(LAKE, { a, b, side, sagittaM: 0 });
        const water = c.water[c.smaller];
        // A chord that clips a headland by a hair is refused — the candidates do not check that.
        if (!result.ok) return result.reason === 'crosses_shore';
        return water !== null && polygonIoU(result.polygon, water) > 0.999;
      }),
      { numRuns: 60 },
    );
  });

  it('area is monotone in sagitta', () => {
    fc.assert(
      fc.property(
        chordArb,
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        ({ a, b }, k1, k2) => {
          const c = chordCandidates(LAKE, a, b);
          if (!c.ok || degenerate(c)) return true;
          const side = sideOf(c.sides[c.smaller]);
          const max = maxSagittaM(a, b);
          const [lo, hi] = k1 < k2 ? [k1, k2] : [k2, k1];
          const small = chordSubArea(LAKE, { a, b, side, sagittaM: lo * max });
          const large = chordSubArea(LAKE, { a, b, side, sagittaM: hi * max });
          if (!small.ok || !large.ok) return true; // a refusal is not a shape to compare
          const as = surfaceAreaSqM(small.polygon);
          const al = surfaceAreaSqM(large.polygon);
          return al >= as * (1 - 1e-6);
        },
      ),
      { numRuns: 60 },
    );
  });
});

/** Both points on one straight shore: the smaller "side" is a line, not a region. Nothing to test. */
function degenerate(c: { sides: [Polygon, Polygon]; smaller: 0 | 1 }): boolean {
  return surfaceAreaSqM(c.sides[c.smaller]) < 1;
}

/**
 * A point inside a candidate's water — where a moderator's click on the shaded side would land.
 * `fetchOrigin`, not `representativePoint`: Turf's `pointOnFeature` can land on the boundary, and
 * a point on the chord is in both candidates.
 */
function sideOf(candidate: Polygon): LatLng {
  const clip = clipSubAreaToParent(candidate, LAKE, 0);
  const shape = clip.ok ? clip.polygon : candidate;
  return fetchOrigin(shape) ?? representativePoint(shape);
}
