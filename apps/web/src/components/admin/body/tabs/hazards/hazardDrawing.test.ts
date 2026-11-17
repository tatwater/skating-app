import { HAZARD_TYPES, type HazardShape, isValidHazardShape } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { fieldOpacity } from '../../map/hazardField';
import type { MapOutline, MapPoint } from '../../map/mapDescriptors';
import { featureGlyphOf } from './featureGlyph';
import { drawingOf, type HazardDrawing, isPlaceable, type Shaped } from './hazardDrawing';
import { FEB_HAZARDS, FEB_NOW } from './hazardsFixtures';
import { type HazardsMapData, hazardLit, hazardsMapScene } from './hazardsMap';
import { featureRows, type HazardInput, hazardRows, kindOf } from './hazardsModel';
import { CROSSING_CLAIM, LAKE_CLAIM, SHAPE_WORDS } from './hazardsWords';

/**
 * The one rule for drawing a stored shape (`drawingOf`) — what the map draws, what the row says and
 * the feature glyph, each asked of the same function — held over stored geometry of every sort, the
 * corrupt included: a drawable shape is always its footprint, a pin only stands in where the shape
 * can't be drawn, nothing is ever drawn at a coordinate off the globe, and a hazard with any usable
 * point is never left off the map.
 */

const ON_MASCOMA: [number, number] = [-72.16, 43.64];

const placeable = fc.tuple(
  fc.double({ min: -72.2, max: -72.1, noNaN: true }),
  fc.double({ min: 43.6, max: 43.7, noNaN: true }),
);
const unplaceable = fc.oneof(
  fc.constant([Number.NaN, 43.64]),
  fc.constant([-72.16, Number.POSITIVE_INFINITY]),
  fc.constant([200, 43.64]),
  fc.constant([-72.16, -95]),
  fc.constant([-72.16]),
  fc.constant(['-72.16', '43.64']),
);
const position = fc.oneof(
  { weight: 4, arbitrary: placeable },
  { weight: 1, arbitrary: unplaceable },
);
const ring = fc
  .tuple(fc.array(position, { minLength: 0, maxLength: 5 }), fc.boolean())
  .map(([ps, closed]) => (closed && ps.length > 0 ? [...ps, ps[0]] : ps));

/** Stored geometry as a row might hold it: well-formed, malformed, or not a geometry at all. */
const geometry = fc.oneof(
  position.map((coordinates) => ({ type: 'Point', coordinates })),
  fc.array(position, { maxLength: 5 }).map((coordinates) => ({ type: 'LineString', coordinates })),
  fc
    .array(ring, { minLength: 0, maxLength: 2 })
    .map((coordinates) => ({ type: 'Polygon', coordinates })),
  fc
    .array(fc.array(ring, { minLength: 1, maxLength: 2 }), { maxLength: 2 })
    .map((coordinates) => ({ type: 'MultiPolygon', coordinates })),
  fc.constantFrom(
    null,
    undefined,
    {},
    { type: 'Bogus' },
    { type: 'GeometryCollection', geometries: [] },
  ),
);
const size = fc.oneof(
  fc.constant(undefined),
  fc.constantFrom(Number.NaN, 0, -5, 1e7),
  fc.double({ min: 1, max: 200, noNaN: true }),
);
const stored: fc.Arbitrary<Shaped> = fc.record(
  {
    _id: fc.constant('h'),
    geometryKind: fc.constantFrom('point_radius', 'line', 'polygon') as fc.Arbitrary<
      HazardShape['geometryKind']
    >,
    geometry,
    radiusMeters: size,
    bufferMeters: size,
    clippedFootprint: fc.oneof(fc.constant(undefined), geometry),
  },
  { requiredKeys: ['_id', 'geometryKind', 'geometry'] },
) as fc.Arbitrary<Shaped>;

/** Shapes the server's gate admits: a point and a radius, a line and a band, a triangle. */
const radius = fc.double({ min: 1, max: 500, noNaN: true });
const admitted: fc.Arbitrary<Shaped> = fc.oneof(
  fc.tuple(placeable, radius).map(([at, radiusMeters]) => ({
    _id: 'h',
    geometryKind: 'point_radius' as const,
    geometry: { type: 'Point', coordinates: at },
    radiusMeters,
  })),
  fc.tuple(placeable, placeable, radius).map(([a, b, bufferMeters]) => ({
    _id: 'h',
    geometryKind: 'line' as const,
    geometry: { type: 'LineString', coordinates: [a, b] },
    bufferMeters,
  })),
  fc.tuple(placeable, fc.double({ min: 0.001, max: 0.02, noNaN: true })).map(([[x, y], d]) => ({
    _id: 'h',
    geometryKind: 'polygon' as const,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x, y],
          [x + d, y],
          [x, y + d],
          [x, y],
        ],
      ],
    },
  })),
);

