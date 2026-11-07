import {
  deriveShoreBand,
  HAZARD_TYPES,
  haversineMeters,
  type LatLng,
  SHORE_BAND_DEFAULT_HALF_WIDTH_M,
} from '@skating/core';
import fc from 'fast-check';
import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';

import type { HazardDraft } from '@/stores/hazardDraftStore';

import {
  aboutFeet,
  applyAreaRing,
  applyMapClick,
  chooseDrawKind,
  chooseType,
  clearType,
  deriveShore,
  drawKindOf,
  drawKindsFor,
  flipShore,
  mapModeFor,
  postBlocker,
  replaceLabel,
  resize,
  shapeOf,
  shoreToggleLabel,
  sizeCopy,
  startDraft,
  stepOf,
  stopPlacing,
  undoPlacement,
  whereLine,
} from './hazardFlowModel';

// Mascoma-ish: a ring of 24 shoreline vertices about 1.2 km across.
const CENTER = { lat: 43.63, lng: -72.15 };
function ring(n: number, radiusDeg = 0.008, jitter: number[] = []): LatLng[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    const r = radiusDeg * (1 + (jitter[i] ?? 0));
    return { lat: CENTER.lat + r * Math.sin(a), lng: CENTER.lng + (r * Math.cos(a)) / 0.72 };
  });
}
function polygonOf(points: LatLng[]): Polygon {
  const coords = points.map((p) => [p.lng, p.lat]);
  return { type: 'Polygon', coordinates: [[...coords, coords[0] as number[]]] };
}
const LAKE = ring(24);
const POLY = polygonOf(LAKE);

const base = startDraft('mascoma', false);
const at = (lat: number, lng: number): LatLng => ({ lat, lng });

describe('choosing what you saw (3.1)', () => {
  it('a line type starts as a line, and the map starts listening', () => {
    const d = chooseType(base, 'pressure_ridge');
    expect(d.drawKind).toBe('line');
    expect(d.placing).toBe(true);
    expect(d.step).toBe('where');
    expect(mapModeFor(d)).toEqual({
      mode: 'Tracing a line',
      line: 'Click along it, then Done',
      step: '0 points',
      // The bar's exit closes the flow, so it says Close, as the sheet's button does.
      exitLabel: 'Close',
    });
  });

  it('a retype keeps what was placed', () => {
    const placed = applyMapClick(chooseType(base, 'thin_ice'), at(43.63, -72.15), POLY);
    expect(placed.placing).toBe(false);
    const retyped = chooseType(placed, 'drain_hole');
    expect(retyped.shape).toMatchObject({ geometryKind: 'point_radius', coord: at(43.63, -72.15) });
    expect(retyped.placing).toBe(false);
    expect(retyped.step).toBe('details');
  });

  it('a retype after a shore band starts over (a ridge never takes the shoreline’s shape)', () => {
    const banded = applyMapClick(
      applyMapClick(chooseDrawKind(chooseType(base, 'thin_ice'), 'shore'), LAKE[0] as LatLng, POLY),
      LAKE[3] as LatLng,
      POLY,
    );
    expect(banded.shore?.arcLengthMeters).toBeGreaterThan(0);
    const retyped = chooseType(banded, 'pressure_ridge');
    expect(retyped.shore).toBeNull();
    expect(retyped.drawKind).toBe('line');
    expect(retyped.placing).toBe(true);
  });

  it('the × goes back to every type and stops listening, keeping the shape', () => {
    const d = clearType(chooseType(base, 'pressure_ridge'));
    expect(d.hazardType).toBeNull();
    expect(d.placing).toBe(false);
    expect(d.step).toBe('what');
    expect(d.shape).not.toBeNull();
    expect(mapModeFor(d)).toBeNull();
  });

  it('shore is offered only to the shore-shaped types', () => {
    expect(drawKindsFor(null)).toEqual(['spot', 'line', 'area']);
    expect(drawKindsFor('thin_ice')).toContain('shore');
    expect(drawKindsFor('open_water')).toContain('shore');
    expect(drawKindsFor('pressure_ridge')).not.toContain('shore');
    expect(chooseDrawKind(chooseType(base, 'pressure_ridge'), 'shore').drawKind).toBe('line');
    expect(chooseDrawKind(base, 'line')).toBe(base);
  });
});

