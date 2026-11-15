import { describe, expect, it } from 'vitest';

import { neighborsOf, type TouchingFacts } from './touching';

/**
 * The bodies that touch this one come with the extras — each neighbor's name and simplified ring —
 * drawn as they are; none before the geometry is computed.
 */

const RING = [
  [-72.2, 43.6],
  [-72.19, 43.6],
  [-72.19, 43.61],
  [-72.2, 43.6],
];

const facts = (over: Partial<TouchingFacts> = {}): TouchingFacts => ({
  touchingBodyIds: ['k2'],
  touching: [{ waterBodyId: 'k2', name: 'Mascoma North Pond', ring: RING }],
  touchingCapped: false,
  geoComputedAt: 1,
  ...over,
});

describe('neighborsOf', () => {
  it('draws each neighbor from its own ring and name, read nowhere else', () => {
    expect(neighborsOf(facts())).toEqual([
      {
        id: 'k2',
        name: 'Mascoma North Pond',
        polygon: { type: 'Polygon', coordinates: [RING] },
      },
    ]);
  });

  it('names an unnamed neighbor as the console names any body', () => {
    expect(
      neighborsOf(facts({ touching: [{ waterBodyId: 'k3', name: '', ring: RING }] }))[0]?.name,
    ).not.toBe('');
  });

  it('draws none before the geometry is computed', () => {
    expect(
      neighborsOf(facts({ touching: null, touchingBodyIds: null, geoComputedAt: null })),
    ).toEqual([]);
  });
});
