/**
 * The master list's decision rules, against named answers (N7).
 *
 * Written to the plan's verification discipline — *"named fixtures, not coverage percentages"*. Every
 * case below is either a body we can name or a failure the campaign actually met, and several of them
 * pin behaviour that is **known to be weaker than it looks**, so that tightening it later is a visible
 * change to a test rather than a silent change to 27,074 rows.
 */

import type { BBox, ClaimSource, WaterBodyClass } from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  CELL_DEG,
  catalogueIdsOf,
  cellsFor,
  chooseClass,
  chooseGeometry,
  chooseName,
  covers,
  dropReason,
  type Feature,
  type GnisPoint,
  gnisNameFor,
  hasBayParent,
  idFromKey,
  inDownstate,
  index,
  inRegion,
  isVetoed,
  type Merged,
  mergeGroup,
  mergeGroupWithReason,
  outerRings,
  polygonClaims,
  REGION_SAMPLE_POINTS,
  SQ_M_PER_ACRE,
  sampleOutline,
  statesFor,
  Union,
} from './mergeRules';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** An axis-aligned square, given its south-west corner and side length in degrees. */
function square(lng: number, lat: number, side: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lng, lat],
        [lng + side, lat],
        [lng + side, lat + side],
        [lng, lat + side],
        [lng, lat],
      ],
    ],
  };
}

function bboxOf(g: Polygon | MultiPolygon): BBox {
  const pts = outerRings(g).flat();
  const lngs = pts.map((p) => p[0] as number);
  const lats = pts.map((p) => p[1] as number);
  return {
    minLng: Math.min(...lngs),
    maxLng: Math.max(...lngs),
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
  };
}

function feature(
  source: ClaimSource,
  id: string,
  over: Partial<Feature> & { cls?: WaterBodyClass | null } = {},
): Feature {
  const polygon = over.polygon ?? square(-70, 44, 0.01);
  return {
    source,
    id,
    name: '',
    cls: 'lakePond',
    token: `${source}:test`,
    polygon,
    bbox: over.bbox ?? bboxOf(polygon),
    areaSqM: 100_000,
    ...over,
  };
}

function merged(over: Partial<Merged> = {}): Merged {
  const polygon = over.polygon ?? square(-70, 44, 0.01);
  return {
    key: 'osm:way/1',
    members: [],
    name: '',
    cls: 'lakePond',
    areaSqM: 100_000,
    bbox: over.bbox ?? bboxOf(polygon),
    polygon,
    geometrySource: 'osm',
    sameSourceDuplicate: false,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the veto', () => {
  it('refuses Long Island Sound, which NHD publishes as a classifiable Estuary', () => {
    const group = [
      feature('nhd', '123', { token: 'nhd:ftype=493', cls: 'bay', name: 'Long Island Sound' }),
    ];
    expect(isVetoed(group)).toBe(true);
    expect(mergeGroupWithReason(group)).toEqual({ body: null, reason: 'vetoed' });
  });

  it('refuses an ocean polygon 3DHP has classed, even when OSM calls the same water a lake', () => {
    // The veto is not a vote: one source naming this the ocean ends the question, and it must beat a
    // perfectly ordinary lakePond claim from a source that outranks it everywhere else.
    const group = [
      feature('osm', 'way/1', { cls: 'lakePond', name: 'Somewhere Bay' }),
      feature('3dhp', 'ABC', { token: '3dhp:featuretype=4', cls: 'lakePond' }),
    ];
    expect(mergeGroup(group)).toBeNull();
  });

  it('⚠ does NOT catch a Great Lake that only NHD published, because NHD calls it FTYPE 390', () => {
    // **This is a real gap, pinned deliberately rather than fixed here.** The veto set holds
    // `3dhp:featuretype=4`, `nhd:ftype=445` (SeaOcean) and `nhd:ftype=493` (Estuary) — but NHD files
    // **Lake Erie as FTYPE 390, an ordinary LakePond**, and New York borders both Erie and Ontario,
    // so `inRegion` will pass them. Today they are refused only because the 3DHP lane matched them
    // and contributed its `featuretype=4`. That makes an ocean-sized false admission contingent on a
    // *match succeeding* — the one thing in this pipeline that is measured at 33% on the OSM lane.
    //
    // Fixing it means either an area ceiling or a named-exclusion list, both of which are decisions.
    // Until then this test states the exposure so it cannot be rediscovered in production.
    const lakeErieFromNhdAlone = [
      feature('nhd', '999', {
        token: 'nhd:ftype=390',
        cls: 'lakePond',
        name: 'Lake Erie',
        areaSqM: 2.57e10,
      }),
    ];
    expect(isVetoed(lakeErieFromNhdAlone)).toBe(false);
    expect(mergeGroup(lakeErieFromNhdAlone)?.name).toBe('Lake Erie');
  });
});

