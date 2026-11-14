import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bodyCompleteness, COMPLETENESS_FIELDS, type CompletenessInput } from './bodyCompleteness';

const RING = [
  [0, 0],
  [0, 1],
  [1, 1],
  [0, 0],
];

const FULL: CompletenessInput = {
  polygon: { type: 'Polygon', coordinates: [RING] },
  name: 'Mascoma Lake',
  publicAccess: { verdict: 'open' },
  maxDepthM: 18,
  elevationM: 228,
  windRose: [0.1, 0.2],
  putIns: 2,
  lots: 1,
  landmarks: 3,
  hasContours: true,
};

const BARE: CompletenessInput = {
  polygon: { type: 'Polygon', coordinates: [] },
  name: '  ',
  putIns: 0,
  lots: 0,
  landmarks: 0,
  hasContours: false,
};

describe('bodyCompleteness — the ten', () => {
  it('reads a body with everything as ten of ten', () => {
    expect(bodyCompleteness(FULL)).toEqual({ have: 10, of: 10, missing: [] });
  });

  it('lists what a bare body lacks, in the fixed order', () => {
    expect(bodyCompleteness(BARE)).toEqual({ have: 0, of: 10, missing: [...COMPLETENESS_FIELDS] });
  });

  it('takes access from a ruling or from an approach, depth from a max or a mean', () => {
    const partial = { ...BARE, accessKind: 'drive_up', meanDepthM: 4 };
    expect(bodyCompleteness(partial).missing).not.toContain('access');
    expect(bodyCompleteness(partial).missing).not.toContain('depth');
    expect(bodyCompleteness({ ...FULL, maxDepthM: Number.NaN }).missing).toEqual(['depth']);
  });

  it('reads a multipolygon’s outline, and an empty wind rose as no wind', () => {
    const multi = {
      ...FULL,
      polygon: { type: 'MultiPolygon', coordinates: [[RING]] },
      windRose: [],
    };
    expect(bodyCompleteness(multi).missing).toEqual(['wind']);
  });

  const input = fc.record({
    polygon: fc.constantFrom(FULL.polygon, BARE.polygon, null),
    name: fc.string(),
    publicAccess: fc.option(fc.constant({ verdict: 'open' }), { nil: undefined }),
    accessKind: fc.option(fc.constant('hike_in'), { nil: undefined }),
    maxDepthM: fc.option(fc.double(), { nil: undefined }),
    meanDepthM: fc.option(fc.double(), { nil: undefined }),
    elevationM: fc.option(fc.double(), { nil: undefined }),
    windRose: fc.option(fc.array(fc.double(), { maxLength: 4 }), { nil: undefined }),
    putIns: fc.nat(5),
    lots: fc.nat(5),
    landmarks: fc.nat(5),
    hasContours: fc.boolean(),
  });

  it('never more than ten; missing is exactly the complement, in the fixed order', () => {
    fc.assert(
      fc.property(input, (body) => {
        const { have, of, missing } = bodyCompleteness(body);
        expect(of).toBe(10);
        expect(have).toBeGreaterThanOrEqual(0);
        expect(have).toBeLessThanOrEqual(10);
        expect(have + missing.length).toBe(10);
        expect(new Set(missing).size).toBe(missing.length);
        // The fixed order: missing is a subsequence of the ten.
        const at = missing.map((f) => COMPLETENESS_FIELDS.indexOf(f));
        expect(at).toEqual([...at].sort((a, b) => a - b));
        expect(at.every((i) => i >= 0)).toBe(true);
      }),
    );
  });
});
