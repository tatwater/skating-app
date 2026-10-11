import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  filledPolygon,
  LANDMARK_KIND_LABELS,
  LANDMARK_KINDS,
  LANDMARK_LABEL_MAX_ZOOM,
  LANDMARK_LABEL_MIN_ZOOM,
  LANDMARK_SAME_PLACE_RADIUS_M,
  landmarkDropsHeld,
  landmarkLabelFeatures,
  landmarkLabelMinZoom,
  landmarkNameKey,
  landmarkProminence,
  landmarkSourceShortfalls,
  landmarksAreSamePlace,
  MAX_LANDMARK_ALIASES,
  MAX_LANDMARK_NAME_LENGTH,
  MAX_LANDMARK_SOURCE_SHRINK,
  normalizeLandmarkNames,
  subAreaForLandmark,
} from './landmarks';

describe('landmarkNameKey', () => {
  it('folds the spellings the corpus writes for one place', () => {
    expect(landmarkNameKey("Mallett's Head")).toBe(landmarkNameKey('Malletts head'));
    expect(landmarkNameKey('The Gut')).toBe(landmarkNameKey('gut'));
    expect(landmarkNameKey('Saint Albans Bay')).toBe(landmarkNameKey('St. Albans Bay'));
  });

  it('keeps a "the" that is not leading', () => {
    expect(landmarkNameKey('Over the Rainbow Rock')).toBe('over the rainbow rock');
  });
});

describe('landmarkProminence', () => {
  it('labels every kind', () => {
    for (const kind of LANDMARK_KINDS) expect(LANDMARK_KIND_LABELS[kind]).toBeTruthy();
  });

  it('ranks an island above a standalone restaurant before anyone has said a word', () => {
    expect(landmarkProminence({ kind: 'island' })).toBeGreaterThan(
      landmarkProminence({ kind: 'establishment' }),
    );
  });

  it('lets the community lift a weak kind over a silent strong one', () => {
    expect(landmarkProminence({ kind: 'establishment', corpusMessages: 6 })).toBeGreaterThan(
      landmarkProminence({ kind: 'island' }),
    );
  });

  it('never goes negative and never falls as evidence grows', () => {
    const kind = fc.constantFrom(...LANDMARK_KINDS);
    const count = fc.integer({ min: -5, max: 10_000 });
    const area = fc.option(fc.double({ min: 0, max: 1e9, noNaN: true }), { nil: undefined });
    fc.assert(
      fc.property(kind, count, count, area, fc.nat(50), (k, messages, reports, areaSqM, more) => {
        const base = landmarkProminence({
          kind: k,
          corpusMessages: messages,
          reportCount: reports,
          areaSqM,
        });
        expect(base).toBeGreaterThanOrEqual(0);
        expect(
          landmarkProminence({
            kind: k,
            corpusMessages: messages + more,
            reportCount: reports,
            areaSqM,
          }),
        ).toBeGreaterThanOrEqual(base);
        expect(
          landmarkProminence({
            kind: k,
            corpusMessages: messages,
            reportCount: reports + more,
            areaSqM,
          }),
        ).toBeGreaterThanOrEqual(base);
      }),
    );
  });

  it('stops counting area past a square kilometer', () => {
    expect(landmarkProminence({ kind: 'island', areaSqM: 1e6 })).toBe(
      landmarkProminence({ kind: 'island', areaSqM: 1e8 }),
    );
    expect(landmarkProminence({ kind: 'island', areaSqM: 5_000 })).toBe(
      landmarkProminence({ kind: 'island' }),
    );
  });
});

describe('landmarkLabelMinZoom', () => {
  it('shows a big island sooner than a small one', () => {
    const big = landmarkLabelMinZoom({ kind: 'island', areaSqM: 2_000_000, lat: 44.5 });
    const small = landmarkLabelMinZoom({ kind: 'island', areaSqM: 2_000, lat: 44.5 });
    expect(big).toBeLessThan(small);
  });

  it('shows a well-named point sooner than a silent one', () => {
    expect(landmarkLabelMinZoom({ kind: 'point', corpusMessages: 20, lat: 44.5 })).toBeLessThan(
      landmarkLabelMinZoom({ kind: 'point', lat: 44.5 }),
    );
  });

  it('is a whole zoom, rounded up — the zoom a MapLibre filter can honor, never one early', () => {
    // A ~1 km² island at 44.5° draws big enough at z11.7: the maps' filters can show it at 12.
    expect(landmarkLabelMinZoom({ kind: 'island', areaSqM: 1_000_000, lat: 44.5 })).toBe(12);
  });

  it('never leaves the label band, whatever the inputs', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LANDMARK_KINDS),
        fc.option(fc.double({ min: 0, max: 1e11, noNaN: true }), { nil: undefined }),
        fc.nat(100_000),
        fc.double({ min: -89, max: 89, noNaN: true }),
        (kind, areaSqM, corpusMessages, lat) => {
          const zoom = landmarkLabelMinZoom({ kind, areaSqM, corpusMessages, lat });
          expect(zoom).toBeGreaterThanOrEqual(LANDMARK_LABEL_MIN_ZOOM);
          expect(zoom).toBeLessThanOrEqual(LANDMARK_LABEL_MAX_ZOOM);
          expect(Number.isInteger(zoom)).toBe(true);
        },
      ),
    );
  });
});

