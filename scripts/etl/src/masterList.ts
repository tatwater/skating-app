/**
 * **The master list, as a decision rather than a script** (N7, second intake audit 2026-08-06).
 *
 * ## Why this file exists
 *
 * `merge.ts` was excluded from coverage as *"`main()` + `spawnSync` + the report"*, and by the time
 * the second audit reached it that description covered a 1,098-line file whose middle 300 lines
 * decided every row in the corpus: the order of the bay rule against the region clip, the GNIS rescue
 * that admits 306 bodies, the confidence claim assembly, and the emit stage. `mergeRules.ts` had been
 * extracted from it once already — and the extraction stopped at the *rules*, leaving the
 * **orchestration** untested, which is where the ordering bugs live.
 *
 * This is the rest of that extraction. The rule is the one the vitest config states: *if a file holds
 * a decision, extract the decision.* What remains in `merge.ts` is `osmium`, `ogr2ogr`, readline,
 * `writeFileSync` and the printed report; everything that decides whether a lake exists is here, pure,
 * and takes its inputs as arguments.
 *
 * ## The pipeline, in the order it runs, and why each step is where it is
 *
 * ```
 *  match     3 geometric lanes + the NAME lane            → pairs
 *  group     union-find over every pair                   → one group per lake
 *  merge     veto → class → name → geometry               → one body per group
 *  bay       an arm of a larger body becomes a SUB-AREA   → not a body at all
 *  region    the merged outline, against the five states  → out-of-region
 *  downstate NY below I-84 (D111)                         → not covered
 *  salt      inside water a catalogue calls the sea       → refused (founder, no salt water)
 *  gnis      a gazetteer name, BEFORE the floor           → admits 306 bodies
 *  floor     D96's four admission rules                   → the corpus
 *  sweep     overlapping survivors                        → duplicate-candidate, queued
 * ```
 *
 * Every step's output is accounted for: `groups == bodies + subAreas + dropped`, asserted here rather
 * than printed, because the first audit found that the report's proudest claim ("every number
 * balances") held only from the grouping stage onward.
 */

import {
  belongsInCorpus,
  type ClaimSource,
  isNearMiss,
  mergeReviewReasons,
  needsAttention,
  type ReconcileCandidate,
  type ReviewReason,
  reconcileOne,
  sameName,
  scoreBody,
  settledWetlandDissent,
  type WaterBodyClass,
} from '@skating/core';
import {
  type Boundary,
  bayParent,
  catalogueIdsOf,
  cellsFor,
  DUPLICATE_SWEEP_MIN_IOU,
  dropReason,
  type Feature,
  type GnisPoint,
  greatLakeMask,
  greatLakeParent,
  idFromKey,
  inDownstate,
  index,
  inRegion,
  inRegionFraction,
  isFreshwaterException,
  type Merged,
  mergeGroupWithReason,
  nameClaimsOf,
  nameMatchPairs,
  overlapDuplicates,
  polygonClaims,
  type RefusalReason,
  resolveGnisNames,
  SALT_MIN_CONTAINMENT,
  SQ_M_PER_ACRE,
  saltContainment,
  saltMask,
  statesFor,
  Union,
} from './mergeRules';
import { simplifyForStorage, toCanonicalBody } from './transform';
import type { CanonicalBody } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// What comes out
// ─────────────────────────────────────────────────────────────────────────────

/** A merged body that survived every filter, plus what we learned deciding that. */
export type KeptBody = Merged & {
  confidence: { name: string; polygon: string; cls: string };
  reviewReasons: ReviewReason[];
  inRegionFraction: number;
  /** The gazetteer's own Feature ID, where no catalogue in the group asserted one (D105). */
  gnisIdFromGazetteer?: string | undefined;
  /** Other kept bodies this one overlaps — the duplicate sweep's finding. */
  duplicateOf?: string[] | undefined;
  /** Every publisher's name for this water, winner first — see `nameClaimsOf`. */
  nameClaims: { source: ClaimSource; value: string }[];
};

/**
 * A bay that is an arm of a body we keep — **a sub-area, not a body** (founder, 2026-08-06).
 *
 * Carries the parent's *catalogue* ids rather than a Convex id, because the loader resolves the
 * parent the same way `importCanonical` resolves anything else: by the ids on the record. It also
 * carries its own ids, so a bay promoted to a body later (or demoted from one) is traceable.
 */