describe('placing (3.2–3.6): a sub-mode is left by a click', () => {
  it('a spot takes one click and the mode ends', () => {
    const d = chooseDrawKind(chooseType(base, 'pressure_ridge'), 'spot');
    expect(mapModeFor(d)).toEqual({
      mode: 'Placing a spot',
      line: 'Click where it is',
      exitLabel: 'Close',
    });
    const placed = applyMapClick(d, at(43.62, -72.14), POLY);
    expect(placed.placing).toBe(false);
    expect(whereLine(placed)).toBe('Placed on the map.');
    expect(replaceLabel(placed)).toBe('Move on map');
    // A click after the mode ended is not the flow's.
    expect(applyMapClick(placed, at(1, 1), POLY)).toBe(placed);
  });

  it('a line appends until Done, and undo steps back one point', () => {
    let d = chooseType(base, 'pressure_ridge');
    d = applyMapClick(d, at(43.628, -72.153), POLY);
    expect(whereLine(d)).toBe('Traced with 1 point — a line needs at least two.');
    expect(postBlocker(d)).toBe('Place it on the map first');
    d = applyMapClick(d, at(43.629, -72.149), POLY);
    d = applyMapClick(d, at(43.6298, -72.146), POLY);
    expect(whereLine(d)).toBe('Traced with 3 points.');
    expect(mapModeFor(d)?.step).toBe('3 points');
    expect(d.placing).toBe(true);
    d = undoPlacement(d);
    expect(whereLine(d)).toBe('Traced with 2 points.');
    expect(replaceLabel(d)).toBeNull();
    d = stopPlacing(d);
    expect(mapModeFor(d)).toBeNull();
    expect(replaceLabel(d)).toBe('Keep tracing');
    expect(postBlocker(d)).toBeNull();
    expect(chooseDrawKind(d, 'line').placing).toBe(true);
  });

  it('an area belongs to the drawing tool: map clicks pass it by, its ring lands as corners', () => {
    let d = chooseDrawKind(chooseType(base, 'thin_ice'), 'area');
    expect(mapModeFor(d)?.line).toBe('Click each corner, then the first one again');
    expect(applyMapClick(d, at(43.61, -72.13), POLY)).toBe(d);
    expect(replaceLabel(stopPlacing(d))).toBe('Draw on map');
    d = applyAreaRing(d, [at(43.6135, -72.1324), at(43.6128, -72.1285), at(43.6097, -72.1293)]);
    expect(whereLine(d)).toBe('Drawn with 3 corners.');
    expect(mapModeFor(d)?.step).toBe('3 corners');
    expect(replaceLabel(stopPlacing(d))).toBe('Adjust corners');
    expect(applyAreaRing(d, null).shape).toMatchObject({ vertices: [] });
    expect(whereLine(applyAreaRing(d, [at(43.61, -72.13)]))).toBe(
      'Drawn with 1 corner — an area needs at least three.',
    );
    // Not an area: the ring is someone else's.
    const line = chooseType(base, 'pressure_ridge');
    expect(applyAreaRing(line, [])).toBe(line);
    expect(undoPlacement(d)).toBe(d);
  });

  it('the shore takes two clicks, derives, and stops', () => {
    let d = chooseDrawKind(chooseType(base, 'open_water'), 'shore');
    expect(whereLine(d)).toBe('Picking a stretch of shore.');
    expect(mapModeFor(d)).toMatchObject({ line: 'Click one end of the stretch', step: '0 of 2' });
    d = applyMapClick(d, LAKE[2] as LatLng, POLY);
    expect(whereLine(d)).toBe('Now click the other end.');
    expect(mapModeFor(d)).toMatchObject({ line: 'Click the other end', step: '1 of 2' });
    d = applyMapClick(d, LAKE[5] as LatLng, POLY);
    expect(d.placing).toBe(false);
    expect(whereLine(d)).toMatch(/^Following about [\d,]+ ft of shoreline\.$/);
    expect(shapeOf(d)).not.toBeNull();
    expect(replaceLabel(d)).toBe('Pick a different stretch');
    // A third click (after re-arming) starts the pick again.
    const again = applyMapClick({ ...d, placing: true }, LAKE[9] as LatLng, POLY);
    expect(again.shore?.taps).toEqual([LAKE[9]]);
  });

  it('a refused band names the reason, empties the shape, and keeps the width live', () => {
    let d = chooseDrawKind(chooseType(base, 'thin_ice'), 'shore');
    d = applyMapClick(d, LAKE[1] as LatLng, POLY);
    d = applyMapClick(d, LAKE[1] as LatLng, POLY);
    expect(d.shore?.refusal).toBe('degenerate_arc');
    expect(shapeOf(d)).toBeNull();
    expect(sizeCopy(d)?.question).toBe('How far out from shore?');
    const narrowed = resize(d, -1, POLY);
    expect(narrowed.shore?.halfWidthMeters).toBeLessThan(SHORE_BAND_DEFAULT_HALF_WIDTH_M);
    // No outline at all is its own refusal.
    const none = deriveShore(
      {
        ...d,
        shore: {
          ...(d.shore as NonNullable<HazardDraft['shore']>),
          taps: [LAKE[1] as LatLng, LAKE[4] as LatLng],
        },
      },
      null,
    );
    expect(none.shore?.refusal).toBe('no_boundary');
    // Nothing to derive yet ⇒ unchanged.
    expect(deriveShore(base, POLY)).toBe(base);
    expect(flipShore(base, POLY)).toBe(base);
  });
});

