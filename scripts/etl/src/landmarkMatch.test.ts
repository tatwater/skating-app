import type { LatLng } from '@skating/core';
import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  BodyIndex,
  cutAtShore,
  keepStandaloneEstablishments,
  type MatchBody,
  matchLandmark,
  mergeSamePlace,
  mouthsOf,
  type PlacedLandmark,
  placeLandmarks,
} from './landmarkMatch';
import type { LandmarkCandidate } from './landmarkSource';

function ring(minLng: number, minLat: number, maxLng: number, maxLat: number) {
  return [
    [minLng, minLat],
    [maxLng, minLat],
    [maxLng, maxLat],
    [minLng, maxLat],
    [minLng, minLat],
  ];
}

/** A ~8 km × 11 km lake with a 1 km island hole in the middle. */
const LAKE: MatchBody = {
  id: 'lake',
  name: 'Big Lake',
  states: ['VT'],
  polygon: {
    type: 'Polygon',
    coordinates: [ring(-73.1, 44.0, -73.0, 44.1), ring(-73.06, 44.04, -73.04, 44.06)],
  },
  bbox: { minLng: -73.1, minLat: 44.0, maxLng: -73.0, maxLat: 44.1 },
  surfaceAreaSqM: 88e6,
};

/** A small pond east of the lake's shore, 500 m away. */
const POND: MatchBody = {
  id: 'pond',
  name: 'Little Pond',
  states: ['VT'],
  polygon: { type: 'Polygon', coordinates: [ring(-72.99, 44.05, -72.985, 44.055)] },
  bbox: { minLng: -72.99, minLat: 44.05, maxLng: -72.985, maxLat: 44.055 },
  surfaceAreaSqM: 0.2e6,
};

const index = new BodyIndex([LAKE, POND]);

function candidate(
  name: string,
  kind: LandmarkCandidate['kind'],
  point: LatLng,
  extra: Partial<LandmarkCandidate> = {},
): LandmarkCandidate {
  return { sourceId: `osm:node/${name}`, source: 'osm', name, kind, point, ...extra };
}

describe('BodyIndex', () => {
  it('finds bodies whose box comes within the radius, and nothing far away', () => {
    const box = { minLat: 44.052, maxLat: 44.052, minLng: -72.995, maxLng: -72.995 };
    expect(index.near(box, 10).map((b) => b.id)).toEqual([]);
    expect(
      index
        .near(box, 1_000)
        .map((b) => b.id)
        .sort(),
    ).toEqual(['lake', 'pond']);
    expect(index.near({ minLat: 40, maxLat: 40, minLng: -70, maxLng: -70 }, 1_000)).toEqual([]);
  });
});