/** Every coordinate a drawing hands the map. */
function coordinatesOf(d: HazardDrawing): unknown[] {
  if (d.kind === 'nowhere') return [];
  if (d.kind === 'pin') return [d.at];
  const polys = d.area.type === 'Polygon' ? [d.area.coordinates] : d.area.coordinates;
  return [d.at, ...polys.flat(2)];
}

/** The placeable positions a stored geometry holds, anywhere in it. */
function placeablesIn(g: unknown): number[][] {
  const out: number[][] = [];
  const walk = (v: unknown) => {
    if (isPlaceable(v)) out.push([v[0], v[1]]);
    else if (Array.isArray(v)) for (const x of v) walk(x);
  };
  walk((g as { coordinates?: unknown } | null | undefined)?.coordinates);
  return out;
}

const PINNED = [20261117, 42, 7];
const check = (property: fc.IProperty<[Shaped]> | fc.IProperty<never>, runs = 100) => {
  for (const seed of PINNED) fc.assert(property, { seed, numRuns: runs });
  fc.assert(property, { numRuns: runs });
};

describe('drawingOf — the one rule', () => {
  it('hands the map only coordinates on the globe (pinned seeds, then one random)', () => {
    check(
      fc.property(stored, (s) => {
        for (const p of coordinatesOf(drawingOf(s))) expect(isPlaceable(p)).toBe(true);
      }),
    );
  });

  it('never leaves a stored shape with a usable point off the map, and a pin sits among its points', () => {
    check(
      fc.property(stored, (s) => {
        const d = drawingOf(s);
        const points = placeablesIn(s.geometry);
        if (d.kind === 'nowhere') expect(points).toEqual([]);
        if (d.kind !== 'pin') return;
        // The pin is a stored point or the middle of stored points: inside their box.
        const lngs = points.map((p) => p[0] as number);
        const lats = points.map((p) => p[1] as number);
        const eps = 1e-9;
        expect(d.at[0]).toBeGreaterThanOrEqual(Math.min(...lngs) - eps);
        expect(d.at[0]).toBeLessThanOrEqual(Math.max(...lngs) + eps);
        expect(d.at[1]).toBeGreaterThanOrEqual(Math.min(...lats) - eps);
        expect(d.at[1]).toBeLessThanOrEqual(Math.max(...lats) + eps);
      }),
    );
  });

  it('a shape the server would store is always drawn as its shape — a pin never stands in for one', () => {
    check(
      fc.property(fc.oneof(admitted, stored), (s) => {
        const shape = s as unknown as HazardShape;
        let valid = false;
        try {
          valid = isValidHazardShape(shape);
        } catch {
          valid = false;
        }
        if (valid) expect(drawingOf(s).kind).toBe('footprint');
      }),
    );
  });

  it('the named cases', () => {
    const point = { type: 'Point', coordinates: ON_MASCOMA };
    expect(
      drawingOf({ _id: 'a', geometryKind: 'point_radius', geometry: point, radiusMeters: 40 }),
    ).toMatchObject({ kind: 'footprint', at: ON_MASCOMA });
    // A radius that can't grow: the point stands.
    expect(
      drawingOf({
        _id: 'a',
        geometryKind: 'point_radius',
        geometry: point,
        radiusMeters: Number.NaN,
      }),
    ).toEqual({ kind: 'pin', at: ON_MASCOMA });
    // A clip with a hole of NaN is no clip: the shape is grown instead.
    const badClip = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
        [
          [Number.NaN, 0],
          [0, 0],
          [0, 0],
          [Number.NaN, 0],
        ],
      ],
    };
    const d = drawingOf({
      _id: 'a',
      geometryKind: 'point_radius',
      geometry: point,
      radiusMeters: 40,
      clippedFootprint: badClip,
    });
    expect(d.kind).toBe('footprint');
    expect((d as { area: unknown }).area).not.toBe(badClip);
    // A MultiPolygon too broken to grow: the middle of its outer rings' distinct corners.
    expect(
      drawingOf({
        _id: 'a',
        geometryKind: 'polygon',
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [0, 0],
                [2, 0],
                [0, 0],
              ],
            ],
            [
              [
                [4, 4],
                [Number.NaN, 4],
              ],
            ],
          ],
        },
      }),
    ).toEqual({ kind: 'pin', at: [2, 4 / 3] });
    expect(drawingOf({ _id: 'a', geometryKind: 'line', geometry: null })).toEqual({
      kind: 'nowhere',
    });
    // A ring, or a polygon, that is not an array at all: the area is checked as it is handed back,
    // so it is never drawn with the junk inside it — the outer ring's middle is pinned instead.
    const square = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ];
    expect(
      drawingOf({
        _id: 'a',
        geometryKind: 'polygon',
        geometry: { type: 'Polygon', coordinates: [square, 7] },
      }),
    ).toEqual({ kind: 'pin', at: [1, 1] });
    expect(
      drawingOf({
        _id: 'a',
        geometryKind: 'polygon',
        geometry: { type: 'MultiPolygon', coordinates: [[square], 'x'] },
      }),
    ).toEqual({ kind: 'pin', at: [1, 1] });
    // The same row asks once: the map, its list row and its glyph share one answer.
    const row: Shaped = {
      _id: 'a',
      geometryKind: 'point_radius',
      geometry: point,
      radiusMeters: 40,
    };
    expect(drawingOf(row)).toBe(drawingOf(row));
  });
});

