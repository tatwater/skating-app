import { bodyCompleteness, COMPLETENESS_FIELDS } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { COMPLETENESS_WORDS, completenessSegments, missingSentence } from './completeness';

/**
 * The display of core's completeness: the strip and the note draw exactly what the rule (or the
 * stored row) says, in core's order. The rule itself is core's and tested there.
 */

const RING = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 0],
];

describe('the strip', () => {
  it('lights what core says a body has and darkens what it lacks, in core’s order', () => {
    const c = bodyCompleteness({
      polygon: { type: 'Polygon', coordinates: [RING] },
      name: 'Mascoma Lake',
      publicAccess: { verdict: 'accessible' },
      maxDepthM: 24,
      elevationM: 229,
      windRose: [0.1, 0.2],
      putIns: 2,
      lots: 1,
      landmarks: 7,
      hasContours: false,
    });
    expect(c).toEqual({ have: 9, of: 10, missing: ['bathymetry'] });
    expect(completenessSegments(c)).toEqual([...Array<string>(9).fill('on'), 'off']);
  });

  it('draws one segment per field, as many lit as the body has, for any stored answer', () => {
    fc.assert(
      fc.property(fc.subarray([...COMPLETENESS_FIELDS]), (missing) => {
        const c = { have: COMPLETENESS_FIELDS.length - missing.length, of: 10, missing };
        const segs = completenessSegments(c);
        expect(segs).toHaveLength(c.of);
        expect(segs.filter((s) => s === 'on')).toHaveLength(c.have);
        missing.forEach((f) => {
          expect(segs[COMPLETENESS_FIELDS.indexOf(f)]).toBe('off');
        });
      }),
    );
  });
});

describe('the note', () => {
  it('has words for every one of core’s fields', () => {
    expect(Object.keys(COMPLETENESS_WORDS).sort()).toEqual([...COMPLETENESS_FIELDS].sort());
  });

  it('names what’s missing as one sentence', () => {
    expect(missingSentence([])).toBeNull();
    expect(missingSentence(['bathymetry'])).toBe('Missing bathymetry');
    expect(missingSentence(['depth', 'bathymetry'])).toBe('Missing depth and bathymetry');
    expect(missingSentence(['depth', 'putIns', 'bathymetry'])).toBe(
      'Missing depth, a put-in and bathymetry',
    );
  });
});
