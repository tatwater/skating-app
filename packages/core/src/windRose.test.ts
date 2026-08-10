import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MIN_FETCH_CLAUSE_M } from './lakeCaption';
import {
  exposureIndex,
  isPlausibleStrongWindHours,
  isPlausibleWindRose,
  mostExposedSector,
  normalizeRose,
  STRONG_WIND_MIN_MPS,
  WIND_ARCHIVE_MIN_FETCH_M,
  WIND_ROSE_MONTHS,
  WIND_ROSE_SECTORS,
  windHoleSectors,
} from './windRose';

/** Willoughby's real winter rose counts, NREL WTK 2 km, Dec–Mar 2012. Bimodal along the trough. */
const WILLOUGHBY_COUNTS = [110, 58, 23, 20, 20, 102, 563, 468, 87, 58, 93, 107, 163, 264, 540, 229];
/** Willoughby's fetch, metres by sector — longest to the SSE (index 7). */
const WILLOUGHBY_FETCH = [
  1900, 500, 300, 200, 200, 200, 400, 4500, 1900, 1300, 1100, 1000, 1200, 1100, 1300, 3000,
];

const flat = (n = 1) => Array.from({ length: WIND_ROSE_SECTORS }, () => n);

describe('WIND_ROSE_MONTHS', () => {
  it('is the skating season, not the year', () => {
    // An annual rose averages in summer patterns irrelevant to ice, and the two differ materially
    // here. This is also the thing the WIND Toolkit gives us that the Global Wind Atlas cannot.
    expect([...WIND_ROSE_MONTHS]).toEqual([12, 1, 2, 3]);
  });
});

describe('normalizeRose', () => {
  it('turns hour counts into frequencies summing to 1', () => {
    const rose = normalizeRose(WILLOUGHBY_COUNTS) as number[];
    expect(rose.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    // The measured shape: SE and SSE dominant, E/NE quadrant blocked by the ridges.
    expect(rose[6]).toBeGreaterThan(0.15);
    expect(rose[2]).toBeLessThan(0.02);
  });

  it('refuses an empty or all-zero sample rather than returning zeros', () => {
    // A rose of zeros multiplies through exposureIndex to a confident "no exposure anywhere".
    expect(normalizeRose(flat(0))).toBeNull();
    expect(normalizeRose([])).toBeNull();
  });

  it('refuses a wrong-length or negative sample', () => {
    expect(normalizeRose([1, 2, 3])).toBeNull();
    expect(normalizeRose(flat(1).map((v, i) => (i === 3 ? -1 : v)))).toBeNull();
    expect(normalizeRose(flat(1).map((v, i) => (i === 3 ? Number.NaN : v)))).toBeNull();
  });

  it('always sums to 1 for any positive sample', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 1e4, noNaN: true }), {
          minLength: WIND_ROSE_SECTORS,
          maxLength: WIND_ROSE_SECTORS,
        }),
        (counts) => {
          const rose = normalizeRose(counts);
          if (rose === null) return; // all-zero draw
          expect(rose.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8);
        },
      ),
    );
  });
});

describe('isPlausibleWindRose', () => {
  it('accepts a normalized rose and rejects raw counts', () => {
    // The sum check is the load-bearing one: raw counts are still sixteen plausible numbers, and
    // would scale every exposure index by the hours sampled — invisible in a ranking, fatal to a
    // threshold.
    expect(isPlausibleWindRose(normalizeRose(WILLOUGHBY_COUNTS))).toBe(true);
    expect(isPlausibleWindRose(WILLOUGHBY_COUNTS)).toBe(false);
  });

  it('rejects the wrong shape entirely', () => {
    for (const bad of [undefined, null, 'rose', [], flat(1), [...flat(0.0625), 0.5]]) {
      expect(isPlausibleWindRose(bad)).toBe(false);
    }
  });
});

describe('exposureIndex', () => {
  it('is frequency times fetch, per sector', () => {
    const rose = normalizeRose(flat(1)) as number[]; // uniform: 1/16 each
    const index = exposureIndex(rose, flat(1600)) as number[];
    expect(index).toHaveLength(WIND_ROSE_SECTORS);
    for (const v of index) expect(v).toBeCloseTo(100, 6);
  });

  it('returns null without BOTH inputs — never falling back to fetch alone', () => {
    // The fallback IS the claim this module exists to stop making, and a silent degradation to it
    // would be invisible in the rendered sentence.
    expect(exposureIndex(undefined, WILLOUGHBY_FETCH)).toBeNull();
    expect(exposureIndex(normalizeRose(WILLOUGHBY_COUNTS), undefined)).toBeNull();
    expect(exposureIndex(WILLOUGHBY_COUNTS, WILLOUGHBY_FETCH)).toBeNull(); // un-normalized
    expect(exposureIndex(normalizeRose(WILLOUGHBY_COUNTS), [1, 2, 3])).toBeNull();
  });
});

