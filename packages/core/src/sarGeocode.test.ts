import { describe, expect, it } from 'vitest';
import {
  type GeolocationGridPoint,
  geocodeOffsetMeters,
  granuleGeocodeHeight,
  localGeocodeReference,
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
  // Two real passes 24 hours apart, scanned along each pass's own range direction to find where the
  // lake mask covers the darkest pixels — i.e. where the water really is in the product. Both landed
  // at **+150 m of EPSG:3857 easting**, which is the unit the scan worked in.
  //
  // ⚠ **Projected metres, not ground metres, and conflating them cost an hour.** Web Mercator
  // inflates distance by 1/cos(φ) — 1.382 at Mascoma's 43.65°N — while everything in this module is
  // in *ground* metres. The first reading of this measurement compared the two directly and
  // concluded the model agreed to within half a pixel. It does not; see the magnitude test below.
  // ⚠ The corpus value, not a remembered one. An earlier pass through this used 224 m from memory;
  // 3.9 m of height is 6 m of ground displacement, which is small but it is exactly the kind of
  // slop that gets attributed to the model instead of to the input.
  const MASCOMA_M = 227.93;
  const MEASURED_PROJECTED_M = 150;
  const INFLATION = 1 / Math.cos((43.65 * Math.PI) / 180);
  const MEASURED_GROUND_M = MEASURED_PROJECTED_M / INFLATION; // ~108.5 m
  const ASC = { referenceHeightM: 353.93, incidenceDeg: 38.688, headingDeg: 346.064 };
  const DESC = { referenceHeightM: 326.84, incidenceDeg: 38.648, headingDeg: 193.96 };

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

  it('⚠ gets the direction right on both orbit directions, which is the load-bearing part', () => {
    // The measurement is +150 projected in BOTH passes, along range bearings 76° and 284° — nearly
    // opposite in ground terms. That is the signature of a height-driven displacement rather than a
    // polygon error, and it means the sign is unambiguous even where the magnitude is not.
    for (const scene of [ASC, DESC]) {
      expect(alongRange(maskOffsetMeters({ ...scene, heightM: MASCOMA_M }), scene)).toBeGreaterThan(0);
      expect(alongRange(geocodeOffsetMeters({ ...scene, heightM: MASCOMA_M }), scene)).toBeLessThan(0);
    }
  });

  it('⚠ over-predicts when fed SCENE AVERAGES, which is what sent the calibration looking', () => {
    // ⚠ These two scenes' `referenceHeightM` are the *average over the whole grid* — 353.93 m and
    // 326.84 m. That is not the height either product geocoded Mascoma at, and it is why the offsets
    // come out 20–54 m long. The arithmetic is not at fault; the inputs are.
    //
    // Kept as a regression on the failure mode rather than on the numbers: if someone reintroduces a
    // scene average as the reference, this is the shape of what they will see.
    const errors = [ASC, DESC].map(
      (scene) =>
        alongRange(maskOffsetMeters({ ...scene, heightM: MASCOMA_M }), scene) - MEASURED_GROUND_M,
    );
    for (const error of errors) {
      expect(error).toBeGreaterThan(0); // over, never under
      expect(error).toBeLessThan(60);
    }
  });

  it('✅ lands within a pixel once the reference comes from the LOCAL grid', () => {
    // The same two passes, with the height and incidence `localGeocodeReference` interpolates at
    // Mascoma instead of the scene means. Measured on the real rasters afterwards: per-pass error
    // 150 m -> 30 m, and the disagreement BETWEEN the passes 291 m -> 39 m (1.4 px).
    // What `localGeocodeReference` actually returns at Mascoma for these two annotations.
    const LOCAL = {
      asc: { referenceHeightM: 327.1, incidenceDeg: 39.57, headingDeg: ASC.headingDeg },
      desc: { referenceHeightM: 330.1, incidenceDeg: 37.74, headingDeg: DESC.headingDeg },
    };
    for (const scene of [LOCAL.asc, LOCAL.desc]) {
      const along = alongRange(maskOffsetMeters({ ...scene, heightM: MASCOMA_M }), scene);
      // Inside one 28 m radar pixel of the ~108 m ground truth.
      expect(Math.abs(along - MEASURED_GROUND_M)).toBeLessThan(28);
    }
  });

  it('⚠ the un-negated offset is worse than doing nothing at all', () => {
    // This is why the direction gets two named functions. Applying the correction backwards moves a
    // lake from ~108 m out to ~270 m out — and the backscatter it then reports is still plausible.
    for (const scene of [ASC, DESC]) {
      const wrong = alongRange(geocodeOffsetMeters({ ...scene, heightM: MASCOMA_M }), scene);
      expect(Math.abs(wrong - MEASURED_GROUND_M)).toBeGreaterThan(2 * MEASURED_GROUND_M);
    }
  });
});

