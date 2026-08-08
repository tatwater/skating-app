import { describe, expect, it } from 'vitest';
import {
  DEPTH_PROXIMITY_AREA_RATIO,
  DEPTH_PROXIMITY_METERS,
  type DepthCandidate,
  matchDepthSource,
} from './depthMatch';

/**
 * The depth join's fallback (N6a, added after the first real run).
 *
 * The load-bearing property is **not** "proximity finds more lakes" — it is that proximity is held
 * to a *stricter* standard than containment. A fallback looser than the primary path would be the
 * exact failure the zero-buffer rule was written to prevent: a point just off one shoreline
 * claiming the body across the road.
 */

const AREA_LIMIT = 4;

/** A square body of roughly `side` degrees, centred on (lat, lng). */
function square<T>(
  ref: T,
  lat: number,
  lng: number,
  side: number,
  surfaceAreaSqM: number,
  name?: string,
): DepthCandidate<T> {
  const h = side / 2;
  return {
    ref,
    surfaceAreaSqM,
    name,
    polygon: {
      type: 'Polygon',
      coordinates: [
        [
          [lng - h, lat - h],
          [lng + h, lat - h],
          [lng + h, lat + h],
          [lng - h, lat + h],
          [lng - h, lat - h],
        ],
      ],
    },
  };
}

describe('matchDepthSource — containment', () => {
  it('matches a point inside the body and reports zero distance', () => {
    const body = square('a', 44, -73, 0.01, 100_000);
    const out = matchDepthSource({ point: { lat: 44, lng: -73 }, areaSqM: 100_000 }, [body], {
      areaRatioLimit: AREA_LIMIT,
    });
    expect(out).toMatchObject({ matched: 'a', method: 'contained', distanceM: 0 });
  });

  it('rejects an inside match whose area disagrees past the gate, without falling through', () => {
    // The pond next door: the point is genuinely inside, so looking further afield can only find a
    // worse answer. This must be a rejection, never a proximity retry.
    const body = square('a', 44, -73, 0.01, 100_000);
    const out = matchDepthSource({ point: { lat: 44, lng: -73 }, areaSqM: 1_000_000 }, [body], {
      areaRatioLimit: AREA_LIMIT,
    });
    expect(out).toMatchObject({ matched: null, reason: 'area_mismatch' });
  });

  it('matches on containment even with no area on either side', () => {
    const body = square('a', 44, -73, 0.01, 0);
    const out = matchDepthSource({ point: { lat: 44, lng: -73 } }, [body], {
      areaRatioLimit: AREA_LIMIT,
    });
    expect(out).toMatchObject({ matched: 'a', method: 'contained' });
  });
});