describe('matchLandmark', () => {
  it('puts an island in the lake whose hole it fills', () => {
    const [placed] = matchLandmark(
      candidate('Gull Island', 'island', { lat: 44.05, lng: -73.05 }),
      index,
    );
    expect(placed?.waterBodyId).toBe('lake');
    expect(placed?.externalIds).toEqual(['osm:node/Gull Island']);
  });

  it('falls back to the shore for an island a causeway joined to the land', () => {
    const joined = candidate('Apple Island', 'island', { lat: 44.05, lng: -73.1005 });
    expect(matchLandmark(joined, index).map((l) => l.waterBodyId)).toEqual(['lake']);
    const inland = candidate('Hill Island', 'island', { lat: 44.05, lng: -73.12 });
    expect(matchLandmark(inland, index)).toEqual([]);
  });

  it('places a cape on the nearest shore within 300 m, and not beyond', () => {
    expect(
      matchLandmark(candidate('Long Point', 'point', { lat: 44.02, lng: -73.1025 }), index)[0]
        ?.waterBodyId,
    ).toBe('lake');
    expect(
      matchLandmark(candidate('Far Point', 'point', { lat: 44.02, lng: -73.11 }), index),
    ).toEqual([]);
  });

  it('measures a footprint by its outline, so a big beach reaching the water counts', () => {
    const outline = ring(-73.106, 44.02, -73.1001, 44.021).map(([lng, lat]) => ({
      lat: lat as number,
      lng: lng as number,
    }));
    const beach = candidate(
      'Sandy Beach',
      'beach',
      { lat: 44.0205, lng: -73.105 },
      {
        polygon: {
          type: 'Polygon',
          coordinates: [ring(-73.106, 44.02, -73.1001, 44.021)],
        } as Polygon,
        line: outline,
        areaSqM: 50_000,
      },
    );
    expect(matchLandmark(beach, index)[0]).toMatchObject({ waterBodyId: 'lake', areaSqM: 50_000 });
  });

  it('samples a long outline rather than probing every vertex', () => {
    const line = Array.from({ length: 200 }, (_, i) => ({ lat: 44.02 + i * 1e-5, lng: -73.1005 }));
    const beach = candidate(
      'Long Beach',
      'beach',
      { lat: 44.021, lng: -73.101 },
      {
        polygon: { type: 'Polygon', coordinates: [[]] } as unknown as Polygon,
        line,
      },
    );
    expect(matchLandmark(beach, index)).toHaveLength(1);
  });

  it('breaks a distance tie toward the smaller body', () => {
    const inBoth: MatchBody = {
      ...POND,
      id: 'inner',
      polygon: LAKE.polygon,
      bbox: LAKE.bbox,
      surfaceAreaSqM: 1,
    };
    const both = new BodyIndex([LAKE, inBoth]);
    expect(
      matchLandmark(candidate('Mid Rock', 'other', { lat: 44.01, lng: -73.09 }), both)[0]
        ?.waterBodyId,
    ).toBe('inner');
  });

  it('puts a bay reference on the water it names', () => {
    expect(
      matchLandmark(candidate('Mud Bay', 'bay', { lat: 44.01, lng: -73.09 }), index)[0]
        ?.waterBodyId,
    ).toBe('lake');
  });

  it('gives a shore village to every body within 750 m', () => {
    const village = candidate('Lakeside', 'settlement', { lat: 44.052, lng: -72.995 });
    expect(
      matchLandmark(village, index)
        .map((l) => l.waterBodyId)
        .sort(),
    ).toEqual(['lake', 'pond']);
  });

  it('labels a bridge at the middle of its span over the water', () => {
    const line = [
      { lat: 44.09, lng: -73.105 },
      { lat: 44.09, lng: -73.099 },
      { lat: 44.09, lng: -73.098 },
      { lat: 44.09, lng: -73.097 },
    ];
    const [bridge] = matchLandmark(
      candidate('Lake Bridge', 'bridge', line[1] as LatLng, { line }),
      index,
    );
    // Half of the 0.003° of it that is over the water, which starts at the shore (-73.1).
    expect(bridge?.point.lat).toBe(44.09);
    expect(bridge?.point.lng).toBeCloseTo(-73.0985, 9);
    const dry = [
      { lat: 44.09, lng: -73.2 },
      { lat: 44.09, lng: -73.19 },
    ];
    expect(
      matchLandmark(candidate('Dry Bridge', 'bridge', dry[0] as LatLng, { line: dry }), index),
    ).toEqual([]);
  });

  it('labels each mouth of a river, with an id per mouth', () => {
    // Flows west to east straight through the lake: in at the west shore, out at the east.
    const line = [
      { lat: 44.02, lng: -73.12 },
      { lat: 44.02, lng: -73.09 },
      { lat: 44.02, lng: -73.01 },
      { lat: 44.02, lng: -72.98 },
    ];
    const mouths = matchLandmark(
      candidate('Otter Creek', 'waterway', line[1] as LatLng, { line }),
      index,
    );
    expect(mouths.map((m) => m.externalIds[0])).toEqual([
      'osm:node/Otter Creek#in@44.0200,-73.1000',
      'osm:node/Otter Creek#out@44.0200,-73.0000',
    ]);
    // On the shore, where the river crosses it — not the nearest vertex on the water.
    expect(mouths.map((m) => m.point.lng)).toEqual([-73.1, -73.0]);
  });

  it('finds a bridge whose two vertices are both on the banks', () => {
    // Spans the pond (-72.99 … -72.985) with no vertex on the water.
    const line = [
      { lat: 44.052, lng: -72.9905 },
      { lat: 44.052, lng: -72.9845 },
    ];
    const placedOn = matchLandmark(
      candidate('Pond Bridge', 'bridge', line[0] as LatLng, { line }),
      index,
    );
    expect(placedOn.map((l) => l.waterBodyId)).toEqual(['pond']);
    expect(placedOn[0]?.point.lng).toBeCloseTo(-72.9875, 9);
  });

  it('measures a span over an island by its water alone', () => {
    // 0.005° of water, the 0.02° island, then 0.02° of water: the middle of the water is in the second.
    const line = [
      { lat: 44.05, lng: -73.065 },
      { lat: 44.05, lng: -73.02 },
    ];
    const [bridge] = matchLandmark(
      candidate('Island Bridge', 'bridge', line[0] as LatLng, { line }),
      index,
    );
    expect(bridge?.point.lng).toBeCloseTo(-73.0325, 6);
  });

  it('labels a deck drawn as an area mid-span, not on the far shore', () => {
    // A deck polygon 0.0002° wide spanning the lake (-73.1 … -73.0) and both banks: its outline
    // crosses the water twice, once down each side.
    const ring = [
      { lat: 44.02, lng: -73.12 },
      { lat: 44.02, lng: -72.98 },
      { lat: 44.0202, lng: -72.98 },
      { lat: 44.0202, lng: -73.12 },
      { lat: 44.02, lng: -73.12 },
    ];
    const deck: Polygon = { type: 'Polygon', coordinates: [ring.map((p) => [p.lng, p.lat])] };
    const [bridge] = matchLandmark(
      candidate(
        'Deck Bridge',
        'bridge',
        { lat: 44.0201, lng: -73.05 },
        { line: ring, polygon: deck },
      ),
      index,
    );
    expect(bridge?.point.lng).toBeCloseTo(-73.05, 6);
  });

  it('keeps a bridge whose span stops just short of the water, at its nearest vertex', () => {
    // The outlet bridge, or a deck OSM cut the water at: 10 m off the west shore, then away from it.
    const line = [
      { lat: 44.05, lng: -73.10013 },
      { lat: 44.05, lng: -73.1005 },
      { lat: 44.05, lng: -73.11 },
    ];
    const placedOn = matchLandmark(
      candidate('Outlet Bridge', 'bridge', line[1] as LatLng, { line }),
      index,
    );
    expect(placedOn.map((l) => l.waterBodyId)).toEqual(['lake']);
    expect(placedOn[0]?.point).toEqual(line[0]);
    const off = [
      { lat: 44.05, lng: -73.1005 },
      { lat: 44.05, lng: -73.11 },
    ];
    expect(
      matchLandmark(candidate('Inland Bridge', 'bridge', off[0] as LatLng, { line: off }), index),
    ).toEqual([]);
  });

  it('places a bridge drawn as a node by its distance to the water', () => {
    const near = candidate('Node Bridge', 'bridge', { lat: 44.052, lng: -72.9901 });
    expect(matchLandmark(near, index).map((l) => l.waterBodyId)).toEqual(['pond']);
    const far = candidate('Far Bridge', 'bridge', { lat: 44.052, lng: -72.992 });
    expect(matchLandmark(far, index)).toEqual([]);
  });

  it('finds both mouths of a stream drawn straight across a pond', () => {
    const line = [
      { lat: 44.052, lng: -72.995 },
      { lat: 44.052, lng: -72.98 },
    ];
    const mouths = matchLandmark(
      candidate('Pond Brook', 'waterway', line[0] as LatLng, { line }),
      index,
    ).filter((m) => m.waterBodyId === 'pond');
    expect(mouths.map((m) => m.externalIds[0])).toEqual([
      'osm:node/Pond Brook#in@44.0520,-72.9900',
      'osm:node/Pond Brook#out@44.0520,-72.9850',
    ]);
    expect(mouths.map((m) => Math.round(m.point.lng * 1e6) / 1e6)).toEqual([-72.99, -72.985]);
  });

  it('returns nothing for a candidate with no body near it', () => {
    expect(matchLandmark(candidate('Sea Island', 'island', { lat: 43, lng: -70 }), index)).toEqual(
      [],
    );
    expect(
      matchLandmark(candidate('Hills', 'settlement', { lat: 44.05, lng: -73.3 }), index),
    ).toEqual([]);
  });
});