export interface SubAreaCandidate {
  key: string;
  name: string;
  parentKey: string;
  parentIds: { osmId?: string; nhdId?: string; threeDhpId?: string; gnisId?: string };
  areaSqM: number;
  polygon: Merged['polygon'];
  bbox: Merged['bbox'];
  sources: string[];
}

/** A group that did not become a body, named rather than counted. */
export interface DroppedBody {
  key: string;
  name: string;
  cls: string;
  acres: number;
  /** The stage that refused it — a `RefusalReason`, a region cut, or a floor rule. */
  reason: string;
  sources: string[];
}

export interface LaneStats {
  matched: number;
  ambiguous: number;
  none: number;
  nearMiss: number;
  /**
   * The targets geometry could not separate — **named, not just counted**.
   *
   * An `ambiguous` verdict writes no pair, so the target stays a singleton group and enters the
   * corpus as a body distinct from the one it may well be a duplicate of.
   */
  ambiguousIds: string[];
}

export interface MasterListStats {
  features: number;
  groups: number;
  refused: Map<RefusalReason, number>;
  refusedSamples: Map<RefusalReason, string[]>;
  outOfRegion: number;
  belowI84: number;
  saltWater: number;
  subAreas: number;
  gnisNamed: number;
  gnisRescued: number;
  droppedByFloor: Map<string, number>;
  confidence: { name: Map<string, number>; cls: Map<string, number>; polygon: Map<string, number> };
  queue: Map<string, number>;
  queued: number;
  backlog: number;
  duplicatePairs: number;
  /**
   * Bodies **one catalogue explicitly refused and another explicitly classified** — measured,
   * because nothing else can see them (second audit, 2026-08-06).
   *
   * `chooseClass` lets a real class beat a drop, and that rule is load-bearing: it is the 123-body
   * rescue the whole merge exists for, where OSM tags a body `wetland=marsh` and NHD calls the same
   * polygon `LakePond`. But it also means an *explicit* disagreement resolves silently — and
   * `scoreBody` cannot flag it either, because a refusal contributes `cls: null` and the scorer only
   * sees the non-null claims. So the two catalogues contradicting each other outright is currently
   * the one conflict that reaches nobody.
   *
   * The fixture is **Lac Saint-François**, 87,927 acres of the St. Lawrence on the NY/Québec border:
   * OSM tags it `water=lake` (and `salt=no`), 3DHP publishes it as `featuretype = 1 River`. It is in
   * the corpus as a `lakePond`, and it is the third-largest body in it.
   *
   * Counted rather than queued, deliberately, and that is D96's own discipline applied again: NHD
   * drops 43% of its reservoirs by FCODE (sewage treatment, settling, cooling), so promoting this to
   * a review reason without knowing the volume could bury the queue. Measure, then decide.
   */
  classDissent: number;
  classDissentSamples: string[];
  /**
   * Groups where a federal open-water class beat an OSM `wetland` tag — **resolved rather than
   * queued**, and counted here because it is (founder, 2026-08-07).
   *
   * 520 of run 6's 652 `class-conflict` rows, measured by joining every one to its NHD FTYPE. See
   * `settledWetlandDissent`: this is the 123-body rescue, and asking a moderator to confirm it 520
   * times is the 1,437-row mistake `RECONCILABLE_CLASS_PAIRS` already had to undo once.
   *
   * **The number is the point.** If it moves sharply between runs, a catalogue has changed under us
   * — and the original 123-body deletion went unnoticed precisely because the rule that caused it
   * left no count behind.
   */
  settledWetland: number;
  /**
   * Bays kept as bodies because their parent is a **Great Lake we deliberately do not carry**.
   *
   * Eleven on run 6, and they are not marginal: Chaumont Bay is 9,169 acres and Black River Bay
   * 4,455. See `greatLakeParent`. Counted rather than silent because the number is a direct
   * consequence of the choice not to store Erie and Ontario — if it ever moves, that choice moved.
   */
  greatLakeArms: number;
  lanes: { label: string; stats: LaneStats }[];
  nameLane: { pairs: number; ambiguous: string[] };
  matcher: { onlyNhd: number; onlyDhp: number; nhdHits: number; dhpHits: number };
}

export interface MasterList {
  bodies: KeptBody[];
  subAreas: SubAreaCandidate[];
  dropped: DroppedBody[];
  stats: MasterListStats;
}

