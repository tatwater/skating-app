import { SENTINEL_MASK_METERS } from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  type CorpusMaskRow,
  emptyTally,
  MAX_REPORTED_OMISSIONS,
  maskFeatureFor,
  recordOutcome,
} from './revealMasks';

/** A square roughly 400 m on a side near Burlington, at the latitude the buffers were tuned for. */
function squareAt(lat: number, lng: number, deg = 0.002): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lng, lat],
        [lng + deg, lat],
        [lng + deg, lat + deg],
        [lng, lat + deg],
        [lng, lat],
      ],
    ],
  };
}

const BURLINGTON = { lat: 44.47, lng: -73.21 };

describe('maskFeatureFor', () => {
  it('buffers a lake outward, so the reveal extends past the shoreline', () => {
    const row: CorpusMaskRow = {
      waterBodyId: 'w1',
      polygon: squareAt(BURLINGTON.lat, BURLINGTON.lng),
    };
    const outcome = maskFeatureFor(row);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const before = bboxOf(row.polygon);
    const after = bboxOf(outcome.feature.geometry);
    // Every side moved outward. Asserting the direction rather than a distance: the exact metre count
    // is Turf's business and pinning it here would make this a change-detector for their rounding.
    expect(after.minLng).toBeLessThan(before.minLng);
    expect(after.minLat).toBeLessThan(before.minLat);
    expect(after.maxLng).toBeGreaterThan(before.maxLng);
    expect(after.maxLat).toBeGreaterThan(before.maxLat);
  });

  it('carries the id and name through, because an id is not a lake in QGIS', () => {
    const outcome = maskFeatureFor({
      waterBodyId: 'w1',
      name: 'Lake Iroquois',
      polygon: squareAt(BURLINGTON.lat, BURLINGTON.lng),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.feature.properties).toEqual({ waterBodyId: 'w1', name: 'Lake Iroquois' });
  });

  it('omits `name` entirely rather than writing undefined into the artifact', () => {
    const outcome = maskFeatureFor({
      waterBodyId: 'w1',
      polygon: squareAt(BURLINGTON.lat, BURLINGTON.lng),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect('name' in outcome.feature.properties).toBe(false);
  });

  it('grows the reveal toward a parking lot up the road — the tentacle D146 asked for', () => {
    const polygon = squareAt(BURLINGTON.lat, BURLINGTON.lng);
    const lakeOnly = maskFeatureFor({ waterBodyId: 'w1', polygon });
    // ~700 m north of the square's top edge: well outside the 60 m water buffer, so it can only be
    // covered by its own disc.
    const withParking = maskFeatureFor({
      waterBodyId: 'w1',
      polygon,
      parkingCoords: [{ lat: BURLINGTON.lat + 0.008, lng: BURLINGTON.lng + 0.001 }],
    });

    expect(lakeOnly.ok && withParking.ok).toBe(true);
    if (!lakeOnly.ok || !withParking.ok) return;
    expect(bboxOf(withParking.feature.geometry).maxLat).toBeGreaterThan(
      bboxOf(lakeOnly.feature.geometry).maxLat,
    );
  });

  it('covers the whole length of a routed approach path', () => {
    const polygon = squareAt(BURLINGTON.lat, BURLINGTON.lng);
    const withWalk = maskFeatureFor({
      waterBodyId: 'w1',
      polygon,
      approachPaths: [
        [
          { lat: BURLINGTON.lat, lng: BURLINGTON.lng },
          { lat: BURLINGTON.lat - 0.01, lng: BURLINGTON.lng - 0.01 },
        ],
      ],
    });
    expect(withWalk.ok).toBe(true);
    if (!withWalk.ok) return;
    const box = bboxOf(withWalk.feature.geometry);
    expect(box.minLat).toBeLessThan(BURLINGTON.lat - 0.01);
    expect(box.minLng).toBeLessThan(BURLINGTON.lng - 0.01);
  });

  it('ignores a one-point approach path, which is a marker that lost its other end', () => {
    const polygon = squareAt(BURLINGTON.lat, BURLINGTON.lng);
    const bare = maskFeatureFor({ waterBodyId: 'w1', polygon });
    const stub = maskFeatureFor({
      waterBodyId: 'w1',
      polygon,
      approachPaths: [[{ lat: BURLINGTON.lat - 0.05, lng: BURLINGTON.lng }]],
    });
    expect(bare.ok && stub.ok).toBe(true);
    if (!bare.ok || !stub.ok) return;
    // The stray point is 5 km south; if it had been buffered the bbox would have swallowed it.
    expect(bboxOf(stub.feature.geometry).minLat).toBeCloseTo(
      bboxOf(bare.feature.geometry).minLat,
      6,
    );
  });

  it('reveals islands in full — the outer ring only, never a hole', () => {
    const withIsland: Polygon = {
      type: 'Polygon',
      coordinates: [
        squareAt(BURLINGTON.lat, BURLINGTON.lng, 0.004).coordinates[0] as number[][],
        // A hole well inside the outer ring.
        [
          [BURLINGTON.lng + 0.001, BURLINGTON.lat + 0.001],
          [BURLINGTON.lng + 0.002, BURLINGTON.lat + 0.001],
          [BURLINGTON.lng + 0.002, BURLINGTON.lat + 0.002],
          [BURLINGTON.lng + 0.001, BURLINGTON.lat + 0.002],
          [BURLINGTON.lng + 0.001, BURLINGTON.lat + 0.001],
        ],
      ],
    };
    const outcome = maskFeatureFor({ waterBodyId: 'w1', polygon: withIsland });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // A lake full of white holes "reads as damage rather than cartography" — so the mask must have
    // no interior rings at all, and the island is simply revealed along with the water.
    const rings =
      outcome.feature.geometry.type === 'Polygon'
        ? [outcome.feature.geometry.coordinates]
        : outcome.feature.geometry.coordinates;
    for (const polygonRings of rings) expect(polygonRings.length).toBe(1);
  });

  it('fails closed on missing geometry rather than revealing everything', () => {
    const outcome = maskFeatureFor({ waterBodyId: 'w1' } as unknown as CorpusMaskRow);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('no-geometry');
  });

  // ## The water feature — the measurement's geometry, and why it is a second one
  //
  // These four pin the property the archive's every per-body number rests on: a zonal statistic
  // counts the LAKE, and the reveal counts the lake plus the way in. They were the same shape until
  // 2026-08-25, which put a 60 m ring of shore inside `snowIcePct`, `waterPct` and `vhDb`.

  it('keeps the water polygon unbuffered — a statistic counts the lake, not its shoreline', () => {
    const polygon = squareAt(BURLINGTON.lat, BURLINGTON.lng);
    const outcome = maskFeatureFor({ waterBodyId: 'w1', polygon });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // Identical to the corpus geometry, and strictly inside the reveal that was baked beside it.
    expect(outcome.waterFeature.geometry).toEqual(polygon);
    const water = bboxOf(outcome.waterFeature.geometry);
    const reveal = bboxOf(outcome.feature.geometry);
    expect(water.minLat).toBeGreaterThan(reveal.minLat);
    expect(water.maxLat).toBeLessThan(reveal.maxLat);
    expect(water.minLng).toBeGreaterThan(reveal.minLng);
    expect(water.maxLng).toBeLessThan(reveal.maxLng);
  });

  it('keeps islands as holes in the water polygon, though the reveal fills them in', () => {
    const withIsland: Polygon = {
      type: 'Polygon',
      coordinates: [
        squareAt(BURLINGTON.lat, BURLINGTON.lng, 0.004).coordinates[0] as number[][],
        [
          [BURLINGTON.lng + 0.001, BURLINGTON.lat + 0.001],
          [BURLINGTON.lng + 0.002, BURLINGTON.lat + 0.001],
          [BURLINGTON.lng + 0.002, BURLINGTON.lat + 0.002],
          [BURLINGTON.lng + 0.001, BURLINGTON.lat + 0.002],
          [BURLINGTON.lng + 0.001, BURLINGTON.lat + 0.001],
        ],
      ],
    };
    const outcome = maskFeatureFor({ waterBodyId: 'w1', polygon: withIsland });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The picture shows the island (one ring, the hole dropped); the measurement excludes it (two).
    // An island counted as lake is permanent land inside a freeze-up series, on every island lake in
    // the corpus — and Winnipesaukee alone has over two hundred.
    const revealRings =
      outcome.feature.geometry.type === 'Polygon'
        ? outcome.feature.geometry.coordinates
        : outcome.feature.geometry.coordinates[0];
    expect(revealRings?.length).toBe(1);
    expect((outcome.waterFeature.geometry as Polygon).coordinates.length).toBe(2);
  });

  it('never lets access geometry into the water polygon', () => {
    // The parking lot and the walk in are reasons to SHOW ground; they are not lake. A trail corridor
    // inside a zone measures the woods either side of it and calls the result a lake's ice fraction.
    const polygon = squareAt(BURLINGTON.lat, BURLINGTON.lng);
    const outcome = maskFeatureFor({
      waterBodyId: 'w1',
      polygon,
      parkingCoords: [{ lat: BURLINGTON.lat + 0.02, lng: BURLINGTON.lng }],
      approachPaths: [
        [
          { lat: BURLINGTON.lat + 0.02, lng: BURLINGTON.lng },
          { lat: BURLINGTON.lat + 0.002, lng: BURLINGTON.lng },
        ],
      ],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.waterFeature.geometry).toEqual(polygon);
    // The reveal reached the lot 2 km north; the water polygon did not move at all.
    expect(bboxOf(outcome.feature.geometry).maxLat).toBeGreaterThan(
      bboxOf(outcome.waterFeature.geometry).maxLat,
    );
  });

  it('gives both features the same properties, so the two artifacts join on id', () => {
    const outcome = maskFeatureFor({
      waterBodyId: 'w1',
      name: 'Lake Iroquois',
      polygon: squareAt(BURLINGTON.lat, BURLINGTON.lng),
      elevationM: 96,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.waterFeature.properties).toEqual(outcome.feature.properties);
    expect(outcome.waterFeature.properties.waterBodyId).toBe('w1');
  });

  it('uses the Sentinel buffer, not the aerial one', () => {
    // The two tiers differ ~3× (60 m vs 20 m). A 10 m buffer is one Sentinel pixel, so picking the
    // aerial constant here would render as no reveal margin at all.
    expect(SENTINEL_MASK_METERS.solid).toBe(60);
    const polygon = squareAt(BURLINGTON.lat, BURLINGTON.lng);
    const outcome = maskFeatureFor({ waterBodyId: 'w1', polygon });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // ~60 m at 44°N is ~0.00054° of latitude; assert it grew by clearly more than the 20 m aerial
    // buffer would have (~0.00018°) and less than an order of magnitude beyond.
    const grew = bboxOf(polygon).minLat - bboxOf(outcome.feature.geometry).minLat;
    expect(grew).toBeGreaterThan(0.0004);
    expect(grew).toBeLessThan(0.001);
  });
});

describe('tally', () => {
  it('counts a mask as masked', () => {
    const tally = recordOutcome(
      emptyTally(),
      maskFeatureFor({ waterBodyId: 'w1', polygon: squareAt(BURLINGTON.lat, BURLINGTON.lng) }),
    );
    expect(tally).toMatchObject({ masked: 1, omitted: 0 });
  });

  it('records an omission by reason, so a silent skip has a number attached', () => {
    const tally = recordOutcome(emptyTally(), {
      ok: false,
      waterBodyId: 'w9',
      name: 'Broken Pond',
      reason: 'union-failed',
    });
    expect(tally.omitted).toBe(1);
    expect(tally.byReason['union-failed']).toBe(1);
    expect(tally.omissions[0]).toEqual({
      waterBodyId: 'w9',
      name: 'Broken Pond',
      reason: 'union-failed',
    });
  });

  it('caps the omission list so a systemic failure cannot print the corpus into a run log', () => {
    let tally = emptyTally();
    for (let i = 0; i < MAX_REPORTED_OMISSIONS + 25; i++) {
      tally = recordOutcome(tally, {
        ok: false,
        waterBodyId: `w${i}`,
        reason: 'union-failed',
      });
    }
    // The cap bounds the *list*, never the count — the whole point is that the number stays honest.
    expect(tally.omissions).toHaveLength(MAX_REPORTED_OMISSIONS);
    expect(tally.omitted).toBe(MAX_REPORTED_OMISSIONS + 25);
  });
});

/** Bounding box of a geometry, for assertions about which way a buffer moved an edge. */
function bboxOf(shape: Polygon | MultiPolygon) {
  const polygons = shape.type === 'Polygon' ? [shape.coordinates] : shape.coordinates;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const rings of polygons) {
    for (const ring of rings) {
      for (const [lng, lat] of ring as [number, number][]) {
        minLng = Math.min(minLng, lng);
        minLat = Math.min(minLat, lat);
        maxLng = Math.max(maxLng, lng);
        maxLat = Math.max(maxLat, lat);
      }
    }
  }
  return { minLng, minLat, maxLng, maxLat };
}
