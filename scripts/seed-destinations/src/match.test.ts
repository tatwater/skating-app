import { describe, expect, it } from 'vitest';
import {
  boostFor,
  type CandidateBody,
  type CandidateSubArea,
  corroboration,
  DESTINATION_BOOST,
  type Destination,
  distanceKm,
  isSubArea,
  looksLikeBay,
  matchAll,
  matchDestination,
  normalizeName,
} from './match';

function body(over: Partial<CandidateBody> & { _id: string }): CandidateBody {
  return { states: ['VT'], ...over };
}

function subArea(
  over: Partial<CandidateSubArea> & { _id: string; name: string },
): CandidateSubArea {
  return {
    kind: 'subArea',
    parentId: 'parent',
    states: ['VT'],
    surfaceAreaSqM: 100_000,
    ...over,
  };
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

  it('reads an apostrophe as nothing, the way GNIS spells the name', () => {
    expect(normalizeName("Joe's Pond")).toBe(normalizeName('Joes Pond'));
    expect(normalizeName('Joe\u2019s Pond')).toBe('joes');
  });

  it('never normalizes a name to nothing — a name made of noise words is compared whole', () => {
    expect(normalizeName('Reservoir Pond')).toBe('reservoir pond');
    expect(normalizeName('The Reservoir')).toBe('the reservoir');
    expect(normalizeName('Reservoir Pond')).not.toBe(normalizeName('Reservoir'));
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
    expect(result.kind === 'matched' && result.target._id).toBe('a');
  });

  it('tries every state the author listed, and is ambiguous across them as within one', () => {
    const ny = body({ _id: 'ny', name: 'Lake George', states: ['NY'] });
    const acrossStates = {
      name: 'Lake George',
      state: 'VT',
      states: ['VT', 'NY'],
      sources: [] as [],
    };
    // Found — but only because NY is a state people posted from. Reported, flagged, never kept.
    expect(matchDestination(acrossStates, [ny])).toMatchObject({
      kind: 'matched',
      target: ny,
      viaMentionedState: true,
    });
    const vtHeadline = body({ _id: 'vt2', name: 'Lake George', states: ['VT'] });
    expect(matchDestination(acrossStates, [vtHeadline])).not.toHaveProperty('viaMentionedState');
    const vt = body({ _id: 'vt', name: 'Lake George', states: ['VT'] });
    expect(matchDestination(acrossStates, [ny, vt])).toMatchObject({ kind: 'ambiguous' });
    const vtOnly = { name: 'Lake George', state: 'VT', sources: [] as [] };
    expect(matchDestination(vtOnly, [ny])).toMatchObject({ kind: 'unmatched' });
  });

  it('ignores a same-named body in the wrong state', () => {
    const result = matchDestination(destination(), [
      body({ _id: 'nh', name: 'Lake Willoughby', states: ['NH'] }),
    ]);
    expect(result.kind).toBe('unmatched');
  });

  /**
   * The failure this script exists to prevent. The Phase-02b seed put five curated boosts on
   * same-named lakes in the wrong towns, and nobody could see it until A02 built a screen.
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
    expect(result.kind === 'matched' && result.target._id).toBe('near');
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

  it('reports ambiguous when a coordinate sits within range of two same-named bodies', () => {
    const result = matchDestination(
      destination({ name: 'Mill Pond', near: { lat: 44.0, lng: -72.0 } }),
      [
        body({ _id: 'near1', name: 'Mill Pond', centroid: { lat: 44.01, lng: -72.0 } }),
        body({ _id: 'near2', name: 'Mill Pond', centroid: { lat: 44.02, lng: -72.0 } }),
      ],
    );
    expect(result.kind).toBe('ambiguous');
    expect(result.kind === 'ambiguous' && result.candidates).toHaveLength(2);
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

  it('refuses a SOLE far-away namesake too — the corpus-town case (Greptile, PR #69)', () => {
    // Mill Pond near Montpelier: the catalog lacks it and holds one Mill Pond 54 km away. Before
    // the fix the single candidate matched unconditionally and `--apply` would have boosted it.
    const result = matchDestination(
      destination({ name: 'Mill Pond', near: { lat: 44.26, lng: -72.58 } }),
      [body({ _id: 'decoy', name: 'Mill Pond', centroid: { lat: 43.8, lng: -72.2 } })],
    );
    expect(result.kind).toBe('ambiguous');
    expect(result.kind === 'ambiguous' && result.candidates.map((c) => c._id)).toEqual(['decoy']);
  });

  it('measures near against the extent, not the point — a shore town on a 190 km lake is ON it', () => {
    // Charlotte VT sits on Lake Champlain's shore but 30 km from the lake's representative point.
    const champlain = body({
      _id: 'champlain',
      name: 'Lake Champlain',
      centroid: { lat: 44.53, lng: -73.33 },
      bbox: { minLat: 43.5, minLng: -73.5, maxLat: 45.05, maxLng: -73.0 },
    });
    const result = matchDestination(
      destination({ name: 'Lake Champlain', near: { lat: 44.31, lng: -73.26 } }),
      [champlain],
    );
    expect(result).toMatchObject({ kind: 'matched', target: { _id: 'champlain' }, distanceKm: 0 });
  });

  it('lets a matched parent name vouch for a sole bay that near would have vetoed', () => {
    // The bay is the only one by that name on the lake the entry named; its `near` is the sender's
    // town, 30 km away. Parent wins; the distance is still recorded for the reviewer.
    const bay = subArea({
      _id: 'bay',
      name: 'Little Eagle Bay',
      parentName: 'Lake Champlain',
      states: ['VT'],
      centroid: { lat: 44.85, lng: -73.3 },
    });
    const result = matchDestination(
      destination({
        name: 'Little Eagle Bay',
        kind: 'bay',
        parent: 'Lake Champlain',
        near: { lat: 44.49, lng: -73.23 },
      }),
      [],
      [bay],
    );
    expect(result).toMatchObject({ kind: 'matched', target: { _id: 'bay' } });
    expect(result.kind === 'matched' && (result.distanceKm ?? 0)).toBeGreaterThan(25);
  });

  it('still matches a sole namesake inside the radius, with its distance recorded', () => {
    const result = matchDestination(
      destination({ name: 'Mill Pond', near: { lat: 44.26, lng: -72.58 } }),
      [body({ _id: 'near', name: 'Mill Pond', centroid: { lat: 44.3, lng: -72.6 } })],
    );
    expect(result).toMatchObject({ kind: 'matched', target: { _id: 'near' } });
    expect(result.kind === 'matched' && (result.distanceKm ?? 99)).toBeLessThan(25);
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

describe('looksLikeBay', () => {
  it('is true for an explicit kind: "bay", regardless of name', () => {
    expect(looksLikeBay(destination({ name: 'Malletts', kind: 'bay' }))).toBe(true);
  });

  it('infers a bay from a name ending in Bay, Cove, Arm or Harbor', () => {
    expect(looksLikeBay(destination({ name: 'Malletts Bay' }))).toBe(true);
    expect(looksLikeBay(destination({ name: 'Dog Cove' }))).toBe(true);
    expect(looksLikeBay(destination({ name: 'The Broad Arm' }))).toBe(true);
    expect(looksLikeBay(destination({ name: 'Boothbay Harbor' }))).toBe(true);
  });

  it('is false for an ordinary lake, pond or reservoir name', () => {
    expect(looksLikeBay(destination({ name: 'Lake Willoughby' }))).toBe(false);
    expect(looksLikeBay(destination({ name: 'Mill Pond' }))).toBe(false);
    expect(looksLikeBay(destination({ name: 'Moore Reservoir' }))).toBe(false);
  });
});

describe('matchDestination against sub-areas', () => {
  it('matches a bay under its parent unambiguously', () => {
    const result = matchDestination(
      destination({ name: 'Malletts Bay', kind: 'bay', parent: 'Lake Champlain' }),
      [],
      [subArea({ _id: 'malletts', name: 'Malletts Bay', parentName: 'Lake Champlain' })],
    );
    expect(result.kind).toBe('matched');
    expect(result.kind === 'matched' && isSubArea(result.target) && result.target._id).toBe(
      'malletts',
    );
  });

  it('never searches the sub-area pool for a destination that does not look like a bay', () => {
    const result = matchDestination(
      destination({ name: 'Lake Willoughby' }),
      [],
      [subArea({ _id: 'decoy', name: 'Lake Willoughby' })],
    );
    expect(result.kind).toBe('unmatched');
  });

  it('disambiguates same-named bays on two different lakes by parent name', () => {
    const d = destination({ name: 'North Bay', kind: 'bay', parent: 'Lake George' });
    const onGeorge = subArea({ _id: 'george', name: 'North Bay', parentName: 'Lake George' });
    const onChamplain = subArea({
      _id: 'champlain',
      name: 'North Bay',
      parentName: 'Lake Champlain',
    });
    const result = matchDestination(d, [], [onGeorge, onChamplain]);
    expect(result.kind).toBe('matched');
    expect(result.kind === 'matched' && result.target._id).toBe('george');
  });

  it('disambiguates same-named bays by a `near` coordinate when no parent is given', () => {
    const d = destination({ name: 'North Bay', near: { lat: 44.0, lng: -72.0 } });
    const close = subArea({
      _id: 'close',
      name: 'North Bay',
      centroid: { lat: 44.01, lng: -72.0 },
    });
    const far = subArea({ _id: 'far', name: 'North Bay', centroid: { lat: 41.0, lng: -75.0 } });
    const result = matchDestination(d, [], [close, far]);
    expect(result.kind).toBe('matched');
    expect(result.kind === 'matched' && result.target._id).toBe('close');
  });

  it('reports ambiguous when two same-named bays are given neither a parent nor a near', () => {
    const d = destination({ name: 'North Bay' });
    const a = subArea({ _id: 'a', name: 'North Bay', parentName: 'Lake George' });
    const b = subArea({ _id: 'b', name: 'North Bay', parentName: 'Lake Champlain' });
    const result = matchDestination(d, [], [a, b]);
    expect(result.kind).toBe('ambiguous');
    expect(result.kind === 'ambiguous' && result.candidates).toHaveLength(2);
  });

  it('pools body and sub-area candidates for one ambiguity check when a name matches both', () => {
    const d = destination({ name: 'Carry Bay' });
    const asBody = body({ _id: 'body-carry', name: 'Carry Bay' });
    const asSubArea = subArea({ _id: 'sub-carry', name: 'Carry Bay' });
    const result = matchDestination(d, [asBody], [asSubArea]);
    expect(result.kind).toBe('ambiguous');
    expect(result.kind === 'ambiguous' && result.candidates).toHaveLength(2);
  });

  it('reports a matched sub-area distinctly from a matched body via isSubArea', () => {
    const result = matchDestination(
      destination({ name: 'Malletts Bay', parent: 'Lake Champlain' }),
      [],
      [subArea({ _id: 'malletts', name: 'Malletts Bay', parentName: 'Lake Champlain' })],
    );
    expect(result.kind === 'matched' && isSubArea(result.target)).toBe(true);
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

describe('boostFor', () => {
  it('falls back to DESTINATION_BOOST when a destination carries no override', () => {
    expect(boostFor(destination())).toBe(DESTINATION_BOOST);
  });

  it('honors a per-entry curatedBoost, e.g. a corpus mention-count grading', () => {
    expect(boostFor(destination({ curatedBoost: 0.1 }))).toBe(0.1);
    expect(boostFor(destination({ curatedBoost: 0.2 }))).toBe(0.2);
  });
});

describe('DESTINATION_BOOST', () => {
  /**
   * `displayScore` is `normalize(log area) ∈ [0,1] + curatedBoost`, clamped by `minVisibleZoom`.
   * A06c-1 found the A06c §4.2 table's proposed weights were ~13× that whole range.
   */
  it('sits inside the score’s real dynamic range', () => {
    expect(DESTINATION_BOOST).toBeGreaterThan(0);
    expect(DESTINATION_BOOST).toBeLessThanOrEqual(1);
  });
});