describe('class selection', () => {
  it('rescues the 123 bodies OSM calls wetland and NHD calls LakePond', () => {
    // The single measured reason this whole file exists. A wetland claim must lose to a lakePond one,
    // because `belongsInCorpus` holds unnamed wetland to a 50-acre bar and lakePond to five.
    const group = [
      feature('osm', 'way/1', { cls: 'wetland', token: 'osm:wetland=marsh' }),
      feature('nhd', '456', { cls: 'lakePond', token: 'nhd:ftype=390', name: 'Kingdom Bog' }),
    ];
    expect(mergeGroup(group)?.cls).toBe('lakePond');
  });

  it('refuses a group every catalogue refused — null, never unclassified', () => {
    // Collapsing `null` into `unclassified` admitted Lake Huron and seven polygons of the Atlantic on
    // the first real run. `null` means "not water we cover"; `unclassified` means "water, but nobody
    // said what kind". A drop that survives a merge launders a refusal into a shrug.
    const group = [feature('osm', 'way/1', { cls: null }), feature('3dhp', 'X', { cls: null })];
    expect(chooseClass(group)).toBeNull();
    expect(mergeGroupWithReason(group)).toEqual({ body: null, reason: 'no-class' });
  });

  it('keeps a class when only SOME members refuse', () => {
    const group = [
      feature('osm', 'way/1', { cls: null }),
      feature('nhd', '2', { cls: 'reservoir' }),
    ];
    expect(chooseClass(group)).toBe('reservoir');
  });

  it('prefers the more specific claim: reservoir over lakePond over unclassified', () => {
    expect(
      chooseClass([
        feature('osm', 'a', { cls: 'lakePond' }),
        feature('nhd', 'b', { cls: 'reservoir' }),
      ]),
    ).toBe('reservoir');
    expect(
      chooseClass([
        feature('osm', 'a', { cls: 'unclassified' }),
        feature('nhd', 'b', { cls: 'lakePond' }),
      ]),
    ).toBe('lakePond');
    // …and order of arrival never decides it.
    expect(
      chooseClass([
        feature('nhd', 'b', { cls: 'reservoir' }),
        feature('osm', 'a', { cls: 'lakePond' }),
      ]),
    ).toBe('reservoir');
  });
});

describe('name selection', () => {
  it('prefers a name over its absence, from whichever catalogue has one', () => {
    expect(chooseName([feature('osm', 'a'), feature('nhd', 'b', { name: 'Beau Lake' })])).toBe(
      'Beau Lake',
    );
  });

  it('prefers the longer name when both exist — a heuristic, pinned as one', () => {
    // "More specific" is operationalised as longer. It is right for Little Moose Pond vs Moose Pond
    // and arguable for a parenthesised qualifier; this test exists so that changing the rule is a
    // deliberate edit rather than a silent drift.
    expect(
      chooseName([
        feature('osm', 'a', { name: 'Moose Pond' }),
        feature('nhd', 'b', { name: 'Little Moose Pond' }),
      ]),
    ).toBe('Little Moose Pond');
  });

  it('breaks a length tie toward the earlier member, so a stable input gives a stable name', () => {
    expect(
      chooseName([
        feature('osm', 'a', { name: 'Mud Pond' }),
        feature('nhd', 'b', { name: 'Cub Pond' }),
      ]),
    ).toBe('Mud Pond');
  });

  it('is empty when nobody named it — the 92% case', () => {
    expect(chooseName([feature('osm', 'a'), feature('nhd', 'b')])).toBe('');
  });
});

