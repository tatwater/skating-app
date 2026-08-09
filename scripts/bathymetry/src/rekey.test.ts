import { describe, expect, it } from 'vitest';
import type { ArchivedLake } from './lakes';
import {
  CONTAINMENT_REJECT_PREFIX,
  dedupeForLookup,
  isRekeyEligible,
  LOOKUP_GRID_PLACES,
  lookupCell,
  type PointAssignment,
  rekeyByBody,
} from './rekey';

/** A sounding lake, as `readAllLakes` produces one. */
function soundingLake(lakeKey: string, points: { lng: number; lat: number; depthFt: number }[]) {
  return {
    sourceKey: 'me-dep-soundings',
    state: 'ME',
    agency: 'Maine DEP',
    lane: 'soundings',
    lakeKey,
    lakeName: 'North Pond',
    soundings: points,
  } as unknown as ArchivedLake;
}

const at = (externalId: string, name = 'A Lake'): PointAssignment => ({ externalId, name });

describe('Rule 0 — the lane never touches a key that already works', () => {
  // Founder, 2026-08-03: "We should only do this if the soundings source points at a lake and then
  // doesn't match up with the lake's polygon." Eligibility is the containment gate and NOTHING else.
  it('opens only for a containment rejection', () => {
    expect(
      isRekeyEligible(
        'no body here holds the survey: best is "Enchanted Pond" with 0% of 64 sampled measurements',
      ),
    ).toBe(true);
    expect(isRekeyEligible(CONTAINMENT_REJECT_PREFIX)).toBe(true);
  });

  it('stays shut for a survey that is simply outside our coverage', () => {
    // "No listed body within 25 m" means there is no corpus here at all. Re-keying point-by-point
    // would return nothing and cost a scan of every sounding to learn it — that is D92's problem.
    expect(isRekeyEligible('no listed body within 25 m of this point')).toBe(false);
  });

  it('stays shut for an infrastructure failure', () => {
    expect(isRekeyEligible('join failed: read limit exceeded')).toBe(false);
    expect(isRekeyEligible('query failed')).toBe(false);
  });

  it('CHINA LAKE (MIDAS 5448) is never eligible — the fixture this rule is named for', () => {
    // A real 3,939-acre lake with 25,807 legitimate soundings and a clean containment score. It does
    // not appear in the join's reject list at all, so it never reaches this lane. Asserted here
    // rather than in a run log because a future refactor that generalises the re-keyer is exactly
    // the change that would break it silently.
    //
    // Every reason a *matched* key could carry is the empty set: a match produces no reason. The
    // closest a healthy key gets is a partial containment that still passed, which is not a reject.
    for (const notAReject of ['', 'matched', 'crosswalk confirmed']) {
      expect(isRekeyEligible(notAReject)).toBe(false);
    }
  });
});

describe('rekeyByBody — soundings in different bodies are in different bodies', () => {
  const lake = () =>
    soundingLake('870', [
      { lng: -70.1, lat: 44.1, depthFt: 10 },
      { lng: -70.1001, lat: 44.1001, depthFt: 12 },
      { lng: -69.5, lat: 45.2, depthFt: 30 },
      { lng: -68.2, lat: 46.4, depthFt: 5 },
    ]);

  it('splits one bucket key into one lake per corpus body', () => {
    // MIDAS 870 in miniature: four soundings, three real lakes, one key. `splitByBody` derives a
    // 27.8 km gap threshold from this cloud's own 348 km span and returns ONE cluster; membership
    // returns three, which is the answer.
    const result = rekeyByBody(lake(), [
      at('way/great-pond'),
      at('way/great-pond'),
      at('way/lake-auburn'),
      at('way/thompson-lake'),
    ]);
    expect(result.parts).toHaveLength(3);
    expect(result.bodiesTouched).toBe(3);
    expect(result.unmatched).toBe(0);
  });

  it('keys each part by the BODY, not by an ordinal', () => {
    // `#1`/`#2` renumber whenever the group sizes reorder, so a re-run that gains one sounding
    // renames lakes that did not change. An externalId does not move.
    const result = rekeyByBody(lake(), [
      at('way/great-pond'),
      at('way/great-pond'),
      at('way/lake-auburn'),
      at('way/thompson-lake'),
    ]);
    expect(result.parts.map((p) => p.lakeKey)).toEqual([
      '870@way/great-pond',
      '870@way/lake-auburn',
      '870@way/thompson-lake',
    ]);
  });

  it('uses @ so a re-key can never be confused with a distance split', () => {
    const result = rekeyByBody(lake(), [at('way/a'), at('way/a'), at('way/a'), at('way/a')]);
    expect(result.parts[0]?.lakeKey).toBe('870@way/a');
    expect(result.parts[0]?.lakeKey).not.toContain('#');
  });

  it('orders parts largest first, and breaks ties stably', () => {
    const result = rekeyByBody(lake(), [
      at('way/zzz'),
      at('way/aaa'),
      at('way/aaa'),
      at('way/zzz'),
    ]);
    // Both hold two; the tie breaks on id so the log does not reorder between runs.
    expect(result.parts.map((p) => p.lakeKey)).toEqual(['870@way/aaa', '870@way/zzz']);
  });

  it('counts what fell in no body rather than dropping it silently', () => {
    // 3.7% of MIDAS 870's soundings land outside every polygon. That is a number to report, and the
    // one thing this lane must never do is make measurements disappear without saying so.
    const result = rekeyByBody(lake(), [at('way/a'), null, null, at('way/a')]);
    expect(result.unmatched).toBe(2);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]?.soundings).toHaveLength(2);
  });

  it('carries every sounding into exactly one part', () => {
    const source = lake();
    const result = rekeyByBody(source, [at('way/a'), at('way/b'), at('way/b'), at('way/c')]);
    const total = result.parts.reduce((n, p) => n + (p.soundings?.length ?? 0), 0);
    expect(total + result.unmatched).toBe(source.soundings?.length);
  });

  it('keeps every other field of the source lake', () => {
    // The parts go straight back through the ordinary join, which reads `sourceKey` for the credit
    // line and `lane` to choose between publishing contours and fitting a surface.
    const result = rekeyByBody(lake(), [at('way/a'), at('way/a'), at('way/a'), at('way/a')]);
    const part = result.parts[0];
    expect(part?.sourceKey).toBe('me-dep-soundings');
    expect(part?.lane).toBe('soundings');
    expect(part?.state).toBe('ME');
    expect(part?.contours).toBeUndefined();
  });

  it('returns nothing to gate when the survey is in no body at all', () => {
    const result = rekeyByBody(lake(), [null, null, null, null]);
    expect(result.parts).toEqual([]);
    expect(result.bodiesTouched).toBe(0);
    expect(result.unmatched).toBe(4);
  });
});