describe('landmarkLabelFeatures', () => {
  const beach = {
    name: 'Leddy Park Beach',
    kind: 'beach' as const,
    point: { lat: 44.5, lng: -73.25 },
    prominence: 3,
    minZoom: 13,
  };
  const island = { ...beach, name: 'Apple Island', kind: 'island' as const, prominence: 5 };

  it('carries what the layer filters and sorts on, most prominent sorting first', () => {
    const fc = landmarkLabelFeatures([beach, island]);
    expect(fc.features.map((f) => f.properties)).toEqual([
      { name: 'Leddy Park Beach', kind: 'beach', minZoom: 13, sortKey: -3 },
      { name: 'Apple Island', kind: 'island', minZoom: 13, sortKey: -5 },
    ]);
    expect(fc.features[0]?.geometry.coordinates).toEqual([-73.25, 44.5]);
  });

  it('leaves out a landmark a nearby put-in already names, and only that one', () => {
    const putIns = [
      { coord: { lat: 44.5005, lng: -73.25 }, name: 'Leddy Park beach' },
      { coord: { lat: 44.6, lng: -73.25 }, name: 'Apple Island' },
      { coord: { lat: 44.5, lng: -73.25 } },
    ];
    expect(
      landmarkLabelFeatures([beach, island], putIns).features.map((f) => f.properties.name),
    ).toEqual(['Apple Island']);
  });
});

describe('normalizeLandmarkNames', () => {
  it('trims, collapses spaces, and drops aliases that only re-spell the name or each other', () => {
    expect(
      normalizeLandmarkNames('  Bird   Poop Rock ', [
        'bird poop rock',
        ' The Poop  Rock',
        'the poop rock',
        '',
      ]),
    ).toEqual({ name: 'Bird Poop Rock', aliases: ['The Poop Rock'] });
  });

  it('refuses an empty or overlong name, and drops an overlong alias', () => {
    expect(normalizeLandmarkNames('   ')).toBeNull();
    expect(normalizeLandmarkNames('x'.repeat(MAX_LANDMARK_NAME_LENGTH + 1))).toBeNull();
    expect(
      normalizeLandmarkNames('Gull Rock', ['y'.repeat(MAX_LANDMARK_NAME_LENGTH + 1), '...']),
    ).toEqual({
      name: 'Gull Rock',
      aliases: [],
    });
  });

  it('keeps at most the alias cap', () => {
    const many = Array.from({ length: MAX_LANDMARK_ALIASES + 5 }, (_, i) => `Spelling ${i}`);
    expect(normalizeLandmarkNames('Gull Rock', many)?.aliases).toHaveLength(MAX_LANDMARK_ALIASES);
  });
});

describe('subAreaForLandmark', () => {
  const ring = (minLng: number, minLat: number, maxLng: number, maxLat: number) => [
    [minLng, minLat],
    [maxLng, minLat],
    [maxLng, maxLat],
    [minLng, maxLat],
    [minLng, minLat],
  ];
  // A bay with an island hole in it, and a smaller cove inside the bay.
  const bay = {
    ref: 'bay',
    polygon: {
      type: 'Polygon' as const,
      coordinates: [ring(-73.2, 44.0, -73.0, 44.2), ring(-73.12, 44.08, -73.08, 44.12)],
    },
    surfaceAreaSqM: 3e8,
  };
  const cove = {
    ref: 'cove',
    polygon: { type: 'MultiPolygon' as const, coordinates: [[ring(-73.2, 44.0, -73.15, 44.05)]] },
    surfaceAreaSqM: 1e7,
  };

  it('puts an island in the bay whose water surrounds it', () => {
    expect(subAreaForLandmark({ lat: 44.1, lng: -73.1 }, [bay, cove])).toBe('bay');
  });

  it('prefers the smallest bay containing it', () => {
    expect(subAreaForLandmark({ lat: 44.02, lng: -73.18 }, [bay, cove])).toBe('cove');
  });

  it('gives a point just off the shore to the nearest bay, and open water to none', () => {
    expect(subAreaForLandmark({ lat: 44.1, lng: -73.2012 }, [bay, cove])).toBe('bay');
    expect(subAreaForLandmark({ lat: 44.1, lng: -73.25 }, [bay, cove])).toBeNull();
    expect(subAreaForLandmark({ lat: 44.1, lng: -73.1 }, [])).toBeNull();
  });

  it('skips a bay whose stored box, grown by the tolerance, misses the point', () => {
    const boxed = { ...bay, bbox: { minLat: 44.0, minLng: -73.2, maxLat: 44.2, maxLng: -73.0 } };
    expect(subAreaForLandmark({ lat: 44.1, lng: -73.1 }, [boxed])).toBe('bay');
    expect(subAreaForLandmark({ lat: 45.1, lng: -73.1 }, [boxed])).toBeNull();
    expect(subAreaForLandmark({ lat: 44.1, lng: -74.1 }, [boxed])).toBeNull();
  });

  it('breaks an equal-distance tie toward the smaller bay', () => {
    const twin = { ...bay, ref: 'twin', surfaceAreaSqM: 1 };
    expect(subAreaForLandmark({ lat: 44.1, lng: -73.2012 }, [bay, twin])).toBe('twin');
  });
});