describe('geometry selection (provisional, pending D92)', () => {
  it('prefers OSM, then NHD, then whatever is left', () => {
    expect(chooseGeometry([feature('nhd', 'n'), feature('osm', 'o')])?.source).toBe('osm');
    expect(chooseGeometry([feature('3dhp', 'd'), feature('nhd', 'n')])?.source).toBe('nhd');
    expect(chooseGeometry([feature('3dhp', 'd')])?.source).toBe('3dhp');
  });

  it('measures area from the polygon it chose, never the larger claim (D94)', () => {
    // Beau Lake is the fixture: OSM's outline merges at 2,457 acres against NHD's measured 1,876.6.
    // Whichever we pick, the stored area is that polygon's — taking the larger of two claims would
    // turn D91's floor into "did either source round up enough".
    const osmBeau = feature('osm', 'way/1', { name: 'Beau Lake', areaSqM: 2457 * SQ_M_PER_ACRE });
    const nhdBeau = feature('nhd', '85383A01', {
      name: 'Beau Lake',
      areaSqM: 1876.6 * SQ_M_PER_ACRE,
    });
    const body = mergeGroup([osmBeau, nhdBeau]);
    expect(body?.geometrySource).toBe('osm');
    expect(body?.areaSqM).toBeCloseTo(2457 * SQ_M_PER_ACRE, 0);
    expect(body?.areaSqM).not.toBeCloseTo(1876.6 * SQ_M_PER_ACRE, 0);
  });
});

describe('same-source duplicates', () => {
  it('flags two features from one catalogue — the only guard against a chained union-find', () => {
    // Unioning three lanes can in principle chain two distinct lakes into one group. Nothing prevents
    // it; this flag is what sends such a group to a human instead of merging it.
    const group = [feature('osm', 'way/1'), feature('osm', 'relation/2'), feature('nhd', 'n1')];
    expect(mergeGroup(group)?.sameSourceDuplicate).toBe(true);
  });

  it('does not flag one feature per catalogue', () => {
    const group = [feature('osm', 'way/1'), feature('nhd', 'n1'), feature('3dhp', 'd1')];
    expect(mergeGroup(group)?.sameSourceDuplicate).toBe(false);
  });

  it('refuses an empty group rather than throwing', () => {
    expect(mergeGroupWithReason([])).toEqual({ body: null, reason: 'empty' });
  });
});

describe('Union — union-find over matched pairs', () => {
  it('joins transitively across lanes', () => {
    const u = new Union();
    u.join('osm:1', 'nhd:1'); // the OSM↔NHD lane
    u.join('3dhp:1', 'nhd:1'); // the federal lane
    expect(u.find('osm:1')).toBe(u.find('3dhp:1'));
  });

  it('leaves an unmatched feature as its own root — this is where Beau Lake arrives', () => {
    const u = new Union();
    u.join('osm:1', 'nhd:1');
    expect(u.find('nhd:beau')).toBe('nhd:beau');
  });

  it('survives a chain longer than the call stack', () => {
    // 178,690 features whose chain lengths are set by data we do not control. The recursive `find`
    // this replaced would overflow here — two hours into a merge run, with no partial output.
    const u = new Union();
    for (let i = 0; i < 200_000; i++) u.join(`n${i}`, `n${i + 1}`);
    expect(() => u.find('n0')).not.toThrow();
    expect(u.find('n0')).toBe(u.find('n200000'));
  });
});