describe('rekeyByBody — the contour lane', () => {
  const contourLake = () =>
    ({
      sourceKey: 'nh-granit-contours',
      state: 'NH',
      agency: 'NH GRANIT',
      lane: 'contours',
      lakeKey: 'AU-1',
      lakeName: 'Horseshoe Pond',
      contours: [
        {
          depthFt: 5,
          geometry: {
            type: 'LineString',
            coordinates: [
              [-71.1, 43.1],
              [-71.1001, 43.1001],
            ],
          },
        },
        {
          depthFt: 10,
          geometry: {
            type: 'LineString',
            coordinates: [
              [-70.5, 43.9],
              [-70.5001, 43.9001],
            ],
          },
        },
      ],
    }) as unknown as ArchivedLake;

  it('counts a contour whose first vertex is in no body, and keeps the cursor aligned', () => {
    // The alignment is the subtle half: `cursor` must advance by this line's vertex count even when
    // the line is skipped, or every contour after an unmatched one reads the wrong assignment — and
    // the result would be plausible, wrongly-attributed isobaths rather than an error.
    const result = rekeyByBody(contourLake(), [null, null, at('way/south'), at('way/south')]);
    expect(result.unmatched).toBe(1);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]?.lakeKey).toBe('AU-1@way/south');
    expect(result.parts[0]?.contours?.[0]?.depthFt).toBe(10);
  });

  it('assigns a contour by its FIRST vertex, never shredding one isobath', () => {
    // A line straddling two bodies cannot exist — that is what "separate bodies" means — and a
    // per-vertex split would leave fragments belonging to neither. Two vertices per line here, so
    // the second assignment of each pair is the one that must be skipped over.
    const result = rekeyByBody(contourLake(), [
      at('way/north'),
      at('way/north'),
      at('way/south'),
      at('way/south'),
    ]);
    expect(result.parts).toHaveLength(2);
    expect(result.parts.every((p) => p.contours?.length === 1)).toBe(true);
    expect(result.parts.every((p) => p.soundings === undefined)).toBe(true);
  });
});

describe('dedupeForLookup — asking the corpus once per cell, not once per sounding', () => {
  it('collapses measurements sharing a ~11 m cell into one lookup', () => {
    // A sounding transect runs tens of metres apart, so a dense survey collapses hard. This is the
    // difference between one query and hundreds: the read cap counts BYTES, and a survey inside one
    // large lake re-reads that lake's shoreline once per point.
    // ⚠ Kept away from a rounding boundary on purpose. `toFixed` splits at the .00005 edge, so two
    // points a millionth of a degree apart CAN land in different cells if they straddle one. That is
    // harmless — the grid only has to be a consistent partition, not a nearest-neighbour rule — but
    // a fixture sitting on the edge tests float rounding rather than the dedup, and the first draft
    // of this test did exactly that.
    const points = [
      { lat: 44.12341, lng: -70.98761 },
      { lat: 44.12342, lng: -70.98762 }, // same cell at 4 dp
      { lat: 44.99991, lng: -70.99991 }, // elsewhere
    ];
    const { cells, indices } = dedupeForLookup(points);
    expect(cells).toHaveLength(2);
    expect(indices).toEqual([[0, 1], [2]]);
  });

  it('asks about a REAL measurement, never a rounded coordinate', () => {
    // A rounded point can land just outside the water on a narrow lake, which would answer the
    // wrong question. The first measurement in each cell is the one sent.
    const points = [{ lat: 44.123456789, lng: -70.987654321 }];
    expect(dedupeForLookup(points).cells).toEqual([{ lat: 44.123456789, lng: -70.987654321 }]);
  });

  it('maps every point to exactly one cell, losing none', () => {
    const points = Array.from({ length: 50 }, (_, i) => ({
      lat: 44 + Math.floor(i / 5) / 1000,
      lng: -70,
    }));
    const { cells, indices } = dedupeForLookup(points);
    expect(indices.flat().sort((a, b) => a - b)).toEqual(points.map((_, i) => i));
    expect(cells.length).toBe(10);
  });

  it('handles an empty survey', () => {
    expect(dedupeForLookup([])).toEqual({ cells: [], indices: [] });
  });

  it('lookupCell is stable and grid-aligned', () => {
    expect(lookupCell({ lat: 44.1, lng: -70.2 })).toBe(
      lookupCell({ lat: 44.10001, lng: -70.20001 }),
    );
    expect(lookupCell({ lat: 44.1234, lng: -70.9876 })).not.toBe(
      lookupCell({ lat: 44.2234, lng: -70.9876 }),
    );
    expect(LOOKUP_GRID_PLACES).toBe(4);
  });
});