/** Samples kept per refusal reason. Enough to recognise a pattern, small enough for a run row. */
export const REFUSAL_SAMPLE_CAP = 5;
/** Samples of the one conflict nothing else can see. See `MasterListStats.classDissent`. */
export const CLASS_DISSENT_SAMPLE_CAP = 10;
/** Samples kept per lane of targets geometry could not separate. Each is a possible duplicate. */
export const AMBIGUOUS_SAMPLE_CAP = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Matching
// ─────────────────────────────────────────────────────────────────────────────

/** Match every feature in `targets` against `candidates`, returning id→id pairs and a tally. */
export function matchLane(
  targets: readonly Feature[],
  candidates: readonly Feature[],
  onProgress?: (done: number, total: number) => void,
): {
  pairs: [string, string][];
  stats: LaneStats;
  iou: Map<string, number>;
  grid: Map<string, Feature[]>;
} {
  const grid = index(candidates);
  const pairs: [string, string][] = [];
  const iou = new Map<string, number>();
  const stats: LaneStats = { matched: 0, ambiguous: 0, none: 0, nearMiss: 0, ambiguousIds: [] };
  let done = 0;
  for (const target of targets) {
    if (++done % 20000 === 0) onProgress?.(done, targets.length);
    const nearby = new Map<string, Feature>();
    for (const cell of cellsFor(target.bbox)) {
      for (const c of grid.get(cell) ?? []) nearby.set(c.id, c);
    }
    if (nearby.size === 0) {
      stats.none++;
      continue;
    }
    const outcome = reconcileOne(target, [...nearby.values()] as unknown as ReconcileCandidate[]);
    if (outcome.verdict === 'matched') {
      stats.matched++;
      pairs.push([target.id, outcome.id]);
      iou.set(`${target.id}|${outcome.id}`, outcome.iou);
    } else if (outcome.verdict === 'ambiguous') {
      stats.ambiguous++;
      if (stats.ambiguousIds.length < AMBIGUOUS_SAMPLE_CAP) {
        stats.ambiguousIds.push(
          `${target.id} ↔ ${outcome.candidates
            .slice(0, 3)
            .map((c) => `${c.id}@${c.iou.toFixed(2)}`)
            .join(' / ')}`,
        );
      }
    } else {
      stats.none++;
      if (isNearMiss(outcome)) stats.nearMiss++;
    }
  }
  return { pairs, stats, iou, grid };
}

// ─────────────────────────────────────────────────────────────────────────────
// The master list
// ─────────────────────────────────────────────────────────────────────────────

export interface MasterListInput {
  osm: readonly Feature[];
  nhd: readonly Feature[];
  dhp: readonly Feature[];
  gnisGrid: Map<string, GnisPoint[]>;
  boundaryGrid: Map<string, Boundary[]>;
  downstate: readonly Boundary[];
  /**
   * The **state** outlines are deliberately not here: `statesFor` runs in `emitCanonicalBodies`,
   * where the record is built, and nothing in the admission decision reads a state code. Passing a
   * grid this function never consults would read as though it did.
   */
  log?: (message: string) => void;
}

/**
 * Three catalogues in, one master list out.
 *
 * Pure: every input is data and the only side effect is the optional `log`. That is what lets the
 * ordering — which is where this pipeline's bugs have all lived — be pinned by a fixture test rather
 * than discovered in a twenty-minute run.
 */