describe('matchDepthSource — proximity fallback', () => {
  it('recovers the Sugar Hill case: same size, just outside our polygon', () => {
    // 23 ha body, source 22 ha, point ~260 m away. This exact shape was 40% of the misses.
    const body = square('sugarhill', 44.0, -73.0, 0.004, 230_000);
    const out = matchDepthSource(
      { point: { lat: 44.0026, lng: -73.0 }, areaSqM: 220_000 },
      [body],
      { areaRatioLimit: AREA_LIMIT },
    );
    expect(out).toMatchObject({
      matched: 'sugarhill',
      method: 'proximity',
      corroboration: 'area',
    });
  });

  it('refuses a nearby body whose area disagrees — the road-crossing case', () => {
    // Within range, but 3× different in area and no name. That passes the CONTAINMENT gate (4×)
    // and must still be refused here, which is the whole point of the tighter standard.
    const body = square('other', 44.0, -73.0, 0.004, 600_000);
    const out = matchDepthSource(
      { point: { lat: 44.0026, lng: -73.0 }, areaSqM: 200_000 },
      [body],
      { areaRatioLimit: AREA_LIMIT },
    );
    expect(out).toMatchObject({ matched: null, reason: 'proximity_unconfirmed' });
  });

  it('lets an agreeing name earn the looser containment gate, but no more', () => {
    const body = square('morey', 44.0, -73.0, 0.004, 600_000, 'Lake Morey');
    const withName = matchDepthSource(
      { point: { lat: 44.0026, lng: -73.0 }, areaSqM: 200_000, name: 'Morey Lake' },
      [body],
      { areaRatioLimit: AREA_LIMIT },
    );
    expect(withName).toMatchObject({ matched: 'morey', corroboration: 'name' });

    // Same name, but 10× area — past the containment gate too, so it is still refused.
    const tooBig = square('morey', 44.0, -73.0, 0.004, 2_000_000, 'Lake Morey');
    expect(
      matchDepthSource(
        { point: { lat: 44.0026, lng: -73.0 }, areaSqM: 200_000, name: 'Morey Lake' },
        [tooBig],
        { areaRatioLimit: AREA_LIMIT },
      ),
    ).toMatchObject({ matched: null, reason: 'proximity_unconfirmed' });
  });

  it('does not treat two absent names as agreement', () => {
    const body = square('x', 44.0, -73.0, 0.004, 600_000);
    expect(
      matchDepthSource({ point: { lat: 44.0026, lng: -73.0 }, areaSqM: 200_000 }, [body], {
        areaRatioLimit: AREA_LIMIT,
      }),
    ).toMatchObject({ reason: 'proximity_unconfirmed' });
  });

  it('reports no_body_nearby when the corpus genuinely has nothing here', () => {
    // 4 of 10 sampled misses were this: HydroLAKES and LAGOS simply do not include the lake.
    const far = square('far', 45.0, -73.0, 0.004, 230_000);
    expect(
      matchDepthSource({ point: { lat: 44.0, lng: -73.0 }, areaSqM: 220_000 }, [far], {
        areaRatioLimit: AREA_LIMIT,
      }),
    ).toMatchObject({ matched: null, reason: 'no_body_nearby' });
  });

  it('distinguishes "nothing here" from "something we declined to trust"', () => {
    // Only the second is worth a human's attention, so they must not collapse into one counter.
    const near = square('near', 44.0, -73.0, 0.004, 900_000);
    const nearby = matchDepthSource(
      { point: { lat: 44.0026, lng: -73.0 }, areaSqM: 200_000 },
      [near],
      { areaRatioLimit: AREA_LIMIT },
    );
    const nothing = matchDepthSource(
      { point: { lat: 44.0, lng: -73.0 }, areaSqM: 200_000 },
      [square('far', 46.0, -73.0, 0.004, 200_000)],
      { areaRatioLimit: AREA_LIMIT },
    );
    expect(nearby).toMatchObject({ reason: 'proximity_unconfirmed' });
    expect(nothing).toMatchObject({ reason: 'no_body_nearby' });
  });
});

describe('the fallback is never looser than the primary', () => {
  it('holds for every area ratio between the two thresholds', () => {
    // The invariant, stated as a property: anything proximity accepts on area alone would also have
    // passed containment's gate. If someone ever raises DEPTH_PROXIMITY_AREA_RATIO above the
    // containment limit, this fails.
    expect(DEPTH_PROXIMITY_AREA_RATIO).toBeLessThanOrEqual(AREA_LIMIT);

    for (const ratio of [1.3, 1.6, 2, 3, 3.9]) {
      const body = square('b', 44.0, -73.0, 0.004, 200_000 * ratio);
      const out = matchDepthSource(
        { point: { lat: 44.0026, lng: -73.0 }, areaSqM: 200_000 },
        [body],
        { areaRatioLimit: AREA_LIMIT },
      );
      // Between the two thresholds and with no name, proximity must refuse — even though
      // containment would have accepted the same pair.
      expect(out.matched).toBeNull();
    }
  });

  it('never reaches past its own radius', () => {
    // ~0.02° ≈ 2.2 km, comfortably outside the 500 m buffer.
    const body = square('b', 44.02, -73.0, 0.004, 200_000);
    expect(
      matchDepthSource({ point: { lat: 44.0, lng: -73.0 }, areaSqM: 200_000 }, [body], {
        areaRatioLimit: AREA_LIMIT,
      }),
    ).toMatchObject({ reason: 'no_body_nearby' });
    expect(DEPTH_PROXIMITY_METERS).toBeLessThan(1000);
  });
});