describe('localGeocodeReference — the fix that made the correction work at all', () => {
  // A grid over a valley: low in the middle, high on both shoulders. The scene mean is ~400 m and
  // describes none of it, which is the whole point.
  const GRID: GeolocationGridPoint[] = [
    { lat: 44.0, lng: -72.4, heightM: 900, incidenceDeg: 31 },
    { lat: 44.0, lng: -72.2, heightM: 900, incidenceDeg: 33 },
    { lat: 43.8, lng: -72.4, heightM: 100, incidenceDeg: 39 },
    { lat: 43.8, lng: -72.2, heightM: 100, incidenceDeg: 41 },
    { lat: 43.6, lng: -72.4, heightM: 900, incidenceDeg: 44 },
    { lat: 43.6, lng: -72.2, heightM: 900, incidenceDeg: 45 },
  ];

  it('reads the terrain the lake actually sits in, not the average of the pass', () => {
    const valley = localGeocodeReference(GRID, 43.8, -72.3, 2);
    expect(valley).not.toBeNull();
    // The two nearest points are both the 100 m valley floor.
    expect(valley?.referenceHeightM).toBeCloseTo(100, 0);

    const sceneMean = GRID.reduce((sum, p) => sum + p.heightM, 0) / GRID.length;
    expect(sceneMean).toBeCloseTo(633, 0);
    // ⚠ 533 m of difference, which at IW incidence is ~660 m of ground displacement — twenty-three
    // pixels of "correction" applied in the wrong direction. Measured on real passes, the scene
    // average was worse than not correcting at all: 325.6 m RMS against 96.5 m.
    expect(Math.abs(sceneMean - (valley?.referenceHeightM ?? 0))).toBeGreaterThan(500);
  });

  it('carries incidence with it, because that varies across the swath too', () => {
    const near = localGeocodeReference(GRID, 44.0, -72.4, 1);
    const far = localGeocodeReference(GRID, 43.6, -72.2, 1);
    expect(near?.incidenceDeg).toBeCloseTo(31, 5);
    expect(far?.incidenceDeg).toBeCloseTo(45, 5);
    // 1/tan changes by ~60% over that span — using mid-swath for both is a 60% magnitude error.
    const ratio = rangeDisplacementPerMetre(31) / rangeDisplacementPerMetre(45);
    expect(ratio).toBeGreaterThan(1.5);
  });

  it('returns a grid point exactly when the lake sits on one, rather than dividing by zero', () => {
    const on = localGeocodeReference(GRID, 43.8, -72.4);
    expect(on?.referenceHeightM).toBe(100);
    expect(on?.incidenceDeg).toBe(39);
  });

  it('weights by inverse square, so the near point dominates a far one', () => {
    // Just inside the valley, but nearer the 100 m corner than the 900 m one.
    const blended = localGeocodeReference(GRID, 43.79, -72.39, 6);
    expect(blended?.referenceHeightM).toBeLessThan(300);
    expect(blended?.referenceHeightM).toBeGreaterThan(100);
  });

  it('returns null on an empty grid rather than a confident zero', () => {
    // Sea level is a real height. A caller must read this as "do not correct", exactly as
    // `granuleGeocodeHeight` requires.
    expect(localGeocodeReference([], 44, -72)).toBeNull();
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