export function buildMasterList(input: MasterListInput): MasterList {
  const { osm, nhd, dhp, gnisGrid, boundaryGrid, downstate } = input;
  const log = input.log ?? (() => undefined);

  // ── Stage 1–3: the geometric lanes ────────────────────────────────────────
  // The federal pair first: 3DHP re-publishes NHD across the whole Northeast, so collapsing them
  // before either meets OSM is what keeps `independentVoices` from counting one source twice.
  log('stage 1: NHD ↔ 3DHP…');
  const federal = matchLane(dhp, nhd, (d, t) => log(`  3dhp→nhd: ${d} / ${t}`));
  log('stage 2: OSM ↔ NHD…');
  const osmNhd = matchLane(osm, nhd, (d, t) => log(`  osm→nhd: ${d} / ${t}`));
  log('stage 3: OSM ↔ 3DHP…');
  const osmDhp = matchLane(osm, dhp, (d, t) => log(`  osm→3dhp: ${d} / ${t}`));

  // ── Stage 4: the name lane ────────────────────────────────────────────────
  // What the area-ratio ceiling cannot reach. See `nameMatchPairs` — overlap is still required, so a
  // Mud Pond in Maine can never match a Mud Pond in New York.
  log('stage 4: OSM ↔ NHD by name…');
  const geometricallyMatched = new Set(osmNhd.pairs.map(([a]) => a));
  const named = nameMatchPairs(osm, osmNhd.grid, geometricallyMatched, sameName);
  log(`  ${named.pairs.length.toLocaleString()} name matches the geometry bar had refused`);

  // ── Our own error rate, measured ──────────────────────────────────────────
  //
  // 3DHP and NHD are the same polygons here, so an OSM body that one lane matched and the other
  // missed is **our** matcher erring — the only false-negative estimate available without
  // hand-labelling.
  //
  // **Both sides must be restricted to dual-published features, and only one of them was** (second
  // audit, 2026-08-06). The first version of this measured 15.53% and was corrected to restrict the
  // NHD side to features 3DHP also publishes — but left the 3DHP side unrestricted, so every OSM
  // body matching a 3DHP feature **NHD has no counterpart for** was counted as our error when it is
  // 3DHP's coverage. The asymmetry showed in the output and was the giveaway: 7 one way against 512
  // the other, over two catalogues that are the same data.
  const dualPublishedNhd = new Set(federal.pairs.map(([, nhdId]) => nhdId));
  const dualPublishedDhp = new Set(federal.pairs.map(([dhpId]) => dhpId));
  const eligible = new Set(
    osmNhd.pairs.filter(([, nhdId]) => dualPublishedNhd.has(nhdId)).map(([a]) => a),
  );
  const dhpHits = new Set(
    osmDhp.pairs.filter(([, dhpId]) => dualPublishedDhp.has(dhpId)).map(([a]) => a),
  );
  const onlyNhd = [...eligible].filter((a) => !dhpHits.has(a)).length;
  const onlyDhp = [...dhpHits].filter((a) => !eligible.has(a)).length;

  // ── Grouping ──────────────────────────────────────────────────────────────
  const iou = new Map([...federal.iou, ...osmNhd.iou, ...osmDhp.iou]);
  const union = new Union();
  for (const [a, b] of [...federal.pairs, ...osmNhd.pairs, ...osmDhp.pairs, ...named.pairs]) {
    union.join(a, b);
  }

  const all = [...osm, ...nhd, ...dhp];
  // **The three id namespaces must not collide**, and nothing used to say so. They happen not to
  // today — `way/…`, an NHD GUID or bare numeric, and 3DHP's `I…` — but `Union`, the group map and
  // the IoU map all share one flat string space, so a future source whose ids look like another's
  // would chain unrelated lakes with no error at all.
  const byId = new Map<string, Feature>();
  for (const f of all) {
    const clash = byId.get(f.id);
    if (clash && clash.source !== f.source) {
      throw new Error(
        `id namespace collision: ${f.source}:${f.id} and ${clash.source}:${clash.id} share one id`,
      );
    }
    byId.set(f.id, f);
  }
  const groups = new Map<string, Feature[]>();
  for (const f of all) {
    const root = union.find(f.id);
    const g = groups.get(root);
    if (g) g.push(f);
    else groups.set(root, [f]);
  }
  log(
    `grouped ${all.length.toLocaleString()} features into ${groups.size.toLocaleString()} bodies`,
  );

  // ── The salt mask ─────────────────────────────────────────────────────────
  // Built from features already in memory: the federal lanes carry SeaOcean / Estuary / Ocean rows
  // with `cls: null` rather than dropping them, which is what makes this free.
  const salt = saltMask([...nhd, ...dhp]);
  const saltGrid = index(salt);
  log(`  ${salt.length} federal salt-water polygons for the tidal veto`);

  // ── Merge ─────────────────────────────────────────────────────────────────
  const stats: MasterListStats = {
    features: all.length,
    groups: groups.size,
    refused: new Map(),
    refusedSamples: new Map(),
    outOfRegion: 0,
    belowI84: 0,
    saltWater: 0,
    subAreas: 0,
    gnisNamed: 0,
    gnisRescued: 0,
    droppedByFloor: new Map(),
    confidence: { name: new Map(), cls: new Map(), polygon: new Map() },
    queue: new Map(),
    queued: 0,
    backlog: 0,
    duplicatePairs: 0,
    classDissent: 0,
    classDissentSamples: [],
    settledWetland: 0,
    greatLakeArms: 0,
    lanes: [
      { label: '3dhp→nhd', stats: federal.stats },
      { label: 'osm→nhd', stats: osmNhd.stats },
      { label: 'osm→3dhp', stats: osmDhp.stats },
    ],
    nameLane: { pairs: named.pairs.length, ambiguous: named.ambiguous },
    matcher: { onlyNhd, onlyDhp, nhdHits: eligible.size, dhpHits: dhpHits.size },
  };
  const dropped: DroppedBody[] = [];

  const describe = (members: readonly Feature[], name: string, cls: string, areaSqM: number) => ({
    key: members[0] ? `${members[0].source}:${members[0].id}` : '(empty)',
    name,
    cls,
    acres: Math.round(areaSqM / SQ_M_PER_ACRE),
    sources: members.map((m) => `${m.source}:${m.id}`),
  });

  const merged: Merged[] = [];
  for (const members of groups.values()) {
    const { body, reason } = mergeGroupWithReason(members);
    if (body !== null) {
      merged.push(body);
      continue;
    }
    const refusal = reason ?? 'empty';
    stats.refused.set(refusal, (stats.refused.get(refusal) ?? 0) + 1);
    const bucket = stats.refusedSamples.get(refusal) ?? [];
    const first = members[0];
    if (bucket.length < REFUSAL_SAMPLE_CAP) {
      const acres = Math.round((first?.areaSqM ?? 0) / SQ_M_PER_ACRE);
      bucket.push(
        `${first?.source}:${first?.id} ${first?.name || '(unnamed)'} ${acres}ac [${members
          .map((f) => f.sourceToken)
          .join(',')}]`,
      );
      stats.refusedSamples.set(refusal, bucket);
    }
    dropped.push({
      ...describe(members, first?.name ?? '', 'refused', first?.areaSqM ?? 0),
      reason: refusal,
    });
  }

  // ── Phase 1: the geographic cuts ──────────────────────────────────────────
  //
  // Split from the admission floor below so the gazetteer can be resolved over the whole surviving
  // set at once — see `resolveGnisNames`. A name decides admission, so it has to be settled before
  // the floor, and it cannot be settled body-by-body.
  const survivors: {
    group: Merged;
    cls: WaterBodyClass;
    bayWithoutParent: boolean;
    parent: Merged | undefined;
  }[] = [];
  const kept: KeptBody[] = [];
  /**
   * What each survivor needs in order to have its review reasons computed — held **beside** the
   * bodies rather than on them, because `duplicate-candidate` cannot be decided until the whole
   * surviving set exists, and stashing scratch fields on a record that is about to be serialised is
   * how a `_scores` key ends up in the corpus.
   */
  const pending = new Map<
    string,
    {
      scores: Parameters<typeof mergeReviewReasons>[0]['confidence'];
      bayWithoutParent: boolean;
      bayParentKey?: string;
    }
  >();
  // The bay rule needs the whole merged set, so it runs here rather than in the classifier.
  // **Indexed on `memberBBox`, not `bbox`.** `index` reads `.bbox`, which is the outline we chose to
  // draw — so a candidate whose losing member reaches further than its winning one would not be in
  // the bay's cells at all and the member test in `bayParent` could never run. Sebago Cove is that
  // case: off OSM's Sebago Lake, inside NHD's.
  const bayGrid = index(
    merged.filter((m) => m.cls !== 'bay').map((m) => ({ ...m, bbox: m.memberBBox })),
  );
  // **The parents we deliberately do not carry.** Built from the same features already in memory as
  // `saltMask`, and for the mirror reason: the Great Lakes are refused as bodies but their geometry
  // still answers a question. See `greatLakeMask`.
  const greatLakes = greatLakeMask([...nhd, ...dhp]);
  const greatLakeGrid = index(greatLakes);
  log(`  ${greatLakes.length} Great Lake polygons for the arm rule`);

  for (const group of merged) {
    let cls = group.cls;
    // A bay is an arm OF something. With a parent it is a sub-area (N2); without one we cannot
    // support the claim at all, so it is demoted and queued — Half Moon Cove is the fixture.
    const parent = cls === 'bay' ? bayParent(group, bayGrid) : undefined;
    // **A bay whose only parent is a Great Lake keeps the class and stays a body** (founder,
    // 2026-08-07). It is not parentless — its parent is one we chose not to carry, and demoting
    // Chaumont Bay's 9,169 acres to `unclassified` records our storage decision as a fact about the
    // water. Checked only when `bayParent` found nothing, so an arm of a real corpus body is still a
    // sub-area and this can never outrank that.
    const greatLake =
      cls === 'bay' && parent === undefined ? greatLakeParent(group, greatLakeGrid) : undefined;
    if (greatLake !== undefined) stats.greatLakeArms++;
    const bayWithoutParent = cls === 'bay' && parent === undefined && greatLake === undefined;
    if (bayWithoutParent) cls = 'unclassified';

    // The region clip, applied to the merged body rather than to a lane.
    if (!inRegion(group, boundaryGrid)) {
      stats.outOfRegion++;
      dropped.push({
        ...describe(group.members, group.name, cls, group.areaSqM),
        key: group.key,
        reason: 'out-of-region',
      });
      continue;
    }

    // In one of our five states and still not ours — D111.
    if (inDownstate(group, downstate)) {
      stats.belowI84++;
      dropped.push({
        ...describe(group.members, group.name, cls, group.areaSqM),
        key: group.key,
        reason: 'ny-below-i84',
      });
      continue;
    }

    // **No salt water** (founder, 2026-08-06). Asked spatially rather than by group membership,
    // because the token veto only fires when the federal estuary polygon lands in the group — and
    // one estuary against forty OSM coves never does. See `saltContainment`.
    // The allow-list is checked first and reads the *merged* name, so a body NHD leaves unnamed is
    // still rescued by whichever catalogue named it. See `FRESHWATER_ALLOW_LIST` — two lakes dammed
    // above a tidal inlet of the same name, which no threshold can separate from the salt ponds
    // sitting either side of them.
    if (
      !isFreshwaterException(group.name) &&
      saltContainment(group, saltGrid) >= SALT_MIN_CONTAINMENT
    ) {
      stats.saltWater++;
      stats.refused.set('salt-water', (stats.refused.get('salt-water') ?? 0) + 1);
      const bucket = stats.refusedSamples.get('salt-water') ?? [];
      if (bucket.length < REFUSAL_SAMPLE_CAP) {
        bucket.push(
          `${group.key} ${group.name || '(unnamed)'} ${Math.round(group.areaSqM / SQ_M_PER_ACRE)}ac`,
        );
        stats.refusedSamples.set('salt-water', bucket);
      }
      dropped.push({
        ...describe(group.members, group.name, cls, group.areaSqM),
        key: group.key,
        reason: 'salt-water',
      });
      continue;
    }

    survivors.push({ group, cls, bayWithoutParent, parent });
  }

  // ── Phase 2: the gazetteer, resolved across ALL survivors at once ─────────
  //
  // **GNIS runs BEFORE the floor**, and that ordering is the whole point of the lane: D96 admits a
  // named wetland at five acres and refuses an unnamed one under fifty, so a gazetteer name does not
  // relabel a body — it decides whether the body exists.
  //
  // **And it resolves globally, which is why the loop is split in two.** Asked per body, the lane's
  // ambiguity rule only caught *many points → one body*; the mirror case let one point in a cluster
  // of ponds name each of them independently, and the run found **963 GNIS ids on more than one body
  // under the same name** — six different ponds all called "Twinings Pond". See `resolveGnisNames`.
  const gnisNames = resolveGnisNames(
    survivors.filter((s) => s.group.name.length === 0).map((s) => s.group),
    gnisGrid,
  );

  // ── Phase 3: the admission floor, and what survives it ────────────────────
  for (const { group, cls, bayWithoutParent, parent } of survivors) {
    let name = group.name;
    let namedByGnis = false;
    let gnisIdFromGazetteer: string | undefined;
    if (name.length === 0) {
      const found = gnisNames.get(group.key);
      if (found !== undefined && found.name.length > 0) {
        name = found.name;
        gnisIdFromGazetteer = found.featureId;
        namedByGnis = true;
        stats.gnisNamed++;
        if (!belongsInCorpus({ name: '', surfaceAreaSqM: group.areaSqM, type: cls })) {
          stats.gnisRescued++;
        }
      }
    }

    if (!belongsInCorpus({ name, surfaceAreaSqM: group.areaSqM, type: cls })) {
      // `name`, not `group.name` — the refusal was decided against the GNIS-augmented name.
      const reason = dropReason({ name, cls, areaSqM: group.areaSqM });
      stats.droppedByFloor.set(reason, (stats.droppedByFloor.get(reason) ?? 0) + 1);
      dropped.push({
        ...describe(group.members, name, cls, group.areaSqM),
        key: group.key,
        reason,
      });
      continue;
    }

    const classClaims = group.members
      .filter((m) => m.cls !== null)
      .map((m) => ({ source: m.source, value: m.cls as WaterBodyClass }));
    // Counted before `scoreBody` swallows it — see `MasterListStats.settledWetland`.
    if (settledWetlandDissent(classClaims)) stats.settledWetland++;
    const scores = scoreBody({
      names: [
        ...group.members.filter((m) => m.name).map((m) => ({ source: m.source, value: m.name })),
        ...(namedByGnis ? [{ source: 'gnis' as ClaimSource, value: name }] : []),
      ],
      polygons: polygonClaims(group, iou),
      classes: classClaims,
      depths: [],
    });
    for (const k of ['name', 'cls', 'polygon'] as const) {
      stats.confidence[k].set(scores[k], (stats.confidence[k].get(scores[k]) ?? 0) + 1);
    }
    if (needsAttention(scores)) stats.backlog++;
    // One catalogue refused this outright while another named a class. See `classDissent`.
    if (group.members.some((m) => m.cls === null) && group.members.some((m) => m.cls !== null)) {
      stats.classDissent++;
      if (stats.classDissentSamples.length < CLASS_DISSENT_SAMPLE_CAP) {
        stats.classDissentSamples.push(
          `${group.key} ${name || '(unnamed)'} ${Math.round(group.areaSqM / SQ_M_PER_ACRE)}ac ` +
            `kept ${cls}, refused by [${group.members
              .filter((m) => m.cls === null)
              .map((m) => m.sourceToken)
              .join(',')}]`,
        );
      }
    }

    kept.push({
      ...group,
      cls,
      name,
      confidence: { name: scores.name, polygon: scores.polygon, cls: scores.cls },
      // Filled in after the sweep below, which needs the whole surviving set.
      reviewReasons: [],
      gnisIdFromGazetteer,
      // The losing names, kept. `namedByGnis` rather than `name`, so the gazetteer is only credited
      // where it actually supplied the name rather than where it merely agreed with a catalogue.
      nameClaims: nameClaimsOf(group.members, namedByGnis ? name : undefined),
      inRegionFraction: inRegionFraction(group, boundaryGrid),
    });
    pending.set(group.key, {
      scores,
      bayWithoutParent,
      ...(parent ? { bayParentKey: parent.key } : {}),
    });
  }

  // ── Bays become sub-areas, but only of a parent that survived ─────────────
  //
  // A bay whose parent was itself refused — out of region, or salt — has nothing to be an arm of, so
  // it falls back to the no-parent branch: demoted and queued, exactly as if the grid had never found
  // one. Emitting a sub-area pointing at a body the loader will never create is the one outcome that
  // must not happen, because it fails at load time rather than here.
  const keptKeys = new Set(kept.map((k) => k.key));
  const bodies: KeptBody[] = [];
  const subAreas: SubAreaCandidate[] = [];
  const byKey = new Map(kept.map((k) => [k.key, k]));
  for (const body of kept) {
    const state = pending.get(body.key);
    const parentKey = state?.bayParentKey;
    if (parentKey === undefined || !keptKeys.has(parentKey)) {
      if (parentKey !== undefined && state) {
        // The parent did not survive: this is a bay without a parent after all.
        body.cls = 'unclassified';
        state.bayWithoutParent = true;
      }
      bodies.push(body);
      continue;
    }
    const parent = byKey.get(parentKey);
    subAreas.push({
      key: body.key,
      name: body.name,
      parentKey,
      parentIds: catalogueIdsOf(parent?.members ?? [], parent?.gnisIdFromGazetteer),
      areaSqM: body.areaSqM,
      // **Simplified, like every other geometry we store** (D48) — and this was emitting the raw
      // source outline. A sub-area's polygon is a stored render payload under the same ~5 m rule and
      // the same 8,192-element cap as a body's, so the artifact was wrong on its own terms; it also
      // made the loader's clip run at full resolution against a parent that is, by construction, one
      // of the largest bodies in the corpus. Spencer Bay against Moosehead timed the mutation out at
      // its 1-second limit.
      polygon: simplifyForStorage(body.polygon),
      bbox: body.bbox,
      sources: body.members.map((m) => `${m.source}:${m.id}`),
    });
    stats.subAreas++;
  }

  // ── The duplicate sweep ───────────────────────────────────────────────────
  const duplicates = overlapDuplicates(bodies, DUPLICATE_SWEEP_MIN_IOU);
  stats.duplicatePairs = [...duplicates.values()].reduce((n, v) => n + v.length, 0) / 2;
  for (const body of bodies) {
    const overlaps = duplicates.get(body.key);
    if (overlaps) body.duplicateOf = overlaps;
    const state = pending.get(body.key);
    if (state === undefined) throw new Error(`no pending state for kept body ${body.key}`);
    body.reviewReasons = mergeReviewReasons({
      confidence: state.scores,
      bayWithoutParent: state.bayWithoutParent,
      sameSourceDuplicate: body.sameSourceDuplicate,
      overlapDuplicate: overlaps !== undefined,
    });
    if (body.reviewReasons.length > 0) {
      stats.queued++;
      for (const r of body.reviewReasons) stats.queue.set(r, (stats.queue.get(r) ?? 0) + 1);
    }
  }

  // ── The balance the first audit found missing in the middle ───────────────
  //
  // The lane ledgers assert `seen == kept + dropped` and the emit stage asserts
  // `kept == emitted + emitFailed`. Between them sat the stage that makes every admission decision,
  // and it asserted nothing: a `continue` added anywhere in the loop above would have removed lakes
  // from the corpus and from the report at the same time, which is precisely the shape of failure
  // that cannot be noticed from a summary.
  const accounted = bodies.length + subAreas.length + dropped.length;
  if (accounted !== groups.size) {
    throw new Error(
      `master list does not balance: ${bodies.length} bodies + ${subAreas.length} sub-areas + ` +
        `${dropped.length} dropped = ${accounted}, against ${groups.size} groups`,
    );
  }

  return { bodies, subAreas, dropped, stats };
}