describe('the bay rule', () => {
  const parentGrid = (bodies: Merged[]) => index(bodies);

  it('keeps a bay that sits inside a larger body', () => {
    const lake = merged({ key: 'osm:way/lake', polygon: square(-70, 44, 1), areaSqM: 1e9 });
    const bay = merged({
      key: 'osm:way/bay',
      cls: 'bay',
      polygon: square(-69.9, 44.1, 0.05),
      areaSqM: 1e6,
    });
    expect(hasBayParent(bay, parentGrid([lake]))).toBe(true);
  });

  it('demotes Half Moon Cove — named "Cove", 330 acres, contained in nothing', () => {
    const bay = merged({
      cls: 'bay',
      name: 'Half Moon Cove',
      polygon: square(-67, 44.9, 0.02),
      areaSqM: 330 * SQ_M_PER_ACRE,
    });
    expect(hasBayParent(bay, parentGrid([]))).toBe(false);
  });

  it('will not adopt a parent that is merely larger but elsewhere', () => {
    const far = merged({ polygon: square(-60, 40, 1), areaSqM: 1e9 });
    const bay = merged({ cls: 'bay', polygon: square(-70, 44, 0.02), areaSqM: 1e6 });
    expect(hasBayParent(bay, parentGrid([far]))).toBe(false);
  });

  it('⚠ accepts a parent that only shares a bounding box, never a shoreline', () => {
    // **The known weakness, pinned rather than fixed.** `covers()` compares bounding boxes, so an
    // L-shaped or crescent body adopts bays sitting in the empty corner of its box — water it does
    // not touch. 159 bodies currently rest on this rule, so tightening it to polygon containment
    // moves the corpus and is a measurement to take deliberately.
    //
    // The `parent` here is an L drawn along the west and south edges of its box; the `bay` sits in
    // the vacant north-east corner, geometrically disjoint from it.
    const lShape: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-70, 44],
          [-69, 44],
          [-69, 44.2],
          [-69.8, 44.2],
          [-69.8, 45],
          [-70, 45],
          [-70, 44],
        ],
      ],
    };
    const parent = merged({
      key: 'osm:way/L',
      polygon: lShape,
      bbox: bboxOf(lShape),
      areaSqM: 1e9,
    });
    const bay = merged({ cls: 'bay', polygon: square(-69.4, 44.6, 0.05), areaSqM: 1e6 });
    expect(covers(parent.bbox, bay.bbox)).toBe(true);
    expect(hasBayParent(bay, parentGrid([parent]))).toBe(true); // ← false positive, by design for now
  });

  it('requires the parent to be strictly larger', () => {
    const same = merged({ key: 'osm:way/other', polygon: square(-70, 44, 1), areaSqM: 1e6 });
    const bay = merged({ cls: 'bay', polygon: square(-69.9, 44.1, 0.05), areaSqM: 1e6 });
    expect(hasBayParent(bay, parentGrid([same]))).toBe(false);
  });
});

describe('the region clip', () => {
  const maine: Polygon = square(-70, 44, 2);
  const grid = index([{ polygon: maine, bbox: bboxOf(maine) }]);

  it('keeps a body wholly inside', () => {
    expect(
      inRegion({ polygon: square(-69, 45, 0.1), bbox: bboxOf(square(-69, 45, 0.1)) }, grid),
    ).toBe(true);
  });

  it('keeps Beau Lake, which straddles the Québec border — any part, not its centre', () => {
    // Beau Lake is absent from the corpus because Geofabrik clips the Québec half. A centre-based
    // test on a body straddling the border is a coin flip; this one asks the question we mean.
    const straddling = square(-70.5, 45.8, 1); // most of it north/west of the mask
    expect(inRegion({ polygon: straddling, bbox: bboxOf(straddling) }, grid)).toBe(true);
  });

  it('refuses a body wholly outside — the geodatabases are not clipped to their states', () => {
    const quebec = square(-73, 47, 0.5);
    expect(inRegion({ polygon: quebec, bbox: bboxOf(quebec) }, grid)).toBe(false);
  });

  it('samples every outer ring of a MultiPolygon, not only the first', () => {
    const multi: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [square(-80, 40, 0.1).coordinates, square(-69, 45, 0.1).coordinates],
    };
    // The first part is nowhere near the mask; the second is inside it.
    expect(inRegion({ polygon: multi, bbox: bboxOf(multi) }, grid)).toBe(true);
  });

  it('⚠ asks whether the BODY touches the mask, so a body containing the mask is refused', () => {
    // **The structural limit of this test, pinned.** `inRegion` samples the *body's* outline and asks
    // whether any sample lands inside a boundary polygon. That answers "does the body's edge enter
    // the region", which is not the same question as "do the two overlap" — and the two diverge
    // whenever the body's outline lies wholly outside the mask while its interior swallows it.
    //
    // The extreme case is provable: a body that strictly contains the entire mask has every vertex
    // outside it and is judged out of region.
    const containsTheMask = square(-75, 40, 15); // lng -75..-60, lat 40..55 — the mask sits inside
    const insideMask = ([lng, lat]: [number, number]) =>
      lng >= -70 && lng <= -68 && lat >= 44 && lat <= 46;
    expect(sampleOutline(containsTheMask).some(insideMask)).toBe(false);
    expect(inRegion({ polygon: containsTheMask, bbox: bboxOf(containsTheMask) }, grid)).toBe(false);
  });

  it('⚠ samples only 8 points per ring, so a narrow overlap can fall between the samples', () => {
    // The same limit at realistic scale, and the one that matters for the 35,637 bodies excluded on
    // the last run. This body's outline DOES cross the mask — the spike at index 5 reaches lat 44.5,
    // well inside — but with 16 vertices `sampleOutline` steps by 2 and samples only even indices,
    // so the spike is never looked at.
    const spiked: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-69.5, 43.0], // 0  sampled
          [-69.4, 43.0], // 1
          [-69.3, 43.0], // 2  sampled
          [-69.2, 43.0], // 3
          [-69.1, 43.0], // 4  sampled
          [-69.05, 44.5], // 5  ← the only vertex inside the mask, never sampled
          [-69.0, 43.0], // 6  sampled
          [-68.9, 43.0], // 7
          [-68.8, 43.0], // 8  sampled
          [-68.7, 43.0], // 9
          [-68.6, 43.0], // 10 sampled
          [-68.5, 43.0], // 11
          [-68.5, 42.9], // 12 sampled
          [-69.0, 42.9], // 13
          [-69.5, 42.9], // 14 sampled
          [-69.5, 43.0], // 15
        ],
      ],
    };
    const sampled = sampleOutline(spiked);
    expect(sampled).not.toContainEqual([-69.05, 44.5]); // the spike is skipped
    expect(sampled.every(([, lat]) => lat < 44)).toBe(true);
    expect(inRegion({ polygon: spiked, bbox: bboxOf(spiked) }, grid)).toBe(false);
  });

  it('samples about REGION_SAMPLE_POINTS per ring', () => {
    const ring = square(-70, 44, 1);
    expect(sampleOutline(ring).length).toBeLessThanOrEqual(REGION_SAMPLE_POINTS + 1);
    const dense: Polygon = {
      type: 'Polygon',
      coordinates: [
        Array.from({ length: 800 }, (_, i) => [-70 + i / 10000, 44] as [number, number]),
      ],
    };
    expect(sampleOutline(dense).length).toBeLessThanOrEqual(REGION_SAMPLE_POINTS + 1);
  });
});