describe('mostExposedSector', () => {
  it('agrees with fetch alone on Willoughby, because the trough channels wind along its own axis', () => {
    // The founder expected the rose to overturn the fetch-only answer here. It does not, and the
    // reason is the interesting part: Willoughby's terrain funnels wind ALONG the NNW-SSE valley,
    // which is also where the water runs. Wind and fetch align, which is physically why long
    // narrow lakes get rough.
    const exposed = mostExposedSector(normalizeRose(WILLOUGHBY_COUNTS), WILLOUGHBY_FETCH);
    expect(exposed?.sector).toBe(7); // SSE
    expect(exposed?.fetchM).toBe(4500);
    expect(exposed?.frequency).toBeGreaterThan(0.15);
  });

  it('OVERTURNS fetch alone when the long axis runs across the prevailing wind', () => {
    // The case worth being right about. Longest fetch due east, but winter wind almost never comes
    // from the east — so the exposed shore is the north one.
    const fetchProfileM = flat(500);
    fetchProfileM[4] = 9000; // a long east-west reach
    fetchProfileM[0] = 3000; // a shorter north-south one
    const counts = flat(1);
    counts[4] = 1; // wind essentially never from the east
    counts[0] = 400; // and usually from the north
    const rose = normalizeRose(counts) as number[];

    expect(mostExposedSector(rose, fetchProfileM)?.sector).toBe(0);
    // …whereas fetch alone would have said east.
    expect(fetchProfileM.indexOf(Math.max(...fetchProfileM))).toBe(4);
  });

  it('returns null when either input is missing', () => {
    expect(mostExposedSector(undefined, WILLOUGHBY_FETCH)).toBeNull();
    expect(mostExposedSector(normalizeRose(WILLOUGHBY_COUNTS), undefined)).toBeNull();
  });

  it('returns null when there is no water in any direction', () => {
    expect(mostExposedSector(normalizeRose(WILLOUGHBY_COUNTS), flat(0))).toBeNull();
  });

  it('breaks ties stably, so a symmetric pond does not reword between runs', () => {
    const rose = normalizeRose(flat(1)) as number[];
    const first = mostExposedSector(rose, flat(1200));
    expect(first?.sector).toBe(0);
    expect(mostExposedSector(rose, flat(1200))?.sector).toBe(first?.sector);
  });

  it('always names a sector whose exposure is maximal', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0.01, max: 100, noNaN: true }), {
          minLength: WIND_ROSE_SECTORS,
          maxLength: WIND_ROSE_SECTORS,
        }),
        fc.array(fc.double({ min: 0, max: 20000, noNaN: true }), {
          minLength: WIND_ROSE_SECTORS,
          maxLength: WIND_ROSE_SECTORS,
        }),
        (counts, fetchProfileM) => {
          const rose = normalizeRose(counts);
          if (!rose) return;
          const exposed = mostExposedSector(rose, fetchProfileM);
          const index = exposureIndex(rose, fetchProfileM);
          if (!exposed || !index) return;
          expect(index[exposed.sector]).toBeCloseTo(Math.max(...index), 6);
        },
      ),
    );
  });
});

