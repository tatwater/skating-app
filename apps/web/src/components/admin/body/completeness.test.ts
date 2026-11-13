import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  COMPLETENESS_FIELDS,
  type CompletenessFacts,
  completenessItems,
  completenessOf,
  completenessSegments,
  missingSentence,
} from './completeness';

const RING = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 0],
];

/** Mascoma as the boards draw it: everything but bathymetry. */
const MASCOMA: CompletenessFacts = {
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
};

describe('the ten', () => {
  it('are the founder’s, in the founder’s order', () => {
    expect(COMPLETENESS_FIELDS).toEqual([
      'outline',
      'name',
      'access',
      'depth',
      'elevation',
      'wind',
      'putIns',
      'lots',
      'landmarks',
      'bathymetry',
    ]);
  });

  it('read Mascoma as 9 of 10, only its bathymetry missing', () => {
    expect(completenessOf(MASCOMA)).toEqual({
      have: 9,
      of: 10,
      missing: ['bathymetry'],
      unknown: [],
    });
  });

  it('follow core’s rules: a blank name, an open ring, either depth, an approach for access', () => {
    const c = completenessOf({
      ...MASCOMA,
      name: '  ',
      polygon: { type: 'Polygon', coordinates: [RING.slice(0, 3)] },
      maxDepthM: null,
      meanDepthM: 4,
      publicAccess: null,
      accessKind: 'walkIn',
      windRose: [],
      putIns: 0,
    });
    expect(c.missing).toEqual(['outline', 'name', 'wind', 'putIns', 'bathymetry']);
    expect(
      completenessOf({
        ...MASCOMA,
        polygon: { type: 'MultiPolygon', coordinates: [[RING]] },
      }).missing,
    ).toEqual(['bathymetry']);
  });

  it('call an unread count unknown — never missing, never counted', () => {
    const c = completenessOf({ ...MASCOMA, lots: null, landmarks: null, hasContours: null });
    expect(c).toEqual({
      have: 7,
      of: 10,
      missing: [],
      unknown: ['lots', 'landmarks', 'bathymetry'],
    });
    expect(missingSentence(c.missing)).toBeNull();
    expect(completenessSegments(c)).toEqual([
      ...Array<string>(7).fill('on'),
      'unknown',
      'unknown',
      'unknown',
    ]);
  });

  it('always account for all ten, whatever is read', () => {
    const count = fc.option(fc.nat({ max: 3 }), { nil: null });
    fc.assert(
      fc.property(count, count, count, fc.option(fc.boolean(), { nil: null }), (p, l, m, b) => {
        const facts = { ...MASCOMA, putIns: p, lots: l, landmarks: m, hasContours: b };
        const c = completenessOf(facts);
        expect(c.have + c.missing.length + c.unknown.length).toBe(10);
        for (const f of c.unknown) expect(c.missing).not.toContain(f);
        const segs = completenessSegments(c);
        expect(segs.filter((s) => s === 'on')).toHaveLength(c.have);
        expect(segs.filter((s) => s === 'unknown')).toHaveLength(c.unknown.length);
        expect(completenessItems(facts).map((i) => i.field)).toEqual(COMPLETENESS_FIELDS);
      }),
    );
  });
});

describe('the note', () => {
  it('names what’s missing as one sentence', () => {
    expect(missingSentence([])).toBeNull();
    expect(missingSentence(['bathymetry'])).toBe('Missing bathymetry');
    expect(missingSentence(['depth', 'putIns', 'bathymetry'])).toBe(
      'Missing depth, a put-in and bathymetry',
    );
  });
});