describe('the downstate cut (D111)', () => {
  const westchester = square(-73.9, 40.9, 0.4);
  const excluded = [{ polygon: westchester, bbox: bboxOf(westchester) }];

  it('refuses a body whose bulk is inside an excluded county', () => {
    const body = square(-73.8, 41.0, 0.02);
    expect(inDownstate({ bbox: bboxOf(body) }, excluded)).toBe(true);
  });

  it('keeps an upstate body', () => {
    const body = square(-74.0, 43.5, 0.02);
    expect(inDownstate({ bbox: bboxOf(body) }, excluded)).toBe(false);
  });

  it('decides a body straddling the line by where its middle sits, not by its edge', () => {
    // Asymmetric with `inRegion` on purpose: that one is generous because a body straddling the
    // Québec border is one we want and only its edge proves it. This one asks whether the body *is*
    // downstate, so a reservoir across the county line is decided by its bulk.
    const mostlyNorth = square(-73.8, 41.25, 0.2); // centre at 41.35, north of the county's 41.3 top
    expect(inDownstate({ bbox: bboxOf(mostlyNorth) }, excluded)).toBe(false);
    const mostlySouth = square(-73.8, 41.05, 0.2); // centre at 41.15, inside
    expect(inDownstate({ bbox: bboxOf(mostlySouth) }, excluded)).toBe(true);
  });
});

