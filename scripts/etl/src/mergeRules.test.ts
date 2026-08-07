/**
 * The master list's decision rules, against named answers (N7).
 *
 * Written to the plan's verification discipline — *"named fixtures, not coverage percentages"*. Every
 * case below is either a body we can name or a failure the campaign actually met, and several of them
 * pin behaviour that is **known to be weaker than it looks**, so that tightening it later is a visible
 * change to a test rather than a silent change to 27,074 rows.
 */

import {
  type BBox,
  type ClaimSource,
  RECONCILE_MIN_IOU_WITH_GNIS,
  sameName,
  type WaterBodyClass,
} from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  type Boundary,
  bayParent,
  CELL_DEG,
  catalogueIdsOf,
  cellsFor,
  chooseClass,
  chooseGeometry,
  chooseName,
  covers,
  dropReason,
  type Feature,
  FRESHWATER_ALLOW_LIST,
  GEOMETRY_OVERRIDES,
  type GnisPoint,
  gnisNameFor,
  hasBayParent,
  idFromKey,
  inDownstate,
  index,
  inRegion,
  inRegionFraction,
  isFreshwaterException,
  isVetoed,
  type LaneDrop,
  LaneLedger,
  type Merged,
  mergeGroup,
  mergeGroupWithReason,
  NAME_MATCH_MIN_IOU,
  nameClaimsOf,
  nameMatchPairs,
  outerRings,
  overlapDuplicates,
  parseLine,
  parseNhdFeature,
  parseOsmFeature,
  parseThreeDhpFeature,
  polygonClaims,
  type RawOsmFeature,
  REGION_SAMPLE_POINTS,
  resolveGnisNames,
  SQ_M_PER_ACRE,
  saltContainment,
  saltMask,
  sampleOutline,
  sampleOutlineDense,
  statesFor,
  Union,
  vetoReason,
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
    // Defaults to `token`, which is what the classifier does whenever no naming rule overrode it.
    // A test that needs them to differ — the veto cases — passes `sourceToken` explicitly.
    sourceToken: over.token ?? `${source}:test`,
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
    absorbedIds: [],
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

  it('catches a Great Lake that only NHD published, though NHD calls it FTYPE 390', () => {
    // **This used to be a pinned gap and is now closed** (N7 audit, founder call 2026-08-06). The
    // token veto holds `3dhp:featuretype=4`, `nhd:ftype=445` and `nhd:ftype=493` — but NHD files
    // **Lake Erie as FTYPE 390, an ordinary LakePond**, and New York borders both Erie and Ontario,
    // so `inRegion` passes them: TIGER's state outline includes New York's share of both. The old
    // refusal was contingent on the 3DHP lane matching and contributing its `featuretype=4`, i.e. on
    // a `polygonIoU` succeeding over the most awkwardly-clipped polygons in the archive.
    //
    // Now the name refuses it, with no match and no second catalogue involved.
    const lakeErieFromNhdAlone = [
      feature('nhd', '999', {
        token: 'nhd:ftype=390',
        cls: 'lakePond',
        name: 'Lake Erie',
        areaSqM: 2.57e10,
      }),
    ];
    expect(vetoReason(lakeErieFromNhdAlone)).toBe('name');
    expect(mergeGroupWithReason(lakeErieFromNhdAlone).reason).toBe('vetoed-name');
  });

  it('catches an UNNAMED ocean-sized polygon on the area ceiling alone', () => {
    // The other half of the same hole: a fragment of a Great Lake or a bay of the Gulf of Maine that
    // nobody named and no catalogue classed as ocean. 100,000 acres, and the only body in our five
    // states above it is Lake Champlain — which is why the allow-list has exactly one entry.
    const unnamedOcean = [
      feature('nhd', '999', { token: 'nhd:ftype=390', cls: 'lakePond', areaSqM: 2.57e10 }),
    ];
    expect(vetoReason(unnamedOcean)).toBe('area');
    expect(mergeGroup(unnamedOcean)).toBeNull();
  });

  it('lets Lake Champlain through the ceiling, on any catalogue’s spelling of the name', () => {
    // ~271,000 acres, the largest body we cover, and the reason the allow-list exists at all. The
    // name is checked across **every** member: three catalogues spell it three ways and testing only
    // the first named one would veto Champlain on whichever ordering the union-find produced.
    const champlain = [
      feature('osm', 'relation/1', { cls: 'lakePond', name: '', areaSqM: 1.1e9 }),
      feature('nhd', 'c1', { cls: 'lakePond', name: 'Lake Champlain', areaSqM: 1.1e9 }),
    ];
    expect(vetoReason(champlain)).toBeUndefined();
    expect(mergeGroup(champlain)?.name).toBe('Lake Champlain');
  });

  it('reads the CATALOGUE token, so a naming rule cannot launder a vetoed feature', () => {
    // `classifyWaterBody` returns early with `token: 'name:reservoir'` when a name says reservoir,
    // which used to discard the only evidence that the feature was a tidal estuary. The veto now
    // reads `sourceToken`, which no rung of the ladder overwrites.
    const launderedEstuary = [
      feature('nhd', '1', {
        token: 'name:reservoir',
        sourceToken: 'nhd:ftype=493',
        cls: 'reservoir',
        name: 'Tidewater Reservoir',
      }),
    ];
    expect(vetoReason(launderedEstuary)).toBe('token');
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

  it('prefers the authoritative name over the longer one', () => {
    // **The rule this replaced was longest-wins**, defended as "right when the catalogues disagree
    // about which lake this is". That is backwards: if they disagree about which lake this is, the
    // merge is already wrong and the longer string entrenches the error under a more confident
    // label. NHD's `gnis_name` column IS the gazetteer; OSM's `name` is a mapper's free text.
    expect(
      chooseName([
        feature('osm', 'a', { name: 'Little Moose Pond' }),
        feature('nhd', 'b', { name: 'Moose Pond' }),
      ]),
    ).toBe('Moose Pond');
  });

  it('ranks gnis over nhd over 3dhp over osm', () => {
    const all = [
      feature('osm', 'a', { name: 'Osm Name' }),
      feature('3dhp', 'b', { name: 'Dhp Name' }),
      feature('nhd', 'c', { name: 'Nhd Name' }),
    ];
    expect(chooseName(all)).toBe('Nhd Name');
    expect(chooseName(all.slice(0, 2))).toBe('Dhp Name');
    expect(chooseName(all.slice(0, 1))).toBe('Osm Name');
  });

  it('still prefers the longer name INSIDE one source, where authority cannot separate them', () => {
    // A `sameSourceDuplicate` group holds two features from one catalogue; rank ties, so length is
    // the only tie-break left and it is as good as any.
    expect(
      chooseName([
        feature('osm', 'a', { name: 'Moose Pond' }),
        feature('osm', 'b', { name: 'Little Moose Pond' }),
      ]),
    ).toBe('Little Moose Pond');
  });

  it('is decided by rank, not by arrival order, so a stable input gives a stable name', () => {
    // Two equal-length names from different catalogues: rank separates them, and it does so the same
    // way whichever order the union-find produced. Under longest-wins this was an arrival-order
    // tie-break, i.e. a name chosen by the shape of someone else's loop.
    const osmFirst = [
      feature('osm', 'a', { name: 'Mud Pond' }),
      feature('nhd', 'b', { name: 'Cub Pond' }),
    ];
    expect(chooseName(osmFirst)).toBe('Cub Pond');
    expect(chooseName([...osmFirst].reverse())).toBe('Cub Pond');
  });

  it('is empty when nobody named it — the 92% case', () => {
    expect(chooseName([feature('osm', 'a'), feature('nhd', 'b')])).toBe('');
  });
});