describe('cutAtShore', () => {
  it('cuts a line at every shore it crosses, island rings included, and joins same-side pieces', () => {
    // West to east through the lake and across the island's hole in its middle.
    const line = [
      { lat: 44.05, lng: -73.11 },
      { lat: 44.05, lng: -73.08 },
      { lat: 44.05, lng: -73.07 },
      { lat: 44.05, lng: -72.99 },
    ];
    const pieces = cutAtShore(line, LAKE);
    expect(pieces.map((p) => p.water)).toEqual([false, true, false, true, false]);
    expect(pieces.map((p) => Math.round(p.from.lng * 1e6) / 1e6)).toEqual([
      -73.11, -73.1, -73.06, -73.04, -73.0,
    ]);
  });

  it('returns no pieces for a single vertex, and one land piece for a line nowhere near', () => {
    expect(cutAtShore([{ lat: 44.05, lng: -73.05 }], LAKE)).toEqual([]);
    expect(
      cutAtShore(
        [
          { lat: 45, lng: -73.2 },
          { lat: 45, lng: -73.15 },
        ],
        LAKE,
      ).map((p) => p.water),
    ).toEqual([false]);
  });

  it('does not cut where a line only touches the shore at a vertex', () => {
    const line = [
      { lat: 44.12, lng: -73.11 },
      { lat: 44.1, lng: -73.1 },
      { lat: 44.12, lng: -73.09 },
    ];
    expect(cutAtShore(line, LAKE).map((p) => p.water)).toEqual([false]);
  });
});

