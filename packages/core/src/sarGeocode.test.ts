import { describe, expect, it } from 'vitest';
import {
  geocodeOffsetMeters,
  granuleGeocodeHeight,
  maskOffsetMeters,
  rangeDisplacementPerMetre,
  shiftCoordinate,
} from './sarGeocode';

describe('rangeDisplacementPerMetre', () => {
  it('is ~1.4 m per metre at IW incidence, which is the whole problem', () => {
    // 35° is mid-swath for IW. 100 m of height error becoming ~140 m of ground error is why this is
    // visible at 28 m pixels rather than being a rounding concern.
    expect(rangeDisplacementPerMetre(35)).toBeCloseTo(1.428, 2);
  });

  it('grows steeply as the look gets shallower', () => {
    expect(rangeDisplacementPerMetre(30)).toBeGreaterThan(rangeDisplacementPerMetre(45));
  });
});

describe('geocodeOffsetMeters — the sign is the part to get right', () => {
  // Ascending tracks roughly north (heading ~350°), descending roughly south (~190°). Right-looking
  // in both cases, so range points east on ascending and west on descending.
  const ASCENDING = 350;
  const DESCENDING = 190;

  it('⚠ pushes opposite ways for the two orbit directions', () => {
    // This is the observed symptom, reproduced: a lake above the reference height is drawn displaced
    // toward the sensor, and the sensor is on opposite sides. Correcting must therefore push opposite
    // ways too — which is exactly why one sign error would look plausible and double the error.
    const up = { heightM: 300, referenceHeightM: 0, incidenceDeg: 35 };
    const asc = geocodeOffsetMeters({ ...up, headingDeg: ASCENDING });
    const desc = geocodeOffsetMeters({ ...up, headingDeg: DESCENDING });

    expect(asc.eastM).toBeGreaterThan(0);
    expect(desc.eastM).toBeLessThan(0);
    expect(Math.abs(asc.eastM)).toBeCloseTo(Math.abs(desc.eastM), 0);
  });

  it('scales with the height error, at the expected magnitude', () => {
    const offset = geocodeOffsetMeters({
      heightM: 220,
      referenceHeightM: 0,
      incidenceDeg: 35,
      headingDeg: ASCENDING,
    });
    // 220 m at 35° is ~314 m of ground displacement — about eleven 28 m radar pixels, which is a
    // shift a person watching two islands will see immediately.
    expect(Math.hypot(offset.eastM, offset.northM)).toBeCloseTo(314, 0);
  });

  it('is zero when the surface sits at the reference height', () => {
    const offset = geocodeOffsetMeters({
      heightM: 150,
      referenceHeightM: 150,
      incidenceDeg: 35,
      headingDeg: ASCENDING,
    });
    expect(offset.eastM).toBeCloseTo(0, 6);
    expect(offset.northM).toBeCloseTo(0, 6);
  });

  it('reverses for a surface below the reference', () => {
    const above = geocodeOffsetMeters({
      heightM: 300,
      referenceHeightM: 100,
      incidenceDeg: 35,
      headingDeg: ASCENDING,
    });
    const below = geocodeOffsetMeters({
      heightM: -100,
      referenceHeightM: 100,
      incidenceDeg: 35,
      headingDeg: ASCENDING,
    });
    expect(Math.sign(above.eastM)).toBe(-Math.sign(below.eastM));
  });

  it('honours a left-looking sensor, so the assumption stays visible', () => {
    const args = { heightM: 300, referenceHeightM: 0, incidenceDeg: 35, headingDeg: ASCENDING };
    const right = geocodeOffsetMeters(args);
    const left = geocodeOffsetMeters({ ...args, lookRight: false });
    expect(Math.sign(right.eastM)).toBe(-Math.sign(left.eastM));
  });
});