describe('nameClaimsOf', () => {
  // Auburn's own water supply, and the fixture for the whole change: NHD's `gnis_name` is
  // "The Basin", OSM calls it "Lake Auburn", authority stores the former — and until the losing
  // claim was kept, a skater typing "Lake Auburn" found nothing at all.
  it('keeps the losing name beside the winning one', () => {
    expect(
      nameClaimsOf([
        feature('osm', 'a', { name: 'Lake Auburn' }),
        feature('nhd', 'b', { name: 'The Basin' }),
      ]),
    ).toEqual([
      { source: 'nhd', value: 'The Basin' },
      { source: 'osm', value: 'Lake Auburn' },
    ]);
  });

  // The reason this sorts before deduping. `distinctNameClaims` keeps the FIRST source it sees for a
  // spelling, so member order would credit a name both federal lanes publish to whichever feature
  // the union-find happened to put first — grid iteration order, which is the exact nondeterminism
  // `NAME_SOURCE_RANK` was introduced to remove from `chooseName`.
  it('credits a shared spelling to the most authoritative source, whatever the input order', () => {
    const members = [
      feature('3dhp', 'a', { name: 'Long Pond' }),
      feature('nhd', 'b', { name: 'Long Pond' }),
    ];
    expect(nameClaimsOf(members)).toEqual([{ source: 'nhd', value: 'Long Pond' }]);
    expect(nameClaimsOf([...members].reverse())).toEqual([{ source: 'nhd', value: 'Long Pond' }]);
  });

  it('appends the gazetteer name as a gnis claim, ranked first', () => {
    // It has no member to belong to: it is what `resolveGnisNames` supplied for a body no catalogue
    // named, and the ordering rule still has to place it.
    expect(nameClaimsOf([feature('osm', 'a', { name: 'The Bog' })], 'Cicero Swamp')).toEqual([
      { source: 'gnis', value: 'Cicero Swamp' },
      { source: 'osm', value: 'The Bog' },
    ]);
  });

  it('ignores a gazetteer name that was not used', () => {
    expect(nameClaimsOf([feature('osm', 'a', { name: 'Mud Pond' })], undefined)).toEqual([
      { source: 'osm', value: 'Mud Pond' },
    ]);
    expect(nameClaimsOf([feature('osm', 'a', { name: 'Mud Pond' })], '')).toEqual([
      { source: 'osm', value: 'Mud Pond' },
    ]);
  });

  it('is empty for the 92% of bodies nobody named', () => {
    expect(nameClaimsOf([feature('osm', 'a'), feature('nhd', 'b')])).toEqual([]);
  });

  // Two OSM features in one `sameSourceDuplicate` group can carry two real spellings, and both are
  // worth searching under — this is not the same question as which one displays.
  it('keeps two spellings from one catalogue', () => {
    expect(
      nameClaimsOf([
        feature('osm', 'a', { name: 'Moose Pond' }),
        feature('osm', 'b', { name: 'Little Moose Pond' }),
      ]),
    ).toEqual([
      { source: 'osm', value: 'Moose Pond' },
      { source: 'osm', value: 'Little Moose Pond' },
    ]);
  });
});