describe('mouthsOf', () => {
  it('finds a stream that ends at the shore, and one that starts there', () => {
    const inlet = [
      { lat: 44.05, lng: -73.13 },
      { lat: 44.05, lng: -73.1001 },
    ];
    expect(mouthsOf(inlet, LAKE, 30)).toEqual([{ point: inlet[1], direction: 'in' }]);
    const outlet = [...inlet].reverse();
    expect(mouthsOf(outlet, LAKE, 30)).toEqual([{ point: outlet[0], direction: 'out' }]);
  });

  it('finds nothing for a stream that stays inland or stays on the water', () => {
    expect(
      mouthsOf(
        [
          { lat: 44.05, lng: -73.2 },
          { lat: 44.05, lng: -73.15 },
        ],
        LAKE,
        30,
      ),
    ).toEqual([]);
    expect(
      mouthsOf(
        [
          { lat: 44.01, lng: -73.09 },
          { lat: 44.01, lng: -73.08 },
        ],
        LAKE,
        30,
      ),
    ).toEqual([]);
  });
});

describe('keepStandaloneEstablishments', () => {
  const at = (lat: number, lng: number) => ({ lat, lng });
  it('keeps a lone restaurant and every camp, and drops a row of restaurants', () => {
    const lone = candidate('Lone Diner', 'establishment', at(44.02, -73.1005), {
      establishment: 'food',
    });
    const row = [0, 1, 2].map((i) =>
      candidate(`Cafe ${i}`, 'establishment', at(44.08, -73.1005 + i * 0.0005), {
        establishment: 'food',
      }),
    );
    const camp = candidate('Camp Abnaki', 'establishment', at(44.0801, -73.1005), {
      establishment: 'lodging',
    });
    const island = candidate('Gull Island', 'island', at(44.05, -73.05));
    const kept = keepStandaloneEstablishments([lone, ...row, camp, island]).map((c) => c.name);
    expect(kept).toEqual(['Lone Diner', 'Camp Abnaki', 'Gull Island']);
  });

  it('does not count a business’s own second node as a neighbor', () => {
    const a = candidate('The Sand Bar', 'establishment', at(44.02, -73.1005), {
      establishment: 'food',
    });
    const b = { ...a, sourceId: 'osm:way/2', point: at(44.0201, -73.1005) };
    expect(keepStandaloneEstablishments([a, b])).toHaveLength(2);
  });
});

function landmark(
  name: string,
  kind: PlacedLandmark['kind'],
  point: LatLng,
  extra: Partial<PlacedLandmark> = {},
): PlacedLandmark {
  return {
    waterBodyId: 'lake',
    name,
    kind,
    point,
    source: 'osm',
    externalIds: [`osm:node/${name}`],
    aliases: [],
    ...extra,
  };
}