it('the words say the shape is unknown or off the map — never that the hazard is gone (D3)', () => {
  for (const words of Object.values(SHAPE_WORDS)) {
    expect(words).not.toMatch(LAKE_CLAIM);
    expect(words).not.toMatch(CROSSING_CLAIM);
  }
});

describe('the map, the row and the glyph give one answer', () => {
  const freshness = fc.constantFrom('fresh', 'aging', 'stale') as fc.Arbitrary<
    'fresh' | 'aging' | 'stale'
  >;
  const hazard = fc
    .tuple(
      stored,
      fc.constantFrom(...HAZARD_TYPES, 'a_type_this_build_lacks'),
      freshness,
      fc.boolean(),
      fc.constantFrom(undefined, 'none', 'healing_unsafe', 'disputed'),
      fc.nat(999),
    )
    .map(([s, type, fresh, provisional, healingState, n]) => ({
      ...s,
      _id: `h${n}`,
      type,
      freshness: fresh,
      provisional,
      ...(healingState === undefined ? {} : { healingState }),
    }));

  /** A row's facts, without its shape: each generated hazard brings its own, absent keys included. */
  const {
    geometryKind: _k,
    geometry: _g,
    radiusMeters: _r,
    bufferMeters: _b,
    ...ROW_FACTS
  } = FEB_HAZARDS[0] as HazardInput;

  const property = fc.property(
    fc.uniqueArray(hazard, { selector: (h) => h._id, maxLength: 5 }),
    (hazards) => {
      const data: HazardsMapData = { season: 2025, current: 2025, hazards, features: [] };
      const scene = hazardsMapScene(data, null);
      const rows = hazardRows(
        hazards.map((h) => ({ ...ROW_FACTS, ...h })),
        FEB_NOW,
      );
      hazards.forEach((h, i) => {
        const d = drawingOf(h);
        const drawn = scene.items.filter((it) => it.id === hazardLit(h._id));
        const sub = rows[i]?.sub ?? '';
        // **Never dropped while it has a usable point**; drawn once.
        expect(drawn).toHaveLength(d.kind === 'nowhere' ? 0 : 1);
        expect(sub.includes(SHAPE_WORDS.nowhere)).toBe(d.kind === 'nowhere');
        const item = drawn[0];
        if (item === undefined) return;
        const healing = h.healingState === 'healing_unsafe';
        const field = {
          freshness: h.freshness,
          tone: healing ? 'healing' : 'hazard',
          provisional: h.provisional,
        };
        if (kindOf(h.type) === 'crossing') {
          expect(item).toMatchObject({ kind: 'point', mark: 'passage' });
          expect(sub).not.toContain(SHAPE_WORDS.unknown);
          return;
        }
        if (d.kind === 'footprint') {
          expect((item as MapOutline).field).toEqual(field);
          expect(sub).not.toContain(SHAPE_WORDS.unknown);
          return;
        }
        // The pin: the hazard's own face — never a crossing's, never a lesser one — at exactly the
        // fade its field would have had, said as shape unknown on the map and in the row.
        const pin = item as MapPoint;
        expect(pin.mark).toBe(healing ? 'healing' : 'hazard');
        expect(pin.field).toEqual(field);
        expect(fieldOpacity(pin.field as never)).toBe(fieldOpacity(field as never));
        expect(pin.caption).toBe(SHAPE_WORDS.unknown);
        expect(sub).toContain(SHAPE_WORDS.unknown);
      });
    },
  );

  it('for every hazard, whatever its stored shape (pinned seeds, then one random)', () => {
    for (const seed of PINNED) fc.assert(property, { seed, numRuns: 60 });
    fc.assert(property, { numRuns: 60 });
  });

  it('a known feature: its row and its glyph follow its pin', () => {
    const lost = {
      _id: 'f',
      type: 'spring_current',
      geometryKind: 'point_radius' as const,
      geometry: { type: 'Point', coordinates: ON_MASCOMA },
      radiusMeters: Number.NaN,
      createdAt: FEB_NOW,
    };
    const drawn = { ...lost, radiusMeters: 40 };
    const [lostRow, drawnRow] = featureRows([lost, drawn]);
    expect(lostRow?.sub).toContain(SHAPE_WORDS.unknown);
    // The radius that can't grow is no size to print: the row says a point, never "NaN m".
    expect(lostRow?.sub.startsWith('Point · ')).toBe(true);
    expect(drawnRow?.sub).not.toContain(SHAPE_WORDS.unknown);
    expect(drawnRow?.sub.startsWith('Point, 40 m · ')).toBe(true);
    expect(featureGlyphOf(lost)).toBeNull();
    expect(featureGlyphOf(drawn)).not.toBeNull();
  });
});