describe('sustained wind (N7-3)', () => {
  /** Five winters of Dec–Mar, which is what `WTK_YEARS` fetches. */
  const FIVE_WINTERS = 5 * 24 * (31 + 31 + 28 + 31);

  const sixteen = (over: Record<number, number> = {}) =>
    Array.from({ length: 16 }, (_, i) => over[i] ?? 0);

  it('20 mph is the threshold, at the height WTK reports', () => {
    // 20 mph is 8.9408 m/s; the constant is rounded to 8.94, which is 0.8 mm/s of daylight and
    // deliberate — this is a tunable magnitude, not a physical boundary, and a threshold written to
    // four decimal places invites somebody to think the fourth one means something.
    expect(STRONG_WIND_MIN_MPS).toBeCloseTo(20 * 0.44704, 2);
    // `windspeed_10m` is at 10 m, which is standard anemometer height, so this compares directly
    // with a reported wind speed and needs no conversion fudge.
    expect(STRONG_WIND_MIN_MPS).toBe(8.94);
  });

  it('validates counts against the sample rather than against a sum of one', () => {
    // The opposite check to a rose's. These are absolute hours, so the failure to catch is a sector
    // claiming more strong hours than the record contained.
    expect(
      isPlausibleStrongWindHours({
        strongWindHours: sixteen({ 3: 400, 4: 250 }),
        sampledWindHours: FIVE_WINTERS,
      }),
    ).toBe(true);
    expect(
      isPlausibleStrongWindHours({
        strongWindHours: sixteen({ 3: FIVE_WINTERS + 1 }),
        sampledWindHours: FIVE_WINTERS,
      }),
    ).toBe(false);
  });

  it('rejects the shapes a half-written row takes', () => {
    expect(isPlausibleStrongWindHours({})).toBe(false);
    expect(isPlausibleStrongWindHours({ strongWindHours: [1, 2, 3] })).toBe(false);
    expect(isPlausibleStrongWindHours({ strongWindHours: sixteen(), sampledWindHours: 0 })).toBe(
      false,
    );
    expect(
      isPlausibleStrongWindHours({ strongWindHours: sixteen({ 0: -1 }), sampledWindHours: 100 }),
    ).toBe(false);
  });

  it('reports per-winter rates, worst first', () => {
    const wind = {
      strongWindHours: sixteen({ 3: 500, 4: 250, 12: 50 }),
      sampledWindHours: FIVE_WINTERS,
      strongWindMinMps: STRONG_WIND_MIN_MPS,
    };
    const sectors = windHoleSectors(wind);
    expect(sectors.map((s) => s.sector)).toEqual([3, 4, 12]);
    // 500 hours over five winters is 100 a winter.
    expect(sectors[0]?.hoursPerWinter).toBeCloseTo(100, 6);
    expect(sectors[0]?.share).toBeCloseTo(500 / FIVE_WINTERS, 6);
  });

  it('applies the duration threshold at READ time, with no recompute', () => {
    // The whole reason the duration lives here and the speed lives in the stored counts: this is
    // the strongest form of configurable available.
    const wind = {
      strongWindHours: sixteen({ 3: 500, 4: 10 }),
      sampledWindHours: FIVE_WINTERS,
    };
    expect(windHoleSectors(wind, 1).map((s) => s.sector)).toEqual([3, 4]);
    expect(windHoleSectors(wind, 50).map((s) => s.sector)).toEqual([3]);
    expect(windHoleSectors(wind, 500)).toEqual([]);
  });

  it('says nothing at all for a body with no sustained-wind data', () => {
    // `[]` rather than `null`: "no sectors qualify" and "we never measured" call for the same
    // action, and a caller forced to distinguish them would handle a null it has no use for.
    expect(windHoleSectors({})).toEqual([]);
    expect(windHoleSectors({ strongWindHours: sixteen({ 0: 5 }) })).toEqual([]);
  });

  it('breaks ties toward the lower sector, stably', () => {
    const sectors = windHoleSectors({
      strongWindHours: sixteen({ 9: 300, 2: 300 }),
      sampledWindHours: FIVE_WINTERS,
    });
    expect(sectors.map((s) => s.sector)).toEqual([2, 9]);
  });
});

describe('WIND_ARCHIVE_MIN_FETCH_M', () => {
  // The whole point of the constant is that it is NOT the caption's bar. For one campaign the two
  // were the same number, and `MIN_FETCH_CLAUSE_M` — chosen for pressure ridges — silently decided
  // which bodies got a rose fetched at all, which under-served the wind-hole lane by construction.
  // If someone ever collapses them back into one constant, this is what says so.
  it('is a separate, lower bar than the caption clause', () => {
    expect(WIND_ARCHIVE_MIN_FETCH_M).toBe(250);
    expect(MIN_FETCH_CLAUSE_M).toBe(1000);
    expect(WIND_ARCHIVE_MIN_FETCH_M).toBeLessThan(MIN_FETCH_CLAUSE_M);
  });

  it('leaves a band that carries sustained wind and no exposure clause', () => {
    // A body between the two bars is the case the split exists for: it gets strong-wind hours
    // (a speed question, no fetch minimum) and no pressure-ridge sentence (a fetch question).
    const between = 500;
    expect(between).toBeGreaterThanOrEqual(WIND_ARCHIVE_MIN_FETCH_M);
    expect(between).toBeLessThan(MIN_FETCH_CLAUSE_M);
  });
});