describe('size copy, in feet (3.7)', () => {
  it('says each primitive’s size as an estimate', () => {
    const spot = applyMapClick(chooseType(base, 'thin_ice'), at(43.62, -72.14), POLY);
    expect(sizeCopy(spot)).toMatchObject({ question: 'Roughly how big?', narrower: 'Smaller' });
    expect(sizeCopy(spot)?.value).toMatch(/^about [\d,]+ ft around the spot$/);
    const line = chooseType(base, 'pressure_ridge');
    expect(sizeCopy(line)).toMatchObject({ question: 'Roughly how wide?', wider: 'Wider' });
    const area = chooseDrawKind(chooseType(base, 'thin_ice'), 'area');
    expect(sizeCopy(area)?.value).toMatch(/of give around the edge$/);
    expect(sizeCopy(base)).toBeNull();
  });

  it('steps the draft’s own size', () => {
    const spot = applyMapClick(chooseType(base, 'thin_ice'), at(43.62, -72.14), POLY);
    const bigger = resize(spot, 1, POLY);
    expect(bigger.shape).not.toEqual(spot.shape);
    expect(resize(base, 1, POLY)).toBe(base);
  });

  it('rounds feet the way an estimate is said', () => {
    expect(aboutFeet(2)).toBe('7');
    expect(aboutFeet(25)).toBe('80');
    expect(aboutFeet(1000)).toBe('3,280');
  });
});

describe('the screen’s order', () => {
  it('what → where → details, and confirm while the nudge is up', () => {
    expect(stepOf(base)).toBe('what');
    expect(postBlocker(base)).toBe('Pick what you saw, then place it on the map');
    const d = chooseType(base, 'thin_ice');
    expect(stepOf(d)).toBe('where');
    const placed = applyMapClick(d, at(43.62, -72.14), POLY);
    expect(stepOf(placed)).toBe('details');
    expect(stepOf({ ...placed, nearbyHazardId: 'h1' })).toBe('confirm');
  });

  it('copy for nothing placed', () => {
    expect(whereLine(base)).toBe('Not placed yet.');
    expect(replaceLabel(base)).toBeNull();
    const spot = chooseDrawKind(chooseType(base, 'pressure_ridge'), 'spot');
    expect(whereLine(spot)).toBe('Not placed yet.');
    expect(replaceLabel(stopPlacing(spot))).toBe('Place on map');
    expect(replaceLabel(stopPlacing(chooseType(base, 'pressure_ridge')))).toBe('Trace on map');
    expect(drawKindOf({ geometryKind: 'polygon', vertices: [], bufferMeters: 8 })).toBe('area');
  });

  it('the shore toggle reads what the next click does', () => {
    const shore = {
      taps: [],
      halfWidthMeters: 25,
      theOtherWay: false,
      refusal: null,
      arcLengthMeters: null,
    };
    expect(shoreToggleLabel(shore)).toBe('Long way around');
    expect(shoreToggleLabel({ ...shore, theOtherWay: true })).toBe('Shortest distance');
  });
});

// ── Properties: the safety-adjacent geometry ──────────────────────────────────────────────────

function arcKey(p: LatLng) {
  return `${p.lat.toFixed(9)},${p.lng.toFixed(9)}`;
}
function pathLength(path: readonly LatLng[]) {
  let total = 0;
  for (let i = 0; i + 1 < path.length; i++)
    total += haversineMeters(path[i] as LatLng, path[i + 1] as LatLng);
  return total;
}

