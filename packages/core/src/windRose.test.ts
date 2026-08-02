import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  exposureIndex,
  isPlausibleWindRose,
  mostExposedSector,
  normalizeRose,
  WIND_ROSE_MONTHS,
  WIND_ROSE_SECTORS,
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