describe('landmarksAreSamePlace', () => {
  const at = (lat: number, lng: number) => ({ lat, lng });
  const gull = {
    kind: 'island' as const,
    point: at(44.5, -73.3),
    names: ['Gull Island', 'Gull Is'],
  };

  it('is one place: same name (either way round), kinds that agree, within the kind’s radius', () => {
    expect(
      landmarksAreSamePlace(gull, { ...gull, names: ['gull is'], point: at(44.505, -73.3) }),
    ).toBe(true);
    expect(landmarksAreSamePlace(gull, { ...gull, kind: 'other', names: ['Gull Island'] })).toBe(
      true,
    );
  });

  it('is two places when far apart, of different kinds, or differently named', () => {
    expect(landmarksAreSamePlace(gull, { ...gull, point: at(44.52, -73.3) })).toBe(false);
    expect(landmarksAreSamePlace(gull, { ...gull, kind: 'settlement' })).toBe(false);
    expect(landmarksAreSamePlace(gull, { ...gull, names: ['Cedar Island'] })).toBe(false);
  });

  it('reaches further for long places — a passage’s two ends are one passage', () => {
    const passage = {
      kind: 'narrows' as const,
      point: at(44.0, -73.05),
      names: ['La Motte Passage'],
    };
    expect(landmarksAreSamePlace(passage, { ...passage, point: at(44.03, -73.05) })).toBe(true);
    expect(LANDMARK_SAME_PLACE_RADIUS_M.narrows).toBeGreaterThan(
      LANDMARK_SAME_PLACE_RADIUS_M.island,
    );
  });
});

describe('filledPolygon', () => {
  it('drops the holes, so an island is inside the water around it', () => {
    const filled = filledPolygon({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
          [0, 0],
        ],
        [
          [1, 1],
          [2, 1],
          [2, 2],
          [1, 2],
          [1, 1],
        ],
      ],
    });
    expect(filled.coordinates).toHaveLength(1);
    expect(filled.coordinates[0]).toHaveLength(1);
  });
});

describe('landmarkSourceShortfalls', () => {
  const baseline = [
    { source: 'vt.osm', count: 9_000 },
    { source: 'vt.gnis', count: 1_200 },
  ];

  it('vouches for sources that read what the accepted load read, within the margin', () => {
    expect(landmarkSourceShortfalls(baseline, baseline)).toEqual([]);
    expect(
      landmarkSourceShortfalls(
        [
          { source: 'vt.osm', count: 8_800 },
          { source: 'vt.gnis', count: 1_300 },
          { source: 'ny.osm', count: 50_000 },
        ],
        baseline,
      ),
    ).toEqual([]);
  });

  it('names every source that is empty, short, or not read', () => {
    expect(
      landmarkSourceShortfalls(
        [
          { source: 'vt.osm', count: 4_000 },
          { source: 'ny.gnis', count: 0 },
        ],
        baseline,
      ),
    ).toEqual([
      'ny.gnis: no candidates',
      'vt.osm: 4000 candidates, 56% under the accepted 9000',
      'vt.gnis: not read this run',
    ]);
  });

  it('will not vouch without a baseline or without the run’s own counts', () => {
    expect(landmarkSourceShortfalls(baseline, undefined)).toEqual([
      'no complete load has been accepted on this deployment yet',
    ]);
    expect(landmarkSourceShortfalls(undefined, baseline)).toHaveLength(1);
    expect(landmarkSourceShortfalls([], baseline)).toHaveLength(1);
  });

  it('never vouches for a source under the margin (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1e6 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (last, f) => {
          const now = Math.floor(last * f);
          const out = landmarkSourceShortfalls(
            [{ source: 's', count: now }],
            [{ source: 's', count: last }],
          );
          return now >= last * (1 - MAX_LANDMARK_SOURCE_SHRINK)
            ? out.length === 0
            : out.length === 1;
        },
      ),
    );
  });
});

describe('landmarkDropsHeld', () => {
  it('holds a drop of more than half a lake’s catalog rows, past the floor', () => {
    expect(landmarkDropsHeld(11, 20)).toBe(true);
    expect(landmarkDropsHeld(10, 12)).toBe(false); // at the floor: a small lake may lose its few
    expect(landmarkDropsHeld(11, 22)).toBe(false); // exactly half
    expect(landmarkDropsHeld(1, 1)).toBe(false);
  });
});