describe('geometry selection (provisional, pending D92)', () => {
  it('prefers OSM, then NHD, then whatever is left', () => {
    expect(chooseGeometry([feature('nhd', 'n'), feature('osm', 'o')])?.source).toBe('osm');
    expect(chooseGeometry([feature('3dhp', 'd'), feature('nhd', 'n')])?.source).toBe('nhd');
    expect(chooseGeometry([feature('3dhp', 'd')])?.source).toBe('3dhp');
  });

  it('honours the Beau Lake override — the fixture this phase is named for', () => {
    // Maine's own record says **1,788 acres** and Wikipedia says 7.23 km² (= 1,786 ac); two
    // independent sources agreeing to within a percent. NHD's archived polygon is 7.594 km² =
    // 1,876.6 ac, ~5% over. OSM merges it at 2,457 ac — 37% over, because Geofabrik clips the
    // Québec half and what is left is traced together with the water above the narrows.
    const BEAU = '85383a01-dc89-47aa-bc5d-be373fb0b5c3';
    expect(GEOMETRY_OVERRIDES.get(`nhd:${BEAU}`)).toBe('nhd');
    const members = [
      feature('osm', 'relation/9724056', { areaSqM: 2456.9 * SQ_M_PER_ACRE }),
      feature('nhd', BEAU, { areaSqM: 1876.6 * SQ_M_PER_ACRE }),
    ];
    const body = mergeGroup(members);
    expect(body?.geometrySource).toBe('nhd');
    // The stored area is the chosen polygon's, so the override moves the acreage too (D94).
    expect((body?.areaSqM ?? 0) / SQ_M_PER_ACRE).toBeCloseTo(1876.6, 0);
    // …and it lands within 5% of the two agreeing published figures, where OSM was 37% out.
    expect(Math.abs((body?.areaSqM ?? 0) / SQ_M_PER_ACRE - 1788) / 1788).toBeLessThan(0.05);
  });

  it('ignores a stale override rather than failing the run', () => {
    // The table is keyed `<source>:<id>` and a group can lose the member an entry names between
    // runs — a re-published NHD id, a match that stopped scoring. A stale entry must degrade to the
    // default, not kill a 25,000-body pass.
    const stale: ReadonlyMap<string, ClaimSource> = new Map([['nhd:gone', 'nhd' as ClaimSource]]);
    expect(chooseGeometry([feature('osm', 'way/1')], stale)?.source).toBe('osm');
  });

  it('falls back to the default when the override names a source the group does not have', () => {
    // The entry matched, but the preferred catalogue is not in this group. Preferring nothing over
    // a body would be worse than preferring the wrong outline.
    const overrides: ReadonlyMap<string, ClaimSource> = new Map([
      ['osm:way/1', '3dhp' as ClaimSource],
    ]);
    const members = [feature('osm', 'way/1'), feature('nhd', 'n1')];
    expect(chooseGeometry(members, overrides)?.source).toBe('osm');
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

  it('refuses a parent that only shares a bounding box, never a shoreline', () => {
    // **This used to be a pinned false positive and is now closed** (N7 audit). `covers()` compared
    // bounding boxes, so an L-shaped or crescent body adopted bays sitting in the empty corner of
    // its box — water it does not touch. The box test is now only a prefilter, and the answer comes
    // from `BAY_PARENT_MIN_CONTAINMENT` of the bay's own outline.
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
    // The box still contains it — which is exactly why the box was never the right test.
    expect(covers(parent.bbox, bay.bbox)).toBe(true);
    expect(hasBayParent(bay, parentGrid([parent]))).toBe(false);
  });

  it('keeps a bay whose outline pokes just outside its parent, which `covers` used to demote', () => {
    // **The costlier half of the same bug.** `covers()` demanded *full* box containment, so a bay
    // traced by OSM against a parent drawn by NHD lost its parent over a single vertex a few metres
    // past the box — and was demoted to `unclassified` for a reason that has nothing to do with
    // whether it is a bay. The containment bar is a fraction, so one stray vertex costs nothing.
    const lake = merged({
      key: 'osm:way/lake',
      polygon: square(-70, 44, 0.1),
      areaSqM: 1e9,
    });
    // Almost wholly inside the lake, with one vertex a few hundred metres past its western shore —
    // the ordinary case when two publishers trace the same coast.
    const pokesOut: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-69.98, 44.02],
          [-69.95, 44.02],
          [-69.95, 44.05],
          [-69.98, 44.05],
          [-70.01, 44.035], // ← outside the parent
          [-69.98, 44.02],
        ],
      ],
    };
    const bay = merged({
      cls: 'bay',
      key: 'osm:way/bay',
      polygon: pokesOut,
      bbox: bboxOf(pokesOut),
      areaSqM: 1e6,
    });
    expect(covers(lake.bbox, bay.bbox)).toBe(false); // the old test would have demoted it
    expect(hasBayParent(bay, parentGrid([lake]))).toBe(true);
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

  it('escalates to every vertex rather than dropping a body the 8 samples missed', () => {
    // **This used to be a pinned false negative and is now closed** (N7 audit), and it is the one
    // that mattered: 35,637 bodies were excluded on this test with nothing recording which. This
    // body's outline DOES cross the mask — the spike at index 5 reaches lat 44.5, well inside — but
    // with 16 vertices `sampleOutline` steps by 2 and samples only even indices, so the fast path
    // never looks at it. A sampled `true` is a proof; a sampled `false` never was.
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
    expect(sampled).not.toContainEqual([-69.05, 44.5]); // the fast path still skips the spike…
    expect(sampled.every(([, lat]) => lat < 44)).toBe(true);
    expect(inRegion({ polygon: spiked, bbox: bboxOf(spiked) }, grid)).toBe(true); // …and it is found
  });

  it('still refuses a body nowhere near the mask, without walking its vertices', () => {
    // The escalation is bounded by a bbox-vs-occupied-cells gate, which is what keeps it affordable:
    // a Pennsylvania pond in the New York geodatabase — the overwhelming majority of the 35,637 —
    // exits before any vertex is tested.
    const far = square(-100, 30, 0.5);
    expect(inRegion({ polygon: far, bbox: bboxOf(far) }, grid)).toBe(false);
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
    const grid = gridOf([
      { lng: -69.95, lat: 44.05, name: 'Cicero Swamp', featureClass: 'Swamp', featureId: '966086' },
    ]);
    // Returns the id alongside the name now — D105's other half, which the lane was specified for
    // and never read. It fills `gnisId` only where no catalogue in the group asserted one.
    expect(gnisNameFor(body, grid)).toEqual({ name: 'Cicero Swamp', featureId: '966086' });
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
    const chosen = square(-70, 44, 0.01);
    const group = {
      key: 'osm:way/1',
      geometrySource: 'osm' as ClaimSource,
      polygon: chosen,
      members: [
        feature('osm', 'way/1', { polygon: chosen }),
        feature('nhd', 'n1'),
        feature('3dhp', 'd1'),
      ],
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

  it('computes the pair for a transitive member instead of substituting the match floor', () => {
    // **The correction the audit forced.** A 3DHP feature that reached the group through NHD was
    // never compared to the OSM outline, so neither lane direction has an entry — and the old code
    // substituted `RECONCILE_MIN_IOU` (0.5), which sits *below* `POLYGON_DISAGREE_IOU` (0.7). Every
    // three-catalogue body therefore scored its polygon `low` by construction: a statement about
    // which lane ran, published as a statement about the data.
    const chosen = square(-70, 44, 0.01);
    const group = {
      key: 'osm:way/1',
      geometrySource: 'osm' as ClaimSource,
      polygon: chosen,
      members: [
        feature('osm', 'way/1', { polygon: chosen }),
        // Identical outline, no map entry: the honest answer is 1, not the floor.
        feature('3dhp', 'd1', { polygon: square(-70, 44, 0.01) }),
      ],
    };
    const claims = polygonClaims(group, new Map());
    expect(claims[0]).toEqual({ source: 'osm', value: 1 });
    expect(claims[1]?.value).toBeCloseTo(1, 3);
  });

  it('reports a genuinely disagreeing transitive member as disagreeing', () => {
    const chosen = square(-70, 44, 0.01);
    const group = {
      key: 'osm:way/1',
      geometrySource: 'osm' as ClaimSource,
      polygon: chosen,
      members: [
        feature('osm', 'way/1', { polygon: chosen }),
        // Offset by half a side: real overlap, well under the agreement bar.
        feature('nhd', 'n1', { polygon: square(-69.995, 44, 0.01) }),
      ],
    };
    const value = polygonClaims(group, new Map())[1]?.value ?? 1;
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(0.7);
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

  it('breaks a tie toward the first when one catalogue appears twice at the same size', () => {
    // A group holding two OSM features is either a catalogue duplicate or two lakes our matching
    // chained together. `sameSourceDuplicate` flags it for a human; this just must not throw or
    // invent a third id. Equal areas, so the tie-break is what is being pinned.
    const members = [feature('osm', 'way/1'), feature('osm', 'relation/2')];
    expect(catalogueIdsOf(members).osmId).toBe('way/1');
    expect(mergeGroup(members)?.sameSourceDuplicate).toBe(true);
  });

  it('takes the LARGEST when one catalogue appears twice at different sizes — the Indian Lake case', () => {
    // Measured on the 2026-08-06 run: Indian Lake, NY was stored at **534 acres** from OSM while OSM
    // also carried a 3,742-acre feature for it and NHD/3DHP both said 4,296. `find()` took whichever
    // arrived first, which is the order the extracts happened to stream in — so the corpus was about
    // to hold an eighth of a real Adirondack lake, and a fragment under-draws silently where a wrong
    // outline at least looks wrong.
    const members = [
      feature('osm', 'way/fragment', { areaSqM: 534 * SQ_M_PER_ACRE }),
      feature('osm', 'relation/whole', { areaSqM: 3742 * SQ_M_PER_ACRE }),
      feature('nhd', 'n1', { areaSqM: 4296 * SQ_M_PER_ACRE }),
    ];
    expect(chooseGeometry(members)?.id).toBe('relation/whole');
    expect(catalogueIdsOf(members).osmId).toBe('relation/whole');
    // …and the id it did NOT take is named rather than vanishing.
    expect(mergeGroup(members)?.absorbedIds).toEqual(['osm:way/fragment']);
  });

  it('keeps the geometry source rule while doing it — largest WITHIN a source, not across', () => {
    // D92 says OSM by default; D94 says never take the larger of two area claims. Both still hold:
    // the choice between catalogues is unchanged, and only ties within one catalogue are resolved.
    const members = [
      feature('osm', 'way/1', { areaSqM: 10 * SQ_M_PER_ACRE }),
      feature('nhd', 'n1', { areaSqM: 900 * SQ_M_PER_ACRE }),
    ];
    expect(chooseGeometry(members)?.source).toBe('osm');
    expect(mergeGroup(members)?.areaSqM).toBe(10 * SQ_M_PER_ACRE);
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

// ─────────────────────────────────────────────────────────────────────────────
// The lanes — where the audit found five silent exits
// ─────────────────────────────────────────────────────────────────────────────

describe('the lanes', () => {
  /** A ring big enough to clear the one-acre floor: ~0.003° ≈ 330 m at 44°N, ~27 acres. */
  const bigEnough = () => square(-70, 44, 0.003);
  /** ~0.0005° ≈ 55 m — well under an acre. */
  const tooSmall = () => square(-70, 44, 0.0005);

  describe('parseLine', () => {
    it('reads a record', () => {
      expect(parseLine<{ a: number }>('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    });

    it('counts a malformed line instead of swallowing it', () => {
      // This was `try { … } catch { continue }` — invisible, and exactly how a truncated extract
      // would report as a region with fewer lakes rather than as a broken file.
      const out = parseLine('{"a":');
      expect(out.ok).toBe(false);
      expect((out as LaneDrop).reason).toBe('unparseable');
      expect((out as LaneDrop).sample).toContain('{"a":');
    });
  });

  describe('the OSM lane', () => {
    const raw = (over: Partial<RawOsmFeature['properties']> = {}, geom = bigEnough()) => ({
      properties: { '@type': 'way', '@id': 1, natural: 'water', water: 'lake', ...over },
      geometry: geom,
    });

    it('classifies an ordinary lake', () => {
      const out = parseOsmFeature(raw({ name: 'Beau Lake' }), new Set());
      expect(out.ok).toBe(true);
      const f = (out as { ok: true; feature: Feature }).feature;
      expect(f).toMatchObject({ source: 'osm', id: 'way/1', name: 'Beau Lake', cls: 'lakePond' });
    });

    it('captures gnis:feature_id, normalised — the tag the transform never read', () => {
      // 35.3% of named OSM water features carry one, and the stored corpus has none, which is why
      // the GNIS-assisted reconciliation bar has never once fired.
      const out = parseOsmFeature(raw({ 'gnis:feature_id': '00869848' }), new Set());
      expect((out as { ok: true; feature: Feature }).feature.gnisId).toBe('869848');
    });

    it('carries the catalogue token separately from the decided one', () => {
      const out = parseOsmFeature(raw({ name: 'Sugar Hill Reservoir' }), new Set());
      const f = (out as { ok: true; feature: Feature }).feature;
      expect(f.token).toBe('name:reservoir'); // the name outranked the tag
      expect(f.sourceToken).toBe('osm:water=lake'); // …and the tag survived anyway
    });

    it('counts a feature with no @type/@id rather than skipping it', () => {
      const out = parseOsmFeature(
        { properties: { natural: 'water' }, geometry: bigEnough() },
        new Set(),
      );
      expect((out as LaneDrop).reason).toBe('no-id');
    });

    it('counts a feature with no geometry', () => {
      const out = parseOsmFeature({ properties: raw().properties, geometry: null }, new Set());
      expect((out as LaneDrop).reason).toBe('no-geometry');
    });

    it('counts the border duplicate rather than skipping it — five extracts overlap', () => {
      const seen = new Set<string>();
      expect(parseOsmFeature(raw(), seen).ok).toBe(true);
      const second = parseOsmFeature(raw(), seen);
      expect((second as LaneDrop).reason).toBe('duplicate');
    });

    it('counts the one-acre floor — the largest filter in the pipeline, previously silent', () => {
      // ~64% of every raw OSM feature fails this, and until the audit it emitted no number at all.
      const out = parseOsmFeature(raw({}, tooSmall()), new Set());
      expect((out as LaneDrop).reason).toBe('below-hard-floor');
    });
  });

  describe('the NHD lane', () => {
    const GUID = '85383a01-dc89-47aa-bc5d-be373fb0b5c3';
    const raw = (over: Record<string, unknown> = {}, geom = bigEnough()) => ({
      properties: {
        permanent_identifier: GUID,
        gnis_name: 'Beau Lake',
        gnis_id: '00869848',
        ftype: 390,
        fcode: 39004,
        ...over,
      },
      geometry: geom,
    });

    it('classifies a LakePond and normalises both ids', () => {
      const out = parseNhdFeature(raw(), new Set());
      expect((out as { ok: true; feature: Feature }).feature).toMatchObject({
        source: 'nhd',
        id: GUID,
        name: 'Beau Lake',
        cls: 'lakePond',
        gnisId: '869848',
      });
    });

    it('reads a plain numeric permanent_identifier — 84.4% of the archive', () => {
      const out = parseNhdFeature(raw({ permanent_identifier: '141034078' }), new Set());
      expect((out as { ok: true; feature: Feature }).feature.id).toBe('141034078');
    });

    it('rejects the gnis_id = -1 sentinel rather than joining 855 lakes onto one body', () => {
      const out = parseNhdFeature(raw({ gnis_id: '-1' }), new Set());
      expect((out as { ok: true; feature: Feature }).feature.gnisId).toBeUndefined();
    });

    it('counts an unusable id AND reports it to the id ledger', () => {
      // Two instruments, two questions: the lane ledger says where the row went, the DropLedger says
      // whether the *rule* is still right. This exit used to be a bare `continue`.
      const seenReasons: string[] = [];
      const out = parseNhdFeature(
        raw({ permanent_identifier: 'not-an-id' }),
        new Set(),
        (_r, o) => {
          if (!o.ok) seenReasons.push(o.reason);
        },
      );
      expect((out as LaneDrop).reason).toBe('unusable-id');
      expect(seenReasons).toEqual(['malformed']);
    });

    it('counts the cross-file duplicate — the five geodatabases overlap heavily', () => {
      const seen = new Set<string>();
      expect(parseNhdFeature(raw(), seen).ok).toBe(true);
      expect((parseNhdFeature(raw(), seen) as LaneDrop).reason).toBe('duplicate');
    });

    it('drops a sewage treatment pond by FCODE, and says so in the token', () => {
      const out = parseNhdFeature(raw({ ftype: 436, fcode: 43612 }), new Set());
      const f = (out as { ok: true; feature: Feature }).feature;
      expect(f.cls).toBeNull();
      expect(f.sourceToken).toBe('nhd:fcode=43612');
    });
  });

  describe('the 3DHP lane', () => {
    const raw = (over: Record<string, unknown> = {}, geom = bigEnough()) => ({
      properties: {
        id3dhp: 'MLBCG',
        gnisid: 561883,
        gnisidlabel: 'Beau Lake',
        featuretype: 3,
        ...over,
      },
      geometry: geom,
    });

    it('classifies a Lake and normalises the integer GNIS id', () => {
      const out = parseThreeDhpFeature(raw(), new Set());
      expect((out as { ok: true; feature: Feature }).feature).toMatchObject({
        source: '3dhp',
        id: 'MLBCG',
        cls: 'lakePond',
        gnisId: '561883',
      });
    });

    it('refuses the ocean class with the token the veto reads', () => {
      const out = parseThreeDhpFeature(raw({ featuretype: 4, gnisidlabel: '' }), new Set());
      const f = (out as { ok: true; feature: Feature }).feature;
      expect(f.cls).toBeNull();
      expect(f.sourceToken).toBe('3dhp:featuretype=4');
      expect(vetoReason([f])).toBe('token');
    });

    it('counts a missing id3dhp, though the archive audits as a clean primary key', () => {
      const out = parseThreeDhpFeature(
        { properties: { featuretype: 3 }, geometry: bigEnough() },
        new Set(),
      );
      expect((out as LaneDrop).reason).toBe('no-id');
    });

    it('counts a duplicate id3dhp — a real finding, not an expected overlap', () => {
      const seen = new Set<string>();
      expect(parseThreeDhpFeature(raw(), seen).ok).toBe(true);
      expect((parseThreeDhpFeature(raw(), seen) as LaneDrop).reason).toBe('duplicate');
    });
  });

  describe('LaneLedger', () => {
    it('balances kept + dropped against seen — the equation the report is built on', () => {
      const ledger = new LaneLedger();
      const seen = new Set<string>();
      const props = { '@type': 'way', '@id': 1, natural: 'water', water: 'lake' };
      ledger.record(parseOsmFeature({ properties: props, geometry: bigEnough() }, seen));
      ledger.record(parseOsmFeature({ properties: props, geometry: bigEnough() }, seen)); // dup
      ledger.record(parseOsmFeature({ properties: props, geometry: tooSmall() }, new Set()));
      expect(ledger.seen).toBe(3);
      expect(ledger.kept).toBe(1);
      expect(ledger.dropped).toBe(2);
      expect(ledger.balances()).toBe(true);
    });

    it('samples the raw values so a failure is diagnosable from the run row', () => {
      const ledger = new LaneLedger();
      for (let i = 0; i < 20; i++) ledger.record(parseLine('nope') as LaneDrop);
      const entry = ledger.entries()[0];
      expect(entry?.reason).toBe('unparseable');
      expect(entry?.count).toBe(20);
      expect(entry?.samples).toHaveLength(5); // bounded — a run row must stay small
    });

    it('flattens to run-row counts', () => {
      const ledger = new LaneLedger();
      ledger.record(parseLine('nope') as LaneDrop);
      expect(ledger.counts_('osm')).toEqual([
        { name: 'osm.seen', value: 1 },
        { name: 'osm.kept', value: 0 },
        { name: 'osm.dropped.unparseable', value: 1 },
      ]);
    });
  });
});

describe('how much of a body is actually ours', () => {
  const mask = square(-70, 44, 2); // lng -70..-68, lat 44..46
  const grid = index<Boundary>([{ polygon: mask, bbox: bboxOf(mask) }]);

  it('is 1 for a body wholly inside', () => {
    const body = square(-69.5, 44.5, 0.1);
    expect(inRegionFraction({ polygon: body, bbox: bboxOf(body) }, grid)).toBe(1);
  });

  it('is 0 for a body wholly outside — kept only if `inRegion` found some other vertex', () => {
    const body = square(-60, 30, 0.1);
    expect(inRegionFraction({ polygon: body, bbox: bboxOf(body) }, grid)).toBe(0);
  });

  it('is a fraction for a border-straddler like Beau Lake, which is the whole point', () => {
    // `inRegion` admits on ONE in-region vertex, so a body most of which is in Québec enters at its
    // full area and nothing said so. This is the number that says so.
    const straddles = square(-70.05, 43.95, 0.1); // its NE corner reaches into the mask
    const f = inRegionFraction({ polygon: straddles, bbox: bboxOf(straddles) }, grid);
    expect(f).toBeGreaterThan(0);
    expect(f).toBeLessThan(1);
  });
});

describe('an explicit refusal beats another source’s silence', () => {
  it('refuses a 3DHP river that OSM merely drew without saying what it is', () => {
    // **The audit's finding.** `chooseClass` looked only at the non-null classes, and a drop
    // contributes none — so `featuretype=1 River` (explicit) lost to `natural=water` with no subtag
    // (silence, which classifies as `unclassified`) and the river was admitted as unclassified water.
    // The layer below already ranks drop above silent *within* one source (`strongerClaim`); this is
    // the same rule across sources.
    const group = [
      feature('osm', 'way/1', { cls: 'unclassified', token: 'osm:natural=water' }),
      feature('3dhp', 'd1', { cls: null, token: '3dhp:featuretype=1' }),
    ];
    expect(chooseClass(group)).toBeNull();
    expect(mergeGroupWithReason(group).reason).toBe('refused-over-silence');
  });

  it('still loses to a real class — the 123-body rescue is untouched', () => {
    // The whole reason the merge exists: one source refusing must not delete a body another source
    // positively identifies. Only *silence* loses to a refusal.
    const group = [
      feature('osm', 'way/1', { cls: null, token: 'osm:water=river' }),
      feature('nhd', 'n1', { cls: 'lakePond', token: 'nhd:ftype=390', name: 'Kingdom Bog' }),
    ];
    expect(chooseClass(group)).toBe('lakePond');
  });

  it('leaves an all-silent group as unclassified, which is a real answer', () => {
    const group = [
      feature('osm', 'way/1', { cls: 'unclassified' }),
      feature('nhd', 'n1', { cls: 'unclassified' }),
    ];
    expect(chooseClass(group)).toBe('unclassified');
  });

  it('separates "nobody called it water" from "somebody refused it"', () => {
    // Two different findings: `no-class` may mean the classifier has a hole and is worth
    // investigating; `refused-over-silence` is a rule working. Adding them together hides the first.
    const allRefused = [
      feature('osm', 'way/1', { cls: null, token: 'osm:water=river' }),
      feature('nhd', 'n1', { cls: null, token: 'nhd:fcode=43612' }),
    ];
    expect(mergeGroupWithReason(allRefused).reason).toBe('no-class');
  });
});

describe('the GNIS lane, extended', () => {
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

  it('accepts a point just outside the outline — GNIS places many at the outlet', () => {
    // Zero tolerance was silently costing matches: GNIS publishes one coordinate per feature and for
    // water it is often the outlet, which lands on the shoreline — and a shoreline traced by a
    // different publisher puts it a few tens of metres outside as often as not. A miss here does not
    // merely leave a body unnamed; for a 5–50 acre wetland it deletes the body (D96).
    const justOutside = gridOf([
      { lng: -70.0005, lat: 44.05, name: 'Outlet Pond', featureClass: 'Lake' },
    ]);
    expect(gnisNameFor(body, justOutside)?.name).toBe('Outlet Pond');
  });

  it('refuses a point well outside, so the buffer is a tolerance and not a radius', () => {
    const wellOutside = gridOf([
      { lng: -70.01, lat: 44.05, name: 'Next Lake Over', featureClass: 'Lake' },
    ]);
    expect(gnisNameFor(body, wellOutside)).toBeUndefined();
  });

  it('prefers a point inside over several in the buffer, so a big body is not made ambiguous', () => {
    const mixed = gridOf([
      { lng: -69.95, lat: 44.05, name: 'The Lake', featureClass: 'Lake' },
      { lng: -70.0005, lat: 44.02, name: 'A Cove', featureClass: 'Bay' },
      { lng: -70.0005, lat: 44.08, name: 'Another Cove', featureClass: 'Bay' },
    ]);
    expect(gnisNameFor(body, mixed)?.name).toBe('The Lake');
  });

  it('stays unnamed when two points sit in the buffer and none inside', () => {
    const twoNear = gridOf([
      { lng: -70.0005, lat: 44.02, name: 'A Cove', featureClass: 'Bay' },
      { lng: -70.0005, lat: 44.08, name: 'Another Cove', featureClass: 'Bay' },
    ]);
    expect(gnisNameFor(body, twoNear)).toBeUndefined();
  });
});

describe('the gazetteer’s own id', () => {
  it('fills gnisId when no catalogue asserted one', () => {
    expect(catalogueIdsOf([feature('osm', 'way/1')], '966086').gnisId).toBe('966086');
  });

  it('never overrules a catalogue — a catalogue names THIS feature, the gazetteer names a place', () => {
    // The ordering matters because `gnisId` is documented as a candidate generator rather than an
    // identity: 92 GNIS ids resolve to more than one NHD body. A geometric location must not get to
    // overwrite a publisher's own assertion about which feature this is.
    const withCatalogueId = [feature('nhd', 'n1', { gnisId: '869848' })];
    expect(catalogueIdsOf(withCatalogueId, '966086').gnisId).toBe('869848');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The second intake audit (2026-08-06) — D118–D124
// ─────────────────────────────────────────────────────────────────────────────

describe('the ocean name veto is gated on area', () => {
  const acres = (n: number) => n * SQ_M_PER_ACRE;

  it('refuses the real Lake Erie, which NHD publishes as a LakePond', () => {
    expect(
      vetoReason([feature('nhd', 'x', { name: 'Lake Erie', areaSqM: acres(6_400_000) })]),
    ).toBe('name');
  });

  it('keeps Lake Superior, New York — 179 acres in Sullivan County', () => {
    // The name-only rule deleted this, and left `+1` on a counter as the only trace.
    expect(
      vetoReason([feature('osm', 'way/1', { name: 'Lake Superior', areaSqM: acres(179) })]),
    ).toBeUndefined();
  });

  it('keeps Little Lake Erie, a 4-acre reservoir the substring rule matched', () => {
    expect(
      vetoReason([feature('osm', 'way/2', { name: 'Little Lake Erie', areaSqM: acres(4) })]),
    ).toBeUndefined();
  });

  it('reads the LARGEST member, so one catalogue under-drawing an ocean cannot smuggle it in', () => {
    // A group where OSM traces a fragment and NHD has the whole thing. The area gate must see NHD's.
    expect(
      vetoReason([
        feature('osm', 'way/3', { name: 'Lake Ontario', areaSqM: acres(400) }),
        feature('nhd', 'n1', { name: '', areaSqM: acres(4_700_000) }),
      ]),
    ).toBe('name');
  });
});

describe('no salt water', () => {
  /** A federal salt polygon: the token is what `saltMask` selects on. */
  const sea = (id: string, polygon: Polygon, name = '') =>
    feature('nhd', id, { name, polygon, bbox: bboxOf(polygon), sourceToken: 'nhd:ftype=493' });

  it('selects the tidal classes from features the lanes already loaded', () => {
    const mask = saltMask([
      sea('estuary', square(-70, 44, 0.1)),
      feature('nhd', 'lake', { sourceToken: 'nhd:ftype=390' }),
      feature('3dhp', 'ocean', { sourceToken: '3dhp:featuretype=4', name: 'Atlantic Ocean' }),
    ]);
    expect(mask.map((m) => m.id)).toEqual(['estuary', 'ocean']);
  });

  it('keeps the Great Lakes OUT of the mask, because they are fresh', () => {
    // `3dhp:featuretype=4` is spelled "Ocean **or Great Lake**", and masking with it flagged
    // Braddock Bay and Blind Sodus Bay — freshwater embayments of Lake Ontario that people skate.
    const mask = saltMask([
      feature('3dhp', 'ontario', { sourceToken: '3dhp:featuretype=4', name: 'Lake Ontario' }),
      feature('3dhp', 'atlantic', { sourceToken: '3dhp:featuretype=4', name: 'Atlantic Ocean' }),
    ]);
    expect(mask.map((m) => m.id)).toEqual(['atlantic']);
  });

  it('refuses a cove inside a federal estuary — the Great Bay case', () => {
    // The token veto cannot catch this: one estuary polygon against forty separate OSM coves never
    // reaches IoU 0.5, so the estuary never lands in the cove's group.
    const grid = index([sea('estuary', square(-70.9, 43.0, 0.2))]);
    const cove = merged({ polygon: square(-70.85, 43.05, 0.01) });
    expect(saltContainment({ polygon: cove.polygon, bbox: cove.bbox }, grid)).toBe(1);
  });

  it('leaves an inland lake alone', () => {
    const grid = index([sea('estuary', square(-70.9, 43.0, 0.2))]);
    const inland = merged({ polygon: square(-72, 44, 0.01) });
    expect(saltContainment({ polygon: inland.polygon, bbox: inland.bbox }, grid)).toBe(0);
  });

  it('scores a body that only grazes the sea below the bar', () => {
    // A pond behind a barrier beach sharing a corner with the estuary that drains it. The bar exists
    // for exactly this: refuse the sea, keep the pond.
    const grid = index([sea('estuary', square(-70.9, 43.0, 0.1))]); // sea ends at -70.8
    // A long traced pond reaching one end into the mask. Traced densely, because the fraction is
    // over *vertices*: a five-point rectangle can only ever answer in fifths, which is the
    // quantisation that made the first real measurement unreadable.
    const top: number[][] = [];
    const bottom: number[][] = [];
    for (let i = 0; i <= 40; i++) {
      const lng = -70.82 + i * 0.008;
      top.push([lng, 43.06]);
      bottom.push([lng, 43.05]);
    }
    const pond: Polygon = { type: 'Polygon', coordinates: [[...top, ...bottom.reverse()]] };
    const frac = saltContainment({ polygon: pond, bbox: bboxOf(pond) }, grid);
    expect(frac).toBeGreaterThan(0);
    expect(frac).toBeLessThan(0.1);
  });
});

describe('the name lane', () => {
  const named = (source: ClaimSource, id: string, name: string, polygon: Polygon) =>
    feature(source, id, { name, polygon, bbox: bboxOf(polygon), areaSqM: 1 });

  it('matches two overlapping features the area-ratio ceiling refused', () => {
    // The measured shape: NHD's Peabody Pond at 7 ac against OSM's at 16. `min/max = 0.44` is under
    // `RECONCILE_MIN_IOU`, so `scoreCandidates` skips the pair before computing anything.
    const target = named('osm', 'way/1', 'Peabody Pond', square(-70, 44, 0.02));
    const candidate = named('nhd', 'n1', 'Peabody Pond', square(-70, 44, 0.013));
    const { pairs } = nameMatchPairs([target], index([candidate]), new Set(), sameName);
    expect(pairs).toEqual([['way/1', 'n1']]);
  });

  it('will NOT match a Mud Pond in Maine to a Mud Pond in New York', () => {
    // The founder's condition on this lane, and the whole of its safety: overlap is required, so the
    // name can never reach across the region however many bodies share it.
    const maine = named('osm', 'way/1', 'Mud Pond', square(-69, 45, 0.02));
    const newYork = named('nhd', 'n1', 'Mud Pond', square(-75, 43, 0.02));
    const { pairs } = nameMatchPairs([maine], index([newYork]), new Set(), sameName);
    expect(pairs).toEqual([]);
  });

  it('refuses when two same-named candidates both overlap, rather than guessing', () => {
    const target = named('osm', 'way/1', 'Long Pond', square(-70, 44, 0.03));
    const a = named('nhd', 'n1', 'Long Pond', square(-70, 44, 0.02));
    const b = named('nhd', 'n2', 'Long Pond', square(-69.995, 44.005, 0.02));
    const { pairs, ambiguous } = nameMatchPairs([target], index([a, b]), new Set(), sameName);
    expect(pairs).toEqual([]);
    expect(ambiguous).toHaveLength(1);
  });

  it('never overrules the geometric lane, including its `ambiguous` verdict', () => {
    const target = named('osm', 'way/1', 'Peabody Pond', square(-70, 44, 0.02));
    const candidate = named('nhd', 'n1', 'Peabody Pond', square(-70, 44, 0.013));
    const { pairs } = nameMatchPairs(
      [target],
      index([candidate]),
      new Set(['way/1']), // already spoken for
      sameName,
    );
    expect(pairs).toEqual([]);
  });

  it('ignores an unnamed feature on either side', () => {
    const target = named('osm', 'way/1', '', square(-70, 44, 0.02));
    const candidate = named('nhd', 'n1', '', square(-70, 44, 0.013));
    expect(nameMatchPairs([target], index([candidate]), new Set(), sameName).pairs).toEqual([]);
  });

  it('requires real overlap, not merely an intersecting bounding box', () => {
    // Two L-shaped-adjacent squares sharing a box corner and no area.
    const target = named('osm', 'way/1', 'Twin Pond', square(-70, 44, 0.01));
    const candidate = named('nhd', 'n1', 'Twin Pond', square(-69.99, 44.01, 0.01));
    expect(nameMatchPairs([target], index([candidate]), new Set(), sameName).pairs).toEqual([]);
  });

  it('accepts the spelling differences `sameName` already forgives', () => {
    const target = named('osm', 'way/1', "Harvey's Lake", square(-70, 44, 0.02));
    const candidate = named('nhd', 'n1', 'Lake Harveys', square(-70, 44, 0.013));
    expect(nameMatchPairs([target], index([candidate]), new Set(), sameName).pairs).toEqual([
      ['way/1', 'n1'],
    ]);
  });
});

describe('the duplicate sweep', () => {
  it('finds two surviving bodies that cover the same water', () => {
    const a = merged({ key: 'osm:way/1', polygon: square(-70, 44, 0.02) });
    const b = merged({ key: 'nhd:n1', polygon: square(-70.001, 44.001, 0.02) });
    const found = overlapDuplicates([a, b]);
    expect(found.get('osm:way/1')).toEqual(['nhd:n1']);
    expect(found.get('nhd:n1')).toEqual(['osm:way/1']);
  });

  it('leaves two genuinely separate lakes alone', () => {
    const a = merged({ key: 'osm:way/1', polygon: square(-70, 44, 0.02) });
    const b = merged({ key: 'osm:way/2', polygon: square(-71, 44, 0.02) });
    expect(overlapDuplicates([a, b]).size).toBe(0);
  });

  it('does not flag a bay against its parent — that is containment, not duplication', () => {
    const parent = merged({
      key: 'osm:way/1',
      polygon: square(-70, 44, 0.1),
      areaSqM: 1_000_000,
    });
    const bay = merged({ key: 'osm:way/2', polygon: square(-70, 44, 0.01), areaSqM: 10_000 });
    expect(overlapDuplicates([parent, bay]).size).toBe(0);
  });

  it('reports each pair once per side and never against itself', () => {
    const a = merged({ key: 'osm:way/1', polygon: square(-70, 44, 0.02) });
    const b = merged({ key: 'nhd:n1', polygon: square(-70.001, 44.001, 0.02) });
    const c = merged({ key: '3dhp:d1', polygon: square(-70.002, 44.002, 0.02) });
    const found = overlapDuplicates([a, b, c]);
    for (const [key, others] of found) {
      expect(others).not.toContain(key);
      expect(new Set(others).size).toBe(others.length);
    }
  });
});

describe('a bay is an arm of something', () => {
  it('returns the parent, so the caller can make it a sub-area', () => {
    const parent = merged({
      key: 'osm:way/parent',
      polygon: square(-70, 44, 0.1),
      areaSqM: 1_000_000,
    });
    const bay = merged({ polygon: square(-70, 44, 0.01), areaSqM: 10_000, cls: 'bay' });
    expect(bayParent(bay, index([parent]))?.key).toBe('osm:way/parent');
  });

  it('prefers the SMALLEST qualifying parent — a cove in a bay in a lake', () => {
    // Decision 9's smallest-containing rule, one layer up. Without it the answer depends on the
    // order the cell grid happens to yield candidates in.
    const lake = merged({ key: 'osm:lake', polygon: square(-70, 44, 0.1), areaSqM: 9_000_000 });
    const bay = merged({ key: 'osm:bay', polygon: square(-70, 44, 0.05), areaSqM: 2_000_000 });
    const cove = merged({ polygon: square(-70, 44, 0.01), areaSqM: 10_000, cls: 'bay' });
    expect(bayParent(cove, index([lake, bay]))?.key).toBe('osm:bay');
  });

  it('still has no parent for Half Moon Cove', () => {
    const elsewhere = merged({ polygon: square(-60, 40, 0.5), areaSqM: 9_000_000 });
    const cove = merged({ polygon: square(-70, 44, 0.01), areaSqM: 10_000, cls: 'bay' });
    expect(bayParent(cove, index([elsewhere]))).toBeUndefined();
  });
});

describe('what a merge absorbs is named', () => {
  it('lists the member whose polygon and id the merged body does not carry', () => {
    const { body } = mergeGroupWithReason([
      feature('osm', 'way/1', { name: 'Long Pond' }),
      feature('osm', 'relation/2', { name: 'Long Pond' }),
      feature('nhd', 'n1'),
    ]);
    expect(body?.sameSourceDuplicate).toBe(true);
    expect(body?.absorbedIds).toEqual(['osm:relation/2']);
  });

  it('is empty for an ordinary one-per-catalogue group', () => {
    const { body } = mergeGroupWithReason([feature('osm', 'way/1'), feature('nhd', 'n1')]);
    expect(body?.absorbedIds).toEqual([]);
  });

  it('names the same member `catalogueIdsOf` drops, so the two cannot disagree', () => {
    const members = [
      feature('osm', 'way/1'),
      feature('osm', 'relation/2'),
      feature('nhd', 'n1'),
      feature('nhd', 'n2'),
    ];
    const { body } = mergeGroupWithReason(members);
    const ids = catalogueIdsOf(members);
    expect(ids.osmId).toBe('way/1');
    expect(ids.nhdId).toBe('n1');
    expect(body?.absorbedIds).toEqual(['osm:relation/2', 'nhd:n2']);
  });
});

describe('dense outline sampling', () => {
  it('spends its budget over the whole geometry, not per ring', () => {
    const multi: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [square(-70, 44, 0.01).coordinates, square(-71, 44, 0.01).coordinates],
    };
    expect(sampleOutlineDense(multi, 64).length).toBe(10); // both rings, all five positions each
  });

  it('never drops a component smaller than the stride', () => {
    // The archipelago case, and the Maine coast is made of it: a dense ring sets a stride longer
    // than a small ring, which walked end-to-end would contribute no samples at all and vanish from
    // every fraction computed here.
    const dense: number[][] = [];
    for (let i = 0; i <= 200; i++) dense.push([-71 + i * 0.0001, 44]);
    dense.push([-71, 44]);
    const island = square(-70, 45, 0.01); // five positions, against a stride of 25
    const multi: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [[dense], island.coordinates],
    };
    const points = sampleOutlineDense(multi, 8);
    expect(points.some(([lng, lat]) => lng === -70 && lat === 45)).toBe(true);
  });

  it('is empty for a geometry with no positions', () => {
    expect(sampleOutlineDense({ type: 'Polygon', coordinates: [[]] }, 8)).toEqual([]);
  });
});

describe('statesFor escalates the way inRegion does', () => {
  /** A state whose eastern edge is at -71: everything west of it is out. */
  const state = (name: string, poly: Polygon) => ({
    name,
    level: 'state',
    polygon: poly,
    bbox: bboxOf(poly),
  });

  it('finds the state a body reaches on ONE vertex the sparse sample missed', () => {
    // **`inRegion` walks every vertex before it drops a body; this used to walk eight per ring.**
    // A body admitted on a vertex the sparse sample missed came out belonging to no state at all —
    // invisible in the feed, in drive-time and in every state chip. Measured: 9 bodies on the
    // 2026-08-06 run, all border-straddlers (Greenwood Lake NY/NJ, 100 Acre Cove MA/RI).
    const maine = state('Maine', square(-71, 44, 2));
    // A long body mostly west of the border with a single vertex poking east of -71.
    const ring: [number, number][] = [];
    for (let i = 0; i < 40; i++) ring.push([-72 + i * 0.02, 44.5]);
    ring.push([-70.9, 44.6]); // the one vertex inside Maine
    for (let i = 39; i >= 0; i--) ring.push([-72 + i * 0.02, 44.7]);
    ring.push(ring[0] as [number, number]);
    const body = {
      polygon: { type: 'Polygon' as const, coordinates: [ring] },
      bbox: bboxOf({ type: 'Polygon', coordinates: [ring] }),
    };
    expect(statesFor(body, index([maine]))).toEqual(['ME']);
  });

  it('still returns empty rather than guessing when no state claims the body', () => {
    const maine = state('Maine', square(-71, 44, 2));
    const elsewhere = merged({ polygon: square(-60, 30, 0.1) });
    expect(statesFor(elsewhere, index([maine]))).toEqual([]);
  });

  it('does not pay for the escalation when the cheap pass already answered', () => {
    const maine = state('Maine', square(-71, 44, 2));
    const inside = merged({ polygon: square(-70, 45, 0.01) });
    expect(statesFor(inside, index([maine]))).toEqual(['ME']);
  });
});

describe('the name lane cannot swallow a lobe', () => {
  const named = (
    source: ClaimSource,
    id: string,
    name: string,
    polygon: Polygon,
    areaSqM: number,
  ) => feature(source, id, { name, polygon, bbox: bboxOf(polygon), areaSqM });

  it('refuses a same-named arm of its own parent — the Indian Lake regression', () => {
    // The lane shipped at 0.1 and the first full run absorbed a 534-acre `Indian Lake` into the
    // 3,743-acre `Indian Lake` beside it, because a lobe inside its parent scores IoU ≈ 0.12. D93
    // already settled this bar for the STRONGER signal (a shared GNIS id) at 0.3, on the reasoning
    // that accepting less "merges a real lake into a fragment".
    const parent = named('nhd', 'n1', 'Indian Lake', square(-74, 43, 0.1), 4296);
    const lobe = named('osm', 'way/lobe', 'Indian Lake', square(-74, 43, 0.035), 534);
    expect(nameMatchPairs([lobe], index([parent]), new Set(), sameName).pairs).toEqual([]);
  });

  it('still matches the pair the area-ratio ceiling refused — Peabody Pond at 7 vs 16 acres', () => {
    // The band the lane exists for: `min/max = 0.44`, under `RECONCILE_MIN_IOU` and over this bar.
    const big = named('osm', 'way/1', 'Peabody Pond', square(-70, 44, 0.02), 16);
    const small = named('nhd', 'n1', 'Peabody Pond', square(-70, 44, 0.0133), 7);
    expect(nameMatchPairs([big], index([small]), new Set(), sameName).pairs).toEqual([
      ['way/1', 'n1'],
    ]);
  });

  it('is pinned to the GNIS bar, so the two cannot drift apart', () => {
    expect(NAME_MATCH_MIN_IOU).toBe(RECONCILE_MIN_IOU_WITH_GNIS);
  });
});

describe('the salt veto has a freshwater allow-list', () => {
  it('rescues the two lakes dammed above a tidal inlet of the same name', () => {
    // Measured: Nequasset Lake is 12.3% inside NHD's estuary polygon and Winnegance Lake 46.3%,
    // while Menemsha Pond (salt) is 15.6% and Little Bay (salt) 47.8%. One fresh lake sits below a
    // salt pond and the other above a tidal bay, so there is no threshold to move.
    expect(isFreshwaterException('Nequasset Lake')).toBe(true);
    expect(isFreshwaterException('Winnegance Lake')).toBe(true);
  });

  it('folds the name the way every other name rule here does', () => {
    expect(isFreshwaterException('  NEQUASSET LAKE ')).toBe(true);
  });

  it('does not rescue the salt ponds sitting either side of them', () => {
    expect(isFreshwaterException('Menemsha Pond')).toBe(false);
    expect(isFreshwaterException('Little Bay')).toBe(false);
    expect(isFreshwaterException('Crows Pond')).toBe(false);
  });

  it('stays small — every entry is a body somebody reviewed', () => {
    // The general escape hatch is N7b's `includedByRequest`, one body at a time with a human
    // looking. A list that needed twenty entries would mean the rule was measuring the wrong thing.
    expect(FRESHWATER_ALLOW_LIST.size).toBeLessThanOrEqual(5);
  });
});

describe('the gazetteer resolves globally — a point names at most one body', () => {
  const pt = (lng: number, lat: number, name: string, featureId?: string): GnisPoint => ({
    lng,
    lat,
    name,
    featureClass: 'Lake',
    featureId,
  });
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
  const body = (key: string, lng: number, lat: number, side = 0.004) => {
    const polygon = square(lng, lat, side);
    return { key, polygon, bbox: bboxOf(polygon) };
  };

  it('names a body from the one point inside it', () => {
    // `square(lng, lat, side)` runs NORTH-EAST from its corner, so the centre is +side/2.
    const grid = gridOf([pt(-69.998, 44.002, 'Twinings Pond', '616007')]);
    const names = resolveGnisNames([body('osm:way/1', -70, 44)], grid);
    expect(names.get('osm:way/1')).toEqual({ name: 'Twinings Pond', featureId: '616007' });
  });

  it('refuses to name SIX ponds after one of them — the Twinings Pond regression', () => {
    // Measured on the 2026-08-06 run: `gnis 616007` landed on six different bodies of 70, 4, 30, 26,
    // 123 and 14 acres, all called "Twinings Pond". The per-body rule only ever caught the mirror
    // case (several points in one body); a point in a cluster of ponds was legitimately "the only
    // point near" each of them, independently.
    // Four ponds meeting at a corner, with the point inside one and within 100 m of the other three.
    const point = pt(-70.0005, 44.0005, 'Twinings Pond', '616007');
    const grid = gridOf([point]);
    const bodies = [
      body('osm:way/1', -70.004, 44.0),
      body('osm:way/2', -70.0, 44.0),
      body('osm:way/3', -70.0, 43.996),
      body('osm:way/4', -70.004, 43.996),
    ];
    const names = resolveGnisNames(bodies, grid);
    expect(names.size).toBe(0);
  });

  it('still names each body when they have a point of their own', () => {
    const grid = gridOf([
      pt(-69.998, 44.002, 'Twinings Pond', '616007'),
      pt(-70.998, 44.002, 'Teal Pond', '614353'),
    ]);
    const names = resolveGnisNames([body('osm:way/1', -70, 44), body('osm:way/2', -71, 44)], grid);
    expect(names.get('osm:way/1')?.name).toBe('Twinings Pond');
    expect(names.get('osm:way/2')?.name).toBe('Teal Pond');
  });

  it('keeps the mirror rule — several points in one body still name nothing', () => {
    // Great Bay swallows seven GNIS points; picking one would be arbitrary.
    const grid = gridOf([pt(-69.999, 44.001, 'Great Bay'), pt(-69.997, 44.003, 'Some Cove')]);
    expect(resolveGnisNames([body('osm:way/1', -70, 44)], grid).size).toBe(0);
  });

  it('leaves a body the gazetteer has never heard of unnamed', () => {
    expect(resolveGnisNames([body('osm:way/1', -70, 44)], gridOf([])).size).toBe(0);
  });
});