describe('the GNIS lane', () => {
  const body = { polygon: square(-70, 44, 0.1), bbox: bboxOf(square(-70, 44, 0.1)) };
  const gridOf = (points: GnisPoint[]) => {
    const g = new Map<string, GnisPoint[]>();
    for (const p of points) {
      const cell = `${Math.floor(p.lng / CELL_DEG)}:${Math.floor(p.lat / CELL_DEG)}`;
      const b = g.get(cell);
      if (b) b.push(p);
      else g.set(cell, [p]);
    }
    return g;
  };

  it('names a body from the one gazetteer point inside it', () => {
    const grid = gridOf([{ lng: -69.95, lat: 44.05, name: 'Cicero Swamp', featureClass: 'Swamp' }]);
    expect(gnisNameFor(body, grid)).toBe('Cicero Swamp');
  });

  it('stays silent when two points fall inside — Great Bay swallows seven', () => {
    // Picking the first would be arbitrary; picking the largest needs an area GNIS does not publish.
    // Ambiguity is a reason to stay unnamed, not to guess.
    const grid = gridOf([
      { lng: -69.95, lat: 44.05, name: 'Great Bay', featureClass: 'Bay' },
      { lng: -69.97, lat: 44.02, name: 'Little Cove', featureClass: 'Bay' },
    ]);
    expect(gnisNameFor(body, grid)).toBeUndefined();
  });

  it('ignores a point inside the bounding box but outside the outline', () => {
    const l: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-70, 44],
          [-69.9, 44],
          [-69.9, 44.02],
          [-69.98, 44.02],
          [-69.98, 44.1],
          [-70, 44.1],
          [-70, 44],
        ],
      ],
    };
    const grid = gridOf([{ lng: -69.93, lat: 44.08, name: 'Not In Here', featureClass: 'Lake' }]);
    expect(gnisNameFor({ polygon: l, bbox: bboxOf(l) }, grid)).toBeUndefined();
  });

  it('returns nothing when the gazetteer has no point here', () => {
    expect(gnisNameFor(body, gridOf([]))).toBeUndefined();
  });
});

describe('drop reasons', () => {
  it('reports a GNIS-named wetland as named, not as unnamed', () => {
    // **The bug this function was extracted to fix.** The reason label read the catalogue name while
    // the refusal was decided against the GNIS-augmented one, so a wetland the gazetteer HAD named
    // was reported as "unnamed wetland under 50 acres" — the one lane whose contribution the report
    // exists to measure, described as absent.
    expect(dropReason({ name: 'Cicero Swamp', cls: 'wetland', areaSqM: 10 * SQ_M_PER_ACRE })).toBe(
      'wetland, named, under floor',
    );
  });

  it('distinguishes the three refusals D96 can make', () => {
    expect(dropReason({ name: '', cls: 'lakePond', areaSqM: 0.5 * SQ_M_PER_ACRE })).toBe(
      'below 1 acre',
    );
    expect(dropReason({ name: '', cls: 'wetland', areaSqM: 20 * SQ_M_PER_ACRE })).toBe(
      'unnamed wetland under 50 acres',
    );
    expect(dropReason({ name: '', cls: 'lakePond', areaSqM: 3 * SQ_M_PER_ACRE })).toBe(
      'unnamed, 1–5 acres',
    );
  });

  it('calls the sub-acre case by size regardless of class', () => {
    expect(dropReason({ name: 'Tiny', cls: 'wetland', areaSqM: 0.9 * SQ_M_PER_ACRE })).toBe(
      'below 1 acre',
    );
  });
});

describe('polygon confidence claims', () => {
  it('scores the chosen outline at 1 and reads the others from either lane direction', () => {
    const group = {
      key: 'osm:way/1',
      geometrySource: 'osm' as ClaimSource,
      members: [feature('osm', 'way/1'), feature('nhd', 'n1'), feature('3dhp', 'd1')],
    };
    // `osm→nhd` stored the pair one way round; the federal lane stored the 3DHP pair the other.
    const iou = new Map([
      ['way/1|n1', 0.91],
      ['d1|way/1', 0.87],
    ]);
    expect(polygonClaims(group, iou)).toEqual([
      { source: 'osm', value: 1 },
      { source: 'nhd', value: 0.91 },
      { source: '3dhp', value: 0.87 },
    ]);
  });

  it('falls back to the match floor rather than inventing agreement upward', () => {
    const group = {
      key: 'osm:way/1',
      geometrySource: 'osm' as ClaimSource,
      members: [feature('osm', 'way/1'), feature('nhd', 'n1')],
    };
    expect(polygonClaims(group, new Map())[1]).toEqual({ source: 'nhd', value: 0.5 });
  });

  it('splits a key on its first colon only, because an OSM id contains a slash', () => {
    expect(idFromKey('osm:way/150404999')).toBe('way/150404999');
    expect(idFromKey('nhd:85383A01-DC89-47AA-BC5D-BE373FB0B5C3')).toBe(
      '85383A01-DC89-47AA-BC5D-BE373FB0B5C3',
    );
    expect(idFromKey('3dhp:MLBCG')).toBe('MLBCG');
  });
});

