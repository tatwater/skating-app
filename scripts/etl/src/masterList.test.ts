/**
 * **The whole pipeline, end to end, against named answers** (N7 second intake audit).
 *
 * `mergeRules.test.ts` covers each rule in isolation and every one of them passed while the pipeline
 * still admitted the ocean, deleted two real New York lakes and inserted duplicate rows — because
 * none of those is a property of a rule. They are properties of the **order** the rules run in, of
 * what one stage hands the next, and of what happens to a body that satisfies two rules at once.
 * That is what this file tests.
 *
 * Every fixture is a body we can name or a failure the campaign actually met.
 */

import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { buildMasterList, emitCanonicalBodies, type MasterListInput } from './masterList';
import {
  type Boundary,
  type Feature,
  type GnisPoint,
  index,
  outerRings,
  SQ_M_PER_ACRE,
} from './mergeRules';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** An axis-aligned square, given its south-west corner and side in degrees. */
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

function bboxOf(g: Polygon | MultiPolygon) {
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

/**
 * Geodesic area is what the pipeline measures, and a degree is ~78 km of longitude at 44°N, so a
 * fixture's *stated* acreage has to come from its side length rather than from a field we set.
 * `sideForAcres` inverts that, so a test can say "a five-acre pond" and mean it.
 */
function sideForAcres(acres: number, lat = 44): number {
  const sqM = acres * SQ_M_PER_ACRE;
  const mPerDegLat = 111_132;
  const mPerDegLng = 111_320 * Math.cos((lat * Math.PI) / 180);
  return Math.sqrt(sqM / (mPerDegLat * mPerDegLng));
}

/** A feature as a lane would have produced it: classified, above the hard floor, with a bbox. */
function feat(
  source: Feature['source'],
  id: string,
  over: Partial<Feature> & { polygon?: Polygon | MultiPolygon } = {},
): Feature {
  const polygon = over.polygon ?? square(-70, 44, sideForAcres(40));
  const token = over.token ?? `${source}:test`;
  return {
    source,
    id,
    name: '',
    cls: 'lakePond',
    token,
    sourceToken: over.sourceToken ?? token,
    polygon,
    bbox: bboxOf(polygon),
    areaSqM: over.areaSqM ?? geodesicish(polygon),
    ...over,
  };
}

/**
 * A flat-earth area for the fixtures, close enough at these sizes.
 *
 * The pipeline never recomputes area — the lanes measure it once and it rides on the feature — so a
 * fixture only has to be *self-consistent* between its polygon and its `areaSqM`.
 */
function geodesicish(g: Polygon | MultiPolygon): number {
  const mPerDegLat = 111_132;
  const box = bboxOf(g);
  const mid = (box.minLat + box.maxLat) / 2;
  const mPerDegLng = 111_320 * Math.cos((mid * Math.PI) / 180);
  return (box.maxLng - box.minLng) * mPerDegLng * ((box.maxLat - box.minLat) * mPerDegLat);
}

/** The five states, as one big square around every fixture, plus a state row for `states`. */
const MAINE: Boundary & { name: string; level: string } = {
  name: 'Maine',
  level: 'state',
  polygon: square(-71, 43, 3),
  bbox: bboxOf(square(-71, 43, 3)),
};

function inputFor(
  parts: Partial<Pick<MasterListInput, 'osm' | 'nhd' | 'dhp' | 'gnisGrid' | 'downstate'>> = {},
): MasterListInput {
  const boundaries = [MAINE];
  return {
    osm: parts.osm ?? [],
    nhd: parts.nhd ?? [],
    dhp: parts.dhp ?? [],
    gnisGrid: parts.gnisGrid ?? new Map<string, GnisPoint[]>(),
    boundaryGrid: index(boundaries) as Map<string, Boundary[]>,
    downstate: parts.downstate ?? [],
  };
}

const keys = (bodies: { key: string }[]) => bodies.map((b) => b.key).sort();

// ─────────────────────────────────────────────────────────────────────────────
// Every group is accounted for
// ─────────────────────────────────────────────────────────────────────────────

describe('the balance', () => {
  it('accounts for every group as a body, a sub-area or a named drop', () => {
    // The equation the first audit found missing in the middle of the pipeline: the lane ledgers
    // asserted their end and the emit stage asserted its end, and the stage that makes every
    // admission decision asserted nothing at all.
    const result = buildMasterList(
      inputFor({
        osm: [
          feat('osm', 'way/keep', { name: 'Keeper Pond' }),
          feat('osm', 'way/small', {
            name: '',
            polygon: square(-70.5, 44, sideForAcres(2)),
          }),
          feat('osm', 'way/away', { polygon: square(-60, 30, sideForAcres(40)) }),
        ],
      }),
    );
    expect(result.stats.groups).toBe(3);
    expect(result.bodies.length + result.subAreas.length + result.dropped.length).toBe(3);
  });

  it('names every drop, with the reason and the sources — never only a count', () => {
    // The largest bucket in the pipeline (~100,000 groups) used to emit no identities at all, so
    // "what happened to Lake X" had no answer and two runs could not be diffed.
    const result = buildMasterList(
      inputFor({
        osm: [feat('osm', 'way/small', { polygon: square(-70.5, 44, sideForAcres(2)) })],
      }),
    );
    expect(result.dropped).toEqual([
      {
        key: 'osm:way/small',
        name: '',
        cls: 'lakePond',
        acres: 2,
        reason: 'unnamed, 1–5 acres',
        sources: ['osm:way/small'],
      },
    ]);
  });

  it('throws rather than reporting a total that does not add up', () => {
    // There is no way to force an imbalance through the public API — which is the point of the
    // assertion — so this pins that the guard exists and is wired to the group count.
    const result = buildMasterList(inputFor({ osm: [feat('osm', 'way/1', { name: 'A Pond' })] }));
    expect(result.stats.groups).toBe(result.bodies.length + result.dropped.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The named fixtures
// ─────────────────────────────────────────────────────────────────────────────

describe('what the corpus must and must not contain', () => {
  it('refuses Lake Erie, which NHD publishes as a LakePond', () => {
    const erie = feat('nhd', 'erie', {
      name: 'Lake Erie',
      polygon: square(-70.9, 43.1, 1.5),
    });
    const result = buildMasterList(inputFor({ nhd: [erie] }));
    expect(result.bodies).toHaveLength(0);
    expect(result.stats.refused.get('vetoed-name')).toBe(1);
  });

  it('KEEPS Lake Superior, New York — a 179-acre lake in Sullivan County', () => {
    // The name-only veto deleted this, and the only trace would have been a counter.
    const superior = feat('osm', 'way/superior', {
      name: 'Lake Superior',
      polygon: square(-70.2, 44.2, sideForAcres(179)),
    });
    const result = buildMasterList(inputFor({ osm: [superior] }));
    expect(keys(result.bodies)).toEqual(['osm:way/superior']);
  });

  it('refuses a tidal cove no catalogue matched, which the token veto could not reach', () => {
    // Great Bay's shape: one federal estuary polygon against separate OSM coves. The coves never
    // reach IoU 0.5 against the estuary, so it never lands in their group — and the bay rule then
    // demoted them to `unclassified` and let them in, because their only possible parent is the sea.
    const estuary = feat('nhd', 'estuary', {
      polygon: square(-70.9, 43.5, 0.2),
      cls: null,
      token: 'nhd:ftype=493',
      sourceToken: 'nhd:ftype=493',
    });
    const cove = feat('osm', 'way/cove', {
      name: 'Kellys Cove',
      cls: 'bay',
      polygon: square(-70.85, 43.55, sideForAcres(60)),
    });
    const result = buildMasterList(inputFor({ osm: [cove], nhd: [estuary] }));
    expect(result.bodies).toHaveLength(0);
    expect(result.stats.saltWater).toBe(1);
    expect(result.dropped.map((d) => d.reason)).toContain('salt-water');
  });

  it('keeps a freshwater embayment of a Great Lake, which is not the sea', () => {
    // Braddock Bay and Blind Sodus Bay are on Lake Ontario and are skated. 3DHP files the Great
    // Lakes under the same code as the Atlantic, so masking with the whole class deleted them.
    const ontario = feat('3dhp', 'ontario', {
      name: 'Lake Ontario',
      polygon: square(-77.9, 43.2, 1),
      cls: null,
      token: '3dhp:featuretype=4',
      sourceToken: '3dhp:featuretype=4',
    });
    const braddock = feat('osm', 'way/braddock', {
      name: 'Braddock Bay',
      cls: 'bay',
      polygon: square(-77.7, 43.3, sideForAcres(343, 43)),
    });
    // A mask that reaches New York, since this fixture sits west of the Maine box.
    const ny: Boundary & { name: string; level: string } = {
      name: 'New York',
      level: 'state',
      polygon: square(-79, 42, 4),
      bbox: bboxOf(square(-79, 42, 4)),
    };
    const result = buildMasterList({
      ...inputFor({ osm: [braddock], dhp: [ontario] }),
      boundaryGrid: index([ny]) as Map<string, Boundary[]>,
    });
    expect(result.stats.saltWater).toBe(0);
    expect(keys(result.bodies)).toEqual(['osm:way/braddock']);
  });

  it('keeps Beau Lake, which straddles the Québec border — any part, not its centre', () => {
    const beau = feat('nhd', 'beau', {
      name: 'Beau Lake',
      // Straddling the mask's western edge at -71: half its vertices are outside our five states,
      // which is Beau Lake's actual situation — Geofabrik clips the Québec half.
      polygon: square(-71.01, 43.05, 0.02),
    });
    const result = buildMasterList(inputFor({ nhd: [beau] }));
    expect(keys(result.bodies)).toEqual(['nhd:beau']);
    // …and the row records how much of it is actually ours, without acting on it (founder call).
    expect(result.bodies[0]?.inRegionFraction).toBeGreaterThan(0);
    expect(result.bodies[0]?.inRegionFraction).toBeLessThan(1);
  });

  it('admits a named wetland above five acres and refuses an unnamed one at 49', () => {
    const named = feat('osm', 'way/named', {
      name: 'Cicero Swamp',
      cls: 'wetland',
      // Six rather than five: `sideForAcres` and the fixture's own area both approximate, and a
      // fixture sitting exactly on a threshold tests the arithmetic rather than the rule.
      polygon: square(-70.1, 44.1, sideForAcres(6)),
    });
    const unnamed = feat('osm', 'way/unnamed', {
      cls: 'wetland',
      polygon: square(-70.3, 44.3, sideForAcres(49)),
    });
    const result = buildMasterList(inputFor({ osm: [named, unnamed] }));
    expect(keys(result.bodies)).toEqual(['osm:way/named']);
  });

  // 520 of run 6's 652 class conflicts. The body is kept as open water either way — that half was
  // always right — but it stopped being queued, because asking a moderator to confirm D96 five
  // hundred times is how a queue stops being worked. See `settledWetlandDissent`.
  it('resolves a federal open-water class against an OSM wetland tag without queueing it', () => {
    const shape = square(-70.6, 44.6, sideForAcres(30));
    const result = buildMasterList(
      inputFor({
        osm: [feat('osm', 'way/marsh', { name: 'Colby Marsh', cls: 'wetland', polygon: shape })],
        nhd: [feat('nhd', 'nhd-390', { name: 'Colby Marsh', cls: 'lakePond', polygon: shape })],
      }),
    );
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0]?.cls).toBe('lakePond');
    expect(result.bodies[0]?.reviewReasons).not.toContain('class-conflict');
    // Resolved is not silent — the count is what makes a volume shift between runs visible.
    expect(result.stats.settledWetland).toBe(1);
  });

  // The mirror, and the reason the rule is directional: here the FEDERAL catalogue is the one saying
  // bog, which is what D96's admission floor turns on. 132 of the 652, and they stay in the queue.
  it('still queues an OSM open-water claim against a federal wetland one', () => {
    const shape = square(-70.7, 44.7, sideForAcres(30));
    const result = buildMasterList(
      inputFor({
        osm: [feat('osm', 'way/pond', { name: 'Mud Pond', cls: 'lakePond', polygon: shape })],
        nhd: [feat('nhd', 'nhd-466', { name: 'Mud Pond', cls: 'wetland', polygon: shape })],
      }),
    );
    expect(result.bodies[0]?.reviewReasons).toContain('class-conflict');
    expect(result.stats.settledWetland).toBe(0);
  });

  // **Kelly Bog, as the archives actually hold it** — the fixture for a bar that had never fired.
  //
  //   OSM  way/119692346  name=""          gnisId=(none)   4 ac
  //   NHD  145081714      name="Kelly Bog" gnisId=569072   4 ac
  //   scored: iou=0.358  gnisAgrees=FALSE  →  verdict: none
  //
  // 0.358 clears the 0.30 GNIS bar and misses the 0.50 geometric one, so the pair stayed two bodies
  // — and then the gazetteer named the OSM half "Kelly Bog" and stamped it 569072, leaving two rows
  // agreeing on name AND federal id. 126 such pairs on run 6, every one queued for a human.
  describe('the gazetteer settles the id before the lanes run', () => {
    // Two outlines of one bog overlapping at ~0.38 — above the GNIS bar, below the geometric one.
    // **Ten acres rather than the real four**, so that both halves clear D96's floor unnamed: at four
    // the OSM half is refused as an unnamed 1–5 acre body and the "without the gazetteer" case would
    // pass for the wrong reason, testing the floor instead of the matcher.
    const side = sideForAcres(10);
    const osmBog = feat('osm', 'way/119692346', {
      polygon: square(-70.3, 44.3, side),
    });
    const nhdBog = feat('nhd', '145081714', {
      name: 'Kelly Bog',
      gnisId: '569072',
      polygon: square(-70.3 + side * 0.45, 44.3, side),
    });
    /** One gazetteer point, inside the OSM outline — which is the only side lacking an id. */
    const gnisGrid = () => {
      const grid = new Map<string, GnisPoint[]>();
      const p = { lng: -70.3 + side * 0.2, lat: 44.3 + side * 0.5 };
      grid.set(`${Math.floor(p.lng / 0.1)}:${Math.floor(p.lat / 0.1)}`, [
        { ...p, name: 'Kelly Bog', featureClass: 'Swamp', featureId: '569072' },
      ]);
      return grid;
    };

    it('merges the pair the 0.3 bar was written for', () => {
      const result = buildMasterList(
        inputFor({ osm: [osmBog], nhd: [nhdBog], gnisGrid: gnisGrid() }),
      );
      expect(result.stats.gazetteerIdsAttached).toBe(1);
      expect(result.bodies).toHaveLength(1);
      expect(result.bodies[0]?.name).toBe('Kelly Bog');
      // One body, so nothing for the duplicate sweep to flag.
      expect(result.stats.duplicatePairs).toBe(0);
    });

    it('leaves them as two queued bodies when the gazetteer has nothing to say', () => {
      // The regression this guards: without the id, 0.358 is simply a miss, and the pair reaches the
      // corpus as two rows that agree on everything a human can see.
      const result = buildMasterList(inputFor({ osm: [osmBog], nhd: [nhdBog] }));
      expect(result.stats.gazetteerIdsAttached).toBe(0);
      expect(result.bodies).toHaveLength(2);
      expect(result.stats.duplicatePairs).toBe(1);
    });

    it('assigns the id but never the name, which still waits for the merge', () => {
      // `resolveGnisNames` refuses a point that could name more than one BODY, and that rule took
      // `gnisRescued` from 1,771 to 921. It cannot move earlier: before the merge one lake is several
      // features and a point legitimately falls inside both catalogues' polygons — which the
      // cross-body rule would read as ambiguity and refuse. Ids only.
      const lonely = feat('osm', 'way/lonely', { polygon: square(-70.3, 44.3, side) });
      const result = buildMasterList(inputFor({ osm: [lonely], gnisGrid: gnisGrid() }));
      expect(result.stats.gazetteerIdsAttached).toBe(1);
      // Named by the post-merge lane, exactly as before — the two halves stay separate.
      expect(result.bodies[0]?.name).toBe('Kelly Bog');
      expect(result.stats.gnisNamed).toBe(1);
    });
  });

  it('admits a wetland the GAZETTEER named, because GNIS runs before the floor', () => {
    // The 306-body ordering claim: stamping the name on afterwards would have deleted these first.
    const bog = feat('osm', 'way/bog', {
      cls: 'wetland',
      polygon: square(-70.4, 44.4, sideForAcres(20)),
    });
    const grid = new Map<string, GnisPoint[]>();
    const centre = { lng: -70.4 + sideForAcres(20) / 2, lat: 44.4 + sideForAcres(20) / 2 };
    grid.set(`${Math.floor(centre.lng / 0.1)}:${Math.floor(centre.lat / 0.1)}`, [
      { ...centre, name: 'Cicero Swamp', featureClass: 'Swamp', featureId: '12345' },
    ]);
    const result = buildMasterList(inputFor({ osm: [bog], gnisGrid: grid }));
    expect(keys(result.bodies)).toEqual(['osm:way/bog']);
    expect(result.bodies[0]?.name).toBe('Cicero Swamp');
    expect(result.stats.gnisRescued).toBe(1);
  });

  it('refuses New York below I-84 while keeping it on the map', () => {
    const downstate = [
      { polygon: square(-73.9, 41.0, 0.5), bbox: bboxOf(square(-73.9, 41.0, 0.5)) },
    ];
    const kensico = feat('osm', 'way/kensico', {
      name: 'Kensico Reservoir',
      polygon: square(-73.8, 41.1, sideForAcres(200, 41)),
    });
    const ny: Boundary & { name: string; level: string } = {
      name: 'New York',
      level: 'state',
      polygon: square(-75, 40.5, 4),
      bbox: bboxOf(square(-75, 40.5, 4)),
    };
    const result = buildMasterList({
      ...inputFor({ osm: [kensico], downstate }),
      boundaryGrid: index([ny]) as Map<string, Boundary[]>,
    });
    expect(result.bodies).toHaveLength(0);
    expect(result.stats.belowI84).toBe(1);
    expect(result.dropped[0]?.reason).toBe('ny-below-i84');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Duplicates — the second audit's headline
// ─────────────────────────────────────────────────────────────────────────────

describe('a missed match must not become two lakes', () => {
  /** NHD's 7-acre Peabody Pond against OSM's 16-acre one: a 2.3× area ratio, IoU ceiling 0.44. */
  const peabodyOsm = feat('osm', 'way/peabody', {
    name: 'Peabody Pond',
    polygon: square(-70.2, 44.2, sideForAcres(16)),
  });
  const peabodyNhd = feat('nhd', 'peabody', {
    name: 'Peabody Pond',
    polygon: square(-70.2, 44.2, sideForAcres(7)),
  });

  it('merges them on the name lane, because they overlap and agree on it', () => {
    const result = buildMasterList(inputFor({ osm: [peabodyOsm], nhd: [peabodyNhd] }));
    expect(result.bodies).toHaveLength(1);
    expect(result.stats.nameLane.pairs).toBe(1);
    expect(result.bodies[0]?.members.map((m) => m.source).sort()).toEqual(['nhd', 'osm']);
  });

  it('would have produced TWO bodies without it — the regression this closes', () => {
    // Same pair, renamed so the lane cannot fire. The geometric bar refuses them, and the corpus
    // gets one lake twice with nothing downstream able to tell.
    const result = buildMasterList(
      inputFor({
        osm: [{ ...peabodyOsm, name: 'Peabody Pond' }],
        nhd: [{ ...peabodyNhd, name: 'Someone Elses Pond' }],
      }),
    );
    expect(result.bodies).toHaveLength(2);
    // …and now they do not pass silently: both sides carry the flag.
    for (const body of result.bodies) {
      expect(body.reviewReasons).toContain('duplicate-candidate');
      expect(body.duplicateOf).toHaveLength(1);
    }
    expect(result.stats.duplicatePairs).toBe(1);
  });

  it('leaves an ambiguous pair unmatched, and NAMES both sides', () => {
    // Two federal candidates geometry cannot separate: the verdict writes no pair, so each stays a
    // singleton — i.e. a possible duplicate in the corpus that nothing downstream can detect. The
    // count alone could never be acted on; the ids can be, and the duplicate sweep then catches
    // whatever the ambiguity left behind.
    const shape = square(-70.2, 44.2, sideForAcres(400));
    const osm = feat('osm', 'way/1', { name: '', polygon: shape });
    const a = feat('nhd', 'n1', { name: '', polygon: shape });
    const b = feat('nhd', 'n2', { name: '', polygon: shape });
    const result = buildMasterList(inputFor({ osm: [osm], nhd: [a, b] }));
    const lane = result.stats.lanes.find((l) => l.label === 'osm→nhd');
    expect(lane?.stats.ambiguous).toBe(1);
    expect(lane?.stats.ambiguousIds[0]).toMatch(/way\/1 ↔ n[12]@1\.00/);
    // Identical outlines, so the sweep flags every pair rather than letting them pass as three lakes.
    expect(result.stats.duplicatePairs).toBe(3);
  });

  it('never merges same-named ponds that do not overlap', () => {
    const maine = feat('osm', 'way/mud-me', {
      name: 'Mud Pond',
      polygon: square(-70.2, 44.2, sideForAcres(20)),
    });
    const alsoMaine = feat('nhd', 'mud-far', {
      name: 'Mud Pond',
      polygon: square(-69.0, 45.0, sideForAcres(20)),
    });
    const result = buildMasterList(inputFor({ osm: [maine], nhd: [alsoMaine] }));
    expect(result.bodies).toHaveLength(2);
    expect(result.stats.nameLane.pairs).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bays
// ─────────────────────────────────────────────────────────────────────────────

describe('a bay is an arm, not a lake', () => {
  const lake = feat('osm', 'way/winni', {
    name: 'Lake Winnipesaukee',
    polygon: square(-70.5, 44.5, sideForAcres(45_000)),
  });
  const alton = feat('osm', 'way/alton', {
    name: 'Alton Bay',
    cls: 'bay',
    polygon: square(-70.5, 44.5, sideForAcres(1_415)),
  });

  it('becomes a SUB-AREA of its parent rather than a second body', () => {
    const result = buildMasterList(inputFor({ osm: [lake, alton] }));
    expect(keys(result.bodies)).toEqual(['osm:way/winni']);
    expect(result.subAreas).toHaveLength(1);
    expect(result.subAreas[0]).toMatchObject({
      key: 'osm:way/alton',
      name: 'Alton Bay',
      parentKey: 'osm:way/winni',
      parentIds: { osmId: 'way/winni' },
    });
  });

  it('falls back to a queued body when the parent itself did not survive', () => {
    // A sub-area pointing at a body the loader will never create fails at *load* time rather than
    // here, which is the one outcome that must not happen. The parent here is an unnamed 40-acre
    // wetland — big enough to be a parent, and refused by D96's fifty-acre bar.
    const bog = feat('osm', 'way/bog', {
      cls: 'wetland',
      polygon: square(-70.5, 44.5, sideForAcres(40)),
    });
    const coveInIt = feat('osm', 'way/cove', {
      name: 'Bog Cove',
      cls: 'bay',
      polygon: square(-70.5, 44.5, sideForAcres(10)),
    });
    const result = buildMasterList(inputFor({ osm: [bog, coveInIt] }));
    expect(result.subAreas).toHaveLength(0);
    expect(keys(result.bodies)).toEqual(['osm:way/cove']);
    expect(result.bodies[0]?.cls).toBe('unclassified');
    expect(result.bodies[0]?.reviewReasons).toContain('bay-without-parent');
  });

  // Six real arms of real lakes were demoted because the catalogue that knew the relationship was
  // not the catalogue that won the outline. Sebago Cove is **0.81 contained in NHD's Sebago Lake and
  // 0.00 in OSM's**, and D92 makes OSM draw by default — so the test asked the one outline that says
  // no. Same for Ampersand Bay in Lower Saranac, Noisey Inlet, Pillsbury Bay, Leavitt Bay and
  // Cram's Cove.
  it('finds a parent through a member outline the merge did not choose to draw', () => {
    // OSM draws the lake without the cove; NHD draws it with. The merged body carries OSM's.
    const osmLake = feat('osm', 'way/sebago', {
      name: 'Sebago Lake',
      polygon: square(-70.5, 44.5, sideForAcres(30_000)),
    });
    const nhdLake = feat('nhd', 'nhd-sebago', {
      name: 'Sebago Lake',
      // Extends north far enough to swallow the cove that sits off OSM's outline.
      polygon: square(-70.5, 44.5, sideForAcres(30_000) * 1.15),
    });
    const cove = feat('osm', 'way/sebagocove', {
      name: 'Sebago Cove',
      cls: 'bay',
      // Beyond OSM's northern edge, inside NHD's.
      polygon: square(-70.5, 44.5 + sideForAcres(30_000) * 1.02, sideForAcres(190)),
    });
    const result = buildMasterList(inputFor({ osm: [osmLake, cove], nhd: [nhdLake] }));
    expect(result.subAreas).toHaveLength(1);
    expect(result.subAreas[0]).toMatchObject({
      key: 'osm:way/sebagocove',
      name: 'Sebago Cove',
      parentKey: 'osm:way/sebago',
    });
    // …and the merged parent still draws from OSM. Reading a member's outline is evidence, not a
    // geometry change — enlarging the stored polygon would invent water no publisher shows and move
    // `surfaceAreaSqM`, which the D91 floor and the D49/D2 scores are calibrated on.
    expect(result.bodies[0]?.geometrySource).toBe('osm');
    expect(result.bodies[0]?.polygon).toEqual(osmLake.polygon);
  });

  it('demotes and queues Half Moon Cove, which is contained in nothing', () => {
    const cove = feat('osm', 'way/halfmoon', {
      name: 'Half Moon Cove',
      cls: 'bay',
      polygon: square(-70.6, 44.6, sideForAcres(330)),
    });
    const result = buildMasterList(inputFor({ osm: [cove] }));
    expect(result.bodies[0]?.cls).toBe('unclassified');
    expect(result.bodies[0]?.reviewReasons).toContain('bay-without-parent');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The parents we deliberately do not carry
// ─────────────────────────────────────────────────────────────────────────────

describe('a bay of a Great Lake', () => {
  /**
   * Lake Ontario as the archives publish it — refused as a body by the name veto and the area
   * ceiling, and still in memory, which is what makes the arm rule free.
   */
  const ontario = feat('nhd', 'nhd-ontario', {
    name: 'Lake Ontario',
    cls: null,
    polygon: square(-70.5, 44.5, sideForAcres(4_700_000)),
    sourceToken: 'nhd:ftype=390',
  });

  /** Braddock Bay: 0.28 contained on the real run — the lowest of the eleven, and the threshold. */
  const braddock = (over: Record<string, unknown> = {}) =>
    feat('osm', 'way/braddock', {
      name: 'Braddock Bay',
      cls: 'bay',
      // Straddles Ontario's northern edge, so roughly a third of its outline is inside — which is
      // how a Great Lakes bay is drawn: across the mouth, half of it inland water the lake does not
      // cover. An ordinary bay is drawn *inside* its parent and scores near 1.
      polygon: square(
        -70.4,
        44.5 + sideForAcres(4_700_000) - sideForAcres(343) / 3,
        sideForAcres(343),
      ),
      ...over,
    });

  it('stays a BODY classed bay, rather than being demoted for having no parent', () => {
    const result = buildMasterList(inputFor({ osm: [braddock()], nhd: [ontario] }));
    expect(keys(result.bodies)).toEqual(['osm:way/braddock']);
    expect(result.bodies[0]?.cls).toBe('bay');
    expect(result.bodies[0]?.reviewReasons).not.toContain('bay-without-parent');
    expect(result.stats.greatLakeArms).toBe(1);
    // Never a sub-area: the parent is not in the corpus, so there is nothing to attach it to.
    expect(result.subAreas).toHaveLength(0);
  });

  it('is still demoted when there is no Great Lake either', () => {
    const result = buildMasterList(inputFor({ osm: [braddock()] }));
    expect(result.bodies[0]?.cls).toBe('unclassified');
    expect(result.bodies[0]?.reviewReasons).toContain('bay-without-parent');
    expect(result.stats.greatLakeArms).toBe(0);
  });

  // `isGreatLakeFeature` is a name test, and `Huron Pond` is a real pond in the Maine archive. Without
  // the area floor it would adopt every cove near it — the trap D120 already met from the other
  // direction, when a substring rule aimed at the Great Lakes nearly deleted `Lake Superior`, NY.
  it('is not fooled by Huron Pond', () => {
    const huronPond = feat('nhd', 'nhd-huronpond', {
      name: 'Huron Pond',
      cls: 'lakePond',
      polygon: square(-70.5, 44.5, sideForAcres(600)),
    });
    const cove = feat('osm', 'way/cove', {
      name: 'Little Cove',
      cls: 'bay',
      polygon: square(-70.5, 44.5, sideForAcres(20)),
    });
    const result = buildMasterList(inputFor({ osm: [cove], nhd: [huronPond] }));
    expect(result.stats.greatLakeArms).toBe(0);
    // It is inside a real corpus body, so the ordinary bay rule takes it — as a sub-area.
    expect(result.subAreas).toHaveLength(1);
  });

  // Ordering: a bay of a body we DO carry is a sub-area, and the Great Lake must not outrank that.
  // Checked because the rule is a fallback and a fallback that fires first is invisible.
  it('never outranks a real corpus parent', () => {
    const lake = feat('osm', 'way/lake', {
      name: 'Shore Lake',
      polygon: square(-70.5, 44.5, sideForAcres(5_000)),
    });
    const arm = feat('osm', 'way/arm', {
      name: 'North Arm',
      cls: 'bay',
      polygon: square(-70.5, 44.5, sideForAcres(400)),
    });
    const result = buildMasterList(inputFor({ osm: [lake, arm], nhd: [ontario] }));
    expect(result.subAreas).toHaveLength(1);
    expect(result.subAreas[0]?.parentKey).toBe('osm:way/lake');
    expect(result.stats.greatLakeArms).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The wire contract
// ─────────────────────────────────────────────────────────────────────────────

describe('the emit stage', () => {
  it('carries the states, the ids, the confidence and the review reasons onto the record', () => {
    // The field-by-field check that would have caught the `states` break: the ETL emitted it,
    // `CanonicalBody` declared it, and Convex's validator did not have it — and object validators
    // are exact, so every batch of a merged load would have been rejected.
    const osm = feat('osm', 'way/1', { name: 'Keeper Pond', gnisId: '999' });
    const nhd = feat('nhd', 'n1', { name: 'Keeper Pond' });
    const result = buildMasterList(inputFor({ osm: [osm], nhd: [nhd] }));
    const emitted = emitCanonicalBodies(result.bodies, index([MAINE]));
    expect(emitted.emitted).toHaveLength(1);
    expect(emitted.emitted[0]).toMatchObject({
      source: 'osm',
      externalId: 'way/1',
      geometrySource: 'osm',
      name: 'Keeper Pond',
      type: 'lakePond',
      osmId: 'way/1',
      nhdId: 'n1',
      gnisId: '999',
      states: ['ME'],
    });
    expect(emitted.emitted[0]?.sourceAreaSqM).toBeGreaterThan(0);
    expect(emitted.emitted[0]?.confidence).toMatchObject({ name: 'high' });
  });

  it('counts a body whose geometry defeats the transform instead of losing the run', () => {
    const broken = feat('osm', 'way/broken', {
      name: 'Broken Pond',
      polygon: { type: 'Polygon', coordinates: [[[-70, 44]]] },
      areaSqM: 100 * SQ_M_PER_ACRE,
      bbox: { minLng: -70, maxLng: -70, minLat: 44, maxLat: 44 },
    });
    const result = buildMasterList(inputFor({ osm: [broken] }));
    const emitted = emitCanonicalBodies(result.bodies, index([MAINE]));
    expect(emitted.emitted).toHaveLength(0);
    expect([...emitted.failures.values()].reduce((a, b) => a + b, 0)).toBe(1);
    expect(emitted.failureKeys).toEqual(['osm:way/broken']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

describe('identity', () => {
  it('refuses to run if two catalogues ever share an id namespace', () => {
    // They do not today — `way/…`, an NHD GUID or bare numeric, and 3DHP's `I…` — but `Union`, the
    // group map and the IoU map all share one flat string space, so a source whose ids looked like
    // another's would chain unrelated lakes together with no error at all.
    expect(() =>
      buildMasterList(inputFor({ osm: [feat('osm', 'shared')], nhd: [feat('nhd', 'shared')] })),
    ).toThrow(/id namespace collision/);
  });

  it('collapses an OSM duplicate pair through their shared NHD counterpart', () => {
    // Long Pond is `way/150404999` at 2,552 ac and `relation/2602300` at 2,532; both are one
    // `Permanent_Identifier`, which is a thing OSM cannot see about itself.
    const shape = square(-70.3, 44.3, sideForAcres(2552));
    const result = buildMasterList(
      inputFor({
        osm: [
          feat('osm', 'way/150404999', { name: 'Long Pond', polygon: shape }),
          feat('osm', 'relation/2602300', { name: 'Long Pond', polygon: shape }),
        ],
        nhd: [feat('nhd', 'longpond', { name: 'Long Pond', polygon: shape })],
      }),
    );
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0]?.sameSourceDuplicate).toBe(true);
    expect(result.bodies[0]?.absorbedIds).toEqual(['osm:relation/2602300']);
    expect(result.bodies[0]?.reviewReasons).toContain('same-source-duplicate');
  });
});

describe('the conflict nothing else can see', () => {
  it('counts a body one catalogue refused outright and another classed', () => {
    // Lac Saint-François, 87,927 ac of the St. Lawrence: OSM tags it `water=lake` (and `salt=no`),
    // 3DHP publishes it as `featuretype = 1 River`. A real class beats a drop — the 123-body rescue
    // — so it resolves to `lakePond` silently, and `scoreBody` cannot flag it either, because a
    // refusal contributes `cls: null` and the scorer only sees the non-null claims.
    const shape = square(-70.2, 44.2, sideForAcres(4_000));
    const result = buildMasterList(
      inputFor({
        osm: [feat('osm', 'way/1', { name: 'Lac Saint-François', polygon: shape })],
        dhp: [
          feat('3dhp', 'OIW17', {
            name: '',
            cls: null,
            token: '3dhp:featuretype=1',
            polygon: shape,
          }),
        ],
      }),
    );
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0]?.cls).toBe('lakePond');
    expect(result.stats.classDissent).toBe(1);
    expect(result.stats.classDissentSamples[0]).toMatch(/refused by \[3dhp:featuretype=1\]/);
  });

  it('does not count a group every catalogue agreed on', () => {
    const result = buildMasterList(
      inputFor({ osm: [feat('osm', 'way/1', { name: 'Ordinary Pond' })] }),
    );
    expect(result.stats.classDissent).toBe(0);
  });
});