// ─────────────────────────────────────────────────────────────────────────────
// The emit stage
// ─────────────────────────────────────────────────────────────────────────────

export interface EmitResult {
  emitted: CanonicalBody[];
  emittedKeys: Set<string>;
  failures: Map<string, number>;
  failureKeys: string[];
}

/** Bodies named when the geometry transform refused them. */
export const EMIT_FAILURE_SAMPLE_CAP = 10;

/**
 * Turn kept bodies into the records `importCanonical` stores.
 *
 * Separate from `buildMasterList` only so the two can be read apart; it is called immediately after
 * and is covered by the same fixture test, because the wire contract — which fields reach Convex — is
 * exactly what the first audit found broken (`states` was emitted, declared, and absent from the
 * validator, so every batch would have been rejected).
 */
export function emitCanonicalBodies(
  kept: readonly KeptBody[],
  stateGrid: Map<string, (Boundary & { name: string })[]>,
): EmitResult {
  const emitted: CanonicalBody[] = [];
  const emittedKeys = new Set<string>();
  const failures = new Map<string, number>();
  const failureKeys: string[] = [];
  for (const k of kept) {
    try {
      emitted.push(
        toCanonicalBody({
          source: k.geometrySource as 'osm' | 'nhd' | '3dhp',
          // The arrival key stays the id of whichever catalogue drew the outline, so the existing
          // contour tile stamps keep resolving through one more campaign (D93).
          externalId: idFromKey(k.key),
          name: k.name,
          type: k.cls,
          geometry: k.polygon,
          geometrySource: k.geometrySource as 'osm' | 'nhd' | '3dhp',
          states: statesFor(k, stateGrid),
          // **Measured on the source geometry, which is the number the floor was decided on.**
          sourceAreaSqM: k.areaSqM,
          inRegionFraction: k.inRegionFraction,
          confidence: k.confidence as never,
          reviewReasons: k.reviewReasons,
          nameClaims: k.nameClaims,
          ...catalogueIdsOf(k.members, k.gnisIdFromGazetteer),
        }),
      );
      emittedKeys.add(k.key);
    } catch (err) {
      // A body whose geometry defeats the transform is one body, not the run.
      const reason = err instanceof Error ? err.message.slice(0, 60) : String(err);
      failures.set(reason, (failures.get(reason) ?? 0) + 1);
      if (failureKeys.length < EMIT_FAILURE_SAMPLE_CAP) failureKeys.push(k.key);
    }
  }
  return { emitted, emittedKeys, failures, failureKeys };
}
