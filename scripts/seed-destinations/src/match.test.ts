import { describe, expect, it } from 'vitest';
import {
  type CandidateBody,
  corroboration,
  DESTINATION_BOOST,
  type Destination,
  distanceKm,
  matchAll,
  matchDestination,
  normalizeName,
} from './match';

function body(over: Partial<CandidateBody> & { _id: string }): CandidateBody {
  return { states: ['VT'], ...over };
}

function destination(over: Partial<Destination> = {}): Destination {
  return { name: 'Lake Willoughby', state: 'VT', sources: ['community'], ...over };
}

describe('normalizeName', () => {
  it('ignores case, punctuation and the noise words a gazetteer varies', () => {
    expect(normalizeName('Lake Willoughby')).toBe('willoughby');
    expect(normalizeName('WILLOUGHBY, LAKE')).toBe('willoughby');
    expect(normalizeName('The Beaver Pond')).toBe('beaver');
  });

  it('keeps distinct names distinct', () => {
    expect(normalizeName('Mill Pond')).not.toBe(normalizeName('Beaver Pond'));
  });
});

describe('distanceKm', () => {
  it('is zero for a point against itself', () => {
    expect(distanceKm({ lat: 44, lng: -72 }, { lat: 44, lng: -72 })).toBeCloseTo(0);
  });

  it('measures a known separation', () => {
    // One degree of latitude is ~111 km.
    expect(distanceKm({ lat: 44, lng: -72 }, { lat: 45, lng: -72 })).toBeCloseTo(111, 0);
  });
});

describe('matchDestination', () => {
  it('matches a single same-named body in the right state', () => {
    const result = matchDestination(destination(), [
      body({ _id: 'a', name: 'Lake Willoughby' }),
      body({ _id: 'b', name: 'Caspian Lake' }),
    ]);
    expect(result.kind).toBe('matched');
    expect(result.kind === 'matched' && result.body._id).toBe('a');
  });

  it('ignores a same-named body in the wrong state', () => {
    const result = matchDestination(destination(), [
      body({ _id: 'nh', name: 'Lake Willoughby', states: ['NH'] }),
    ]);
    expect(result.kind).toBe('unmatched');
  });

  /**
   * The failure this script exists to prevent. The Phase-2.5 seed put five curated boosts on
   * same-named lakes in the wrong towns, and nobody could see it until N2 built a screen.
   */
  it('reports ambiguity rather than guessing between same-named bodies', () => {
    const result = matchDestination(destination({ name: 'Mill Pond' }), [
      body({ _id: 'a', name: 'Mill Pond', surfaceAreaSqM: 900_000 }),
      body({ _id: 'b', name: 'Mill Pond', surfaceAreaSqM: 10_000 }),
    ]);
    expect(result.kind).toBe('ambiguous');
    expect(result.kind === 'ambiguous' && result.candidates).toHaveLength(2);
  });

  it('uses a supplied coordinate to disambiguate', () => {
    const result = matchDestination(
      destination({ name: 'Mill Pond', near: { lat: 44.0, lng: -72.0 } }),
      [
        body({ _id: 'near', name: 'Mill Pond', centroid: { lat: 44.05, lng: -72.02 } }),
        body({ _id: 'far', name: 'Mill Pond', centroid: { lat: 43.0, lng: -73.0 } }),
      ],
    );
    expect(result.kind).toBe('matched');
    expect(result.kind === 'matched' && result.body._id).toBe('near');
  });

  it('prefers the interior point over the shoreline centroid when measuring', () => {
    const result = matchDestination(destination({ near: { lat: 44.5325, lng: -73.3251 } }), [
      body({
        _id: 'a',
        name: 'Lake Willoughby',
        interiorPoint: { lat: 44.5325, lng: -73.3251 },
        centroid: { lat: 40.0, lng: -80.0 },
      }),
    ]);
    expect(result.kind === 'matched' && result.distanceKm).toBeCloseTo(0);
  });

  /** A coordinate that matches nothing nearby means the author meant a lake we do not have. */
  it('refuses a far-away name match rather than accepting a decoy', () => {
    const result = matchDestination(
      destination({ name: 'Mill Pond', near: { lat: 44.0, lng: -72.0 } }),
      [
        body({ _id: 'far1', name: 'Mill Pond', centroid: { lat: 41.0, lng: -75.0 } }),
        body({ _id: 'far2', name: 'Mill Pond', centroid: { lat: 41.2, lng: -75.2 } }),
      ],
    );
    expect(result.kind).toBe('ambiguous');
  });

  it('reports a destination with no match at all — the interesting case', () => {
    const result = matchDestination(destination({ name: 'Somewhere Nobody Mapped' }), [
      body({ _id: 'a', name: 'Lake Willoughby' }),
    ]);
    expect(result.kind).toBe('unmatched');
  });

  it('skips unnamed corpus bodies', () => {
    expect(matchDestination(destination(), [body({ _id: 'a' })]).kind).toBe('unmatched');
  });
});

describe('matchAll', () => {
  it('returns one outcome per destination, in order', () => {
    const results = matchAll(
      [destination(), destination({ name: 'Caspian Lake' })],
      [body({ _id: 'a', name: 'Lake Willoughby' })],
    );
    expect(results.map((r) => r.kind)).toEqual(['matched', 'unmatched']);
  });
});

describe('corroboration', () => {
  it('names where the two source lists agree and where they do not', () => {
    expect(corroboration(destination({ sources: ['community', 'atlas'] }))).toBe('both');
    expect(corroboration(destination({ sources: ['community'] }))).toBe('community');
    expect(corroboration(destination({ sources: ['atlas'] }))).toBe('atlas');
  });
});

describe('DESTINATION_BOOST', () => {
  /**
   * `displayScore` is `normalize(log area) ∈ [0,1] + curatedBoost`, clamped by `minVisibleZoom`.
   * N6c-1 found the D2 table's proposed weights were ~13× that whole range.
   */
  it('sits inside the score’s real dynamic range', () => {
    expect(DESTINATION_BOOST).toBeGreaterThan(0);
    expect(DESTINATION_BOOST).toBeLessThanOrEqual(1);
  });
});