describe('the emit stage', () => {
  it('takes one id per catalogue, and the gazetteer id from whoever has it', () => {
    const ids = catalogueIdsOf([
      feature('osm', 'way/1'),
      feature('nhd', '141034078', { gnisId: '00869848' }),
      feature('3dhp', 'MLBCG'),
    ]);
    expect(ids).toEqual({
      osmId: 'way/1',
      nhdId: '141034078',
      threeDhpId: 'MLBCG',
      gnisId: '00869848',
    });
  });

  it('takes the first when one catalogue appears twice — safe only because that group is queued', () => {
    // A group holding two OSM features is either a catalogue duplicate or two lakes our matching
    // chained together. `sameSourceDuplicate` flags it for a human; this just must not throw or
    // invent a third id.
    const members = [feature('osm', 'way/1'), feature('osm', 'relation/2')];
    expect(catalogueIdsOf(members).osmId).toBe('way/1');
    expect(mergeGroup(members)?.sameSourceDuplicate).toBe(true);
  });

  it('omits an id no member carries', () => {
    expect(catalogueIdsOf([feature('nhd', 'n1')])).toEqual({ nhdId: 'n1' });
  });

  it('gives a border-spanning body every state it touches, not the first', () => {
    // Champlain is in VT and NY, and "lakes in Vermont" has to find it.
    const vt = square(-73.4, 43.5, 1);
    const ny = square(-74.4, 43.5, 1);
    const grid = index([
      { polygon: vt, bbox: bboxOf(vt), name: 'Vermont' },
      { polygon: ny, bbox: bboxOf(ny), name: 'New York' },
    ]);
    const straddling = square(-73.5, 44.0, 0.4); // crosses the shared edge at -73.4
    expect(statesFor({ polygon: straddling, bbox: bboxOf(straddling) }, grid)).toEqual([
      'NY',
      'VT',
    ]);
  });

  it('returns empty rather than guessing when no state outline claims the body', () => {
    // A wrong state code silently moves a lake into someone else's region filter; a missing one is
    // visible. The mask is built from counties, so a body can clear it and still land in a gap here.
    const vt = square(-73.4, 43.5, 1);
    const grid = index([{ polygon: vt, bbox: bboxOf(vt), name: 'Vermont' }]);
    const elsewhere = square(-60, 40, 0.1);
    expect(statesFor({ polygon: elsewhere, bbox: bboxOf(elsewhere) }, grid)).toEqual([]);
  });

  it('ignores a boundary whose name is not one of the five', () => {
    const qc = square(-73.4, 43.5, 1);
    const grid = index([{ polygon: qc, bbox: bboxOf(qc), name: 'Québec' }]);
    const body = square(-73.0, 44.0, 0.1);
    expect(statesFor({ polygon: body, bbox: bboxOf(body) }, grid)).toEqual([]);
  });
});

describe('the cell grid', () => {
  it('covers every cell a bounding box touches', () => {
    expect(cellsFor({ minLng: -70.05, maxLng: -69.95, minLat: 44.05, maxLat: 44.05 })).toEqual([
      '-701:440',
      '-700:440',
    ]);
  });

  it('indexes a feature into all of its cells, so a large body is findable from any of them', () => {
    const big = square(-70.2, 44, 0.3);
    const grid = index([{ bbox: bboxOf(big) }]);
    expect(grid.size).toBeGreaterThan(1);
    for (const bucket of grid.values()) expect(bucket).toHaveLength(1);
  });

  it('covers() is containment, not intersection', () => {
    const outer = { minLng: -70, maxLng: -69, minLat: 44, maxLat: 45 };
    expect(covers(outer, { minLng: -69.9, maxLng: -69.1, minLat: 44.1, maxLat: 44.9 })).toBe(true);
    expect(covers(outer, { minLng: -69.9, maxLng: -68.5, minLat: 44.1, maxLat: 44.9 })).toBe(false);
    expect(covers(outer, outer)).toBe(true); // a box contains itself
  });
});