describe('maskOffsetMeters — the direction that was actually measured', () => {
  // ## The Mascoma pair, 2026-08-25
  //
  // Two real passes 24 hours apart, scanned to find the offset at which the lake mask covers the
  // darkest pixels — i.e. where the water really is in the product. These are the scene parameters
  // as their annotations state them, and the expectations are what the scan measured.
  //
  // This is the regression test for a mistake that cannot be caught by inspection: the wrong
  // direction does not halve the correction, it doubles the error, and what comes out is still a
  // perfectly plausible backscatter figure.
  const MASCOMA_M = 224;
  const ASC = { referenceHeightM: 353.93, incidenceDeg: 38.688, headingDeg: 346.064 };
  const DESC = { referenceHeightM: 327.0, incidenceDeg: 38.6, headingDeg: 194.0 };

  function alongRange(
    offset: { eastM: number; northM: number },
    { headingDeg }: { headingDeg: number },
  ): number {
    const rad = ((headingDeg + 90) * Math.PI) / 180;
    return offset.eastM * Math.sin(rad) + offset.northM * Math.cos(rad);
  }

  it('points where the pixels are, which is opposite to the imagery correction', () => {
    const params = { ...ASC, heightM: MASCOMA_M };
    const mask = maskOffsetMeters(params);
    const imagery = geocodeOffsetMeters(params);
    expect(mask.eastM).toBeCloseTo(-imagery.eastM, 6);
    expect(mask.northM).toBeCloseTo(-imagery.northM, 6);
  });

  it('matches the ascending pass to under half a pixel', () => {
    // Measured +150 m; a 28 m pixel, so anything inside ~14 m is agreement.
    const along = alongRange(maskOffsetMeters({ ...ASC, heightM: MASCOMA_M }), ASC);
    expect(along).toBeGreaterThan(136);
    expect(along).toBeLessThan(164);
  });

  it('matches the descending pass, whose range points almost the other way', () => {
    // Range bearing 284° against the ascending pass's 76°. Both land at +150 m along their OWN
    // range direction, which is the sense in which the correction makes the two passes agree —
    // and is what stops the islands moving as a scrubber crosses between them.
    const along = alongRange(maskOffsetMeters({ ...DESC, heightM: MASCOMA_M }), DESC);
    expect(along).toBeGreaterThan(115);
    expect(along).toBeLessThan(165);
  });

  it('⚠ the un-negated offset misses by an order of magnitude more', () => {
    // 312 m and 279 m on the real pair — about eleven pixels, in the wrong direction.
    for (const scene of [ASC, DESC]) {
      const wrong = alongRange(geocodeOffsetMeters({ ...scene, heightM: MASCOMA_M }), scene);
      expect(Math.abs(wrong - 150)).toBeGreaterThan(250);
    }
  });
});

describe('shiftCoordinate', () => {
  it('moves north and east by the requested metres', () => {
    const moved = shiftCoordinate(43.65, -72.15, { eastM: 314, northM: 0 });
    expect(moved.lat).toBeCloseTo(43.65, 6);
    // ~314 m east at 43.65°N is ~0.0039° of longitude.
    expect(moved.lng - -72.15).toBeCloseTo(0.0039, 3);
  });

  it('accounts for longitude converging toward the pole', () => {
    const south = shiftCoordinate(10, 0, { eastM: 1000, northM: 0 }).lng;
    const north = shiftCoordinate(60, 0, { eastM: 1000, northM: 0 }).lng;
    expect(north).toBeGreaterThan(south);
  });

  it('is a no-op for a zero offset', () => {
    expect(shiftCoordinate(43.65, -72.15, { eastM: 0, northM: 0 })).toEqual({
      lat: 43.65,
      lng: -72.15,
    });
  });
});

describe('granuleGeocodeHeight', () => {
  it('takes the median, so one alpine tarn cannot drag the frame', () => {
    // A pass covers ~250 km. The mean of ninety valley lakes and one summit pond is wrong for all
    // ninety-one; the median is right for most of them.
    expect(granuleGeocodeHeight([100, 120, 140, 160, 1531])).toBe(140);
  });

  it('averages the middle pair on an even count', () => {
    expect(granuleGeocodeHeight([100, 200, 300, 400])).toBe(250);
  });

  it('ignores bodies with no known elevation', () => {
    expect(granuleGeocodeHeight([undefined, 200, undefined, 400])).toBe(300);
  });

  it('⚠ returns null rather than zero when nothing is known', () => {
    // Sea level is a real height and a wrong one. The caller must read this as "geocode as before",
    // because geocoding a mountain lake at 0 m is worse than the uncorrected product.
    expect(granuleGeocodeHeight([])).toBeNull();
    expect(granuleGeocodeHeight([undefined, undefined])).toBeNull();
  });
});