describe('property: the shore toggle’s two arcs partition the shoreline', () => {
  it('for any lake and two distinct ends: the arcs share only their ends, cover every vertex, sum to the perimeter, and the default is the shorter', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 6, max: 40 }).chain((n) =>
          fc.record({
            n: fc.constant(n),
            jitter: fc.array(fc.double({ min: -0.25, max: 0.25, noNaN: true }), {
              minLength: n,
              maxLength: n,
            }),
            a: fc.integer({ min: 0, max: n - 1 }),
            b: fc.integer({ min: 0, max: n - 1 }),
          }),
        ),
        ({ n, jitter, a, b }) => {
          fc.pre(a !== b);
          const lake = ring(n, 0.008, jitter);
          const poly = polygonOf(lake);
          const opts = { halfWidthMeters: 4 };
          const short = deriveShoreBand(poly, lake[a] as LatLng, lake[b] as LatLng, opts);
          const long = deriveShoreBand(poly, lake[a] as LatLng, lake[b] as LatLng, {
            ...opts,
            theOtherWay: true,
          });
          fc.pre(short.ok && long.ok);
          if (!short.ok || !long.ok) return;
          const s = short.band.arc.map(arcKey);
          const l = long.band.arc.map(arcKey);
          const ends = new Set([arcKey(lake[a] as LatLng), arcKey(lake[b] as LatLng)]);
          // Shared vertices are exactly the two ends.
          const shared = s.filter((k) => l.includes(k));
          expect(new Set(shared)).toEqual(ends);
          // Together they cover every shoreline vertex.
          const all = new Set([...s, ...l]);
          expect(all.size).toBe(n);
          // And their lengths are the perimeter.
          const perimeter = pathLength([...lake, lake[0] as LatLng]);
          expect(short.band.arcLengthMeters + long.band.arcLengthMeters).toBeCloseTo(perimeter, 3);
          expect(short.band.arcLengthMeters).toBeLessThanOrEqual(long.band.arcLengthMeters + 1e-6);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('flipping twice through the flow lands back on the same band', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 23 }), (a, b) => {
        fc.pre(a !== b);
        let d: HazardDraft = chooseDrawKind(chooseType(base, 'thin_ice'), 'shore');
        d = applyMapClick(applyMapClick(d, LAKE[a] as LatLng, POLY), LAKE[b] as LatLng, POLY);
        const flipped = flipShore(d, POLY);
        expect(flipped.shore?.theOtherWay).toBe(true);
        expect(flipShore(flipped, POLY).shape).toEqual(d.shape);
      }),
      { numRuns: 60 },
    );
  });
});

/** Proper segment intersection (shared endpoints don't count). */
function segmentsCross(p1: LatLng, p2: LatLng, p3: LatLng, p4: LatLng): boolean {
  const d = (a: LatLng, b: LatLng, c: LatLng) =>
    (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

describe('property: a drawn area is closed and never self-intersecting', () => {
  const arbCoord = fc.record({
    lat: fc.double({ min: 43.6, max: 43.66, noNaN: true }),
    lng: fc.double({ min: -72.2, max: -72.1, noNaN: true }),
  });
  it('for any corners the area tool hands back, the postable shape is a closed simple ring or nothing', () => {
    fc.assert(
      fc.property(
        fc.array(arbCoord, { minLength: 0, maxLength: 9 }),
        fc.constantFrom(...HAZARD_TYPES),
        (corners, type) => {
          const d = applyAreaRing(chooseDrawKind(chooseType(base, type), 'area'), corners);
          const shape = shapeOf(d);
          if (shape === null) return;
          expect(shape.geometry.type).toBe('Polygon');
          const r = (shape.geometry as Polygon).coordinates[0] as number[][];
          expect(r[0]).toEqual(r[r.length - 1]);
          const pts = r.map(([lng = 0, lat = 0]) => ({ lat, lng }));
          for (let i = 0; i + 1 < pts.length; i++) {
            for (let j = i + 2; j + 1 < pts.length; j++) {
              if (i === 0 && j + 1 === pts.length - 1) continue; // the closing edge's neighbor
              expect(
                segmentsCross(
                  pts[i] as LatLng,
                  pts[i + 1] as LatLng,
                  pts[j] as LatLng,
                  pts[j + 1] as LatLng,
                ),
              ).toBe(false);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