describe('mergeSamePlace', () => {
  it('folds a GNIS twin into the OSM row, keeping its id and its spelling', () => {
    const merged = mergeSamePlace(
      [
        landmark(
          'Gull Is',
          'island',
          { lat: 44.051, lng: -73.05 },
          { source: 'gnis', externalIds: ['gnis:1'] },
        ),
        landmark('Gull Island', 'island', { lat: 44.05, lng: -73.05 }, { areaSqM: 1e5 }),
        landmark(
          'gull island',
          'island',
          { lat: 44.05, lng: -73.05 },
          { source: 'gnis', externalIds: ['gnis:2'] },
        ),
      ],
      LAKE,
    );
    expect(merged).toHaveLength(2); // "Gull Is" does not fold into "Gull Island": a name, not a guess
    const gull = merged.find((m) => m.name === 'Gull Island');
    expect(gull?.externalIds).toEqual(['osm:node/Gull Island', 'gnis:2']);
    expect(gull?.aliases).toEqual(['gull island']);
  });

  it('keeps two same-named places that are far apart', () => {
    const merged = mergeSamePlace(
      [
        landmark('Cedar Island', 'island', { lat: 44.01, lng: -73.09 }),
        landmark(
          'Cedar Island',
          'island',
          { lat: 44.09, lng: -73.01 },
          { externalIds: ['osm:node/2'] },
        ),
      ],
      LAKE,
    );
    expect(merged).toHaveLength(2);
  });

  it('reaches further for long places — a passage’s two ends are one passage', () => {
    const merged = mergeSamePlace(
      [
        landmark('La Motte Passage', 'narrows', { lat: 44.0, lng: -73.05 }),
        landmark(
          'La Motte Passage',
          'narrows',
          { lat: 44.03, lng: -73.05 },
          { source: 'gnis', externalIds: ['gnis:9'] },
        ),
      ],
      LAKE,
    );
    expect(merged).toHaveLength(1);
  });

  it('lets a specific kind win over `other`', () => {
    const merged = mergeSamePlace(
      [
        landmark('Gull Rock', 'other', { lat: 44.05, lng: -73.05 }),
        landmark(
          'Gull Rock',
          'island',
          { lat: 44.05, lng: -73.05 },
          { source: 'gnis', externalIds: ['gnis:3'] },
        ),
      ],
      LAKE,
    );
    expect(merged.map((m) => m.kind)).toEqual(['island']);
  });

  it('drops a bay reference named for the lake itself, but keeps a village of that name', () => {
    const merged = mergeSamePlace(
      [
        landmark('Big Lake', 'bay', { lat: 44.05, lng: -73.09 }),
        landmark('Big Lake', 'settlement', { lat: 44.05, lng: -73.101 }),
      ],
      LAKE,
    );
    expect(merged.map((m) => m.kind)).toEqual(['settlement']);
    expect(
      mergeSamePlace([landmark('Big Lake', 'bay', { lat: 44.05, lng: -73.09 })], {
        ...LAKE,
        name: undefined,
      }),
    ).toHaveLength(1);
  });
});

describe('placeLandmarks', () => {
  it('runs the standalone rule, places, merges per body, and counts each step', () => {
    const { byBody, counts } = placeLandmarks(
      [
        candidate('Gull Island', 'island', { lat: 44.05, lng: -73.05 }),
        {
          ...candidate('Gull Island', 'island', { lat: 44.0501, lng: -73.05 }),
          sourceId: 'gnis:1',
          source: 'gnis',
        },
        candidate('Lakeside', 'settlement', { lat: 44.052, lng: -72.995 }),
        candidate('Sea Island', 'island', { lat: 43, lng: -70 }),
        ...[0, 1].map((i) =>
          candidate(
            `Cafe ${i}`,
            'establishment',
            { lat: 44.08, lng: -73.1005 + i * 0.0005 },
            {
              establishment: 'food',
            },
          ),
        ),
      ],
      index,
    );
    expect(counts).toEqual({
      candidates: 6,
      crowdedEstablishments: 2,
      unplaced: 1,
      placements: 4,
      merged: 1,
      landmarks: 3,
    });
    expect(
      byBody
        .get('lake')
        ?.map((l) => l.name)
        .sort(),
    ).toEqual(['Gull Island', 'Lakeside']);
    expect(byBody.get('pond')?.map((l) => l.name)).toEqual(['Lakeside']);
  });
});
