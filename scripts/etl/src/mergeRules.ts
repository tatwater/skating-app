/**
 * The rules the master list is built from — extracted from `merge.ts` so they can be tested (N7).
 *
 * ## Why this file exists
 *
 * `merge.ts` was excluded from coverage as *"subprocess + file-I/O glue"*, and that description was
 * accurate the day it was written. It stopped being accurate the moment the file grew a merge rule.
 * By the time it produced a 27,074-body master list it held the veto set, the class precedence order,
 * the name union, a union-find, the region clip, the GNIS naming rule and the bay-parent rule — every
 * one of which decides whether a lake exists, and none of which had a test.
 *
 * The split is the same one `bodyIdentity.ts` makes and for the same reason: **the caller does the
 * I/O, this makes the decisions.** `merge.ts` keeps `ogr2ogr`, `osmium`, the readline loops and the
 * report; everything below is pure and takes what it needs as an argument.
 *
 * ## What is deliberately NOT changed here
 *
 * This is an extraction, not a rewrite. Two rules below are known to be weaker than they look — the
 * bay-parent test compares bounding boxes rather than polygons, and `inRegion` samples eight vertices
 * per ring — and both are preserved exactly as they ran, with their limits pinned by tests that say
 * so. Changing either moves the corpus, which is a decision to take on measurements rather than
 * inside a refactor.
 */

import {
  type AttributeClaim,
  assertsOceanOrGreatLake,
  type BBox,
  bboxIntersects,
  type ClaimSource,
  classifyNhd,
  classifyOsmTags,
  classifyThreeDhp,
  classifyWaterBody,
  distanceToPolygonMeters,
  distinctNameClaims,
  exceedsAreaCeiling,
  expandBBox,
  HARD_MIN_SURFACE_AREA_SQM,
  OCEAN_NAME_VETO_MIN_ACRES,
  type OsmTagBag,
  pointInPolygon,
  polygonBBox,
  polygonIoU,
  RECONCILE_MIN_IOU_WITH_GNIS,
  surfaceAreaSqM,
  type WaterBodyClass,
} from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import { normalizeGnisId, normalizeNhdId } from './nhdArchive';

/** 0.1° ≈ 11 km. A few candidates per cell in our region. */
export const CELL_DEG = 0.1;

/** Square metres in an acre. */
export const SQ_M_PER_ACRE = 4046.8564224;

/** One catalogue's claim about one polygon, after classification. */
export interface Feature {
  readonly source: ClaimSource;
  readonly id: string;
  readonly name: string;
  readonly cls: WaterBodyClass | null;
  /** The classifier's token, e.g. `3dhp:featuretype=4` — what the ladder concluded. */
  readonly token: string;
  /**
   * The **catalogue's own** token, which is what the veto reads.
   *
   * Separate from `token` because the classification ladder can replace that one: a feature NHD
   * publishes as FTYPE 493 whose name contains "Reservoir" comes back with `token: 'name:reservoir'`,
   * shedding the only evidence that it is a tidal estuary. See `ClassVerdict.sourceToken`.
   */
  readonly sourceToken: string;
  readonly gnisId?: string | undefined;
  readonly polygon: Polygon | MultiPolygon;
  readonly bbox: BBox;
  readonly areaSqM: number;
}

/** One lake, as agreed by every catalogue that knows it. */
export interface Merged {
  key: string;
  members: Feature[];
  name: string;
  cls: WaterBodyClass;
  areaSqM: number;
  bbox: BBox;
  polygon: Polygon | MultiPolygon;
  geometrySource: ClaimSource;
  sameSourceDuplicate: boolean;
  /**
   * The members a `sameSourceDuplicate` group absorbed — **named, because they leave no other trace**
   * (N7 second audit).
   *
   * A group holding two features from one catalogue merges into one body: `chooseGeometry` keeps one
   * outline and `catalogueIdsOf` keeps one id per catalogue, so the other feature's polygon *and* its
   * id are gone. The plan's own verification section describes such a group as one that "queues
   * rather than merging"; it queues **and** merges, and if the union-find chained two genuinely
   * distinct lakes then one of them silently ceased to exist. Listing the losers is what makes the
   * flag reviewable — a moderator opening the queue can see exactly which feature was dropped.
   */
  absorbedIds: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// The veto
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refusals that **no other catalogue may overrule** (founder call, 2026-08-04: no Great Lakes, no
 * ocean, no Long Island Sound).
 *
 * The ordinary merge rule is that one source's refusal loses to another's class — that is what
 * rescues a body OSM calls `wetland=marsh` and NHD calls `LakePond`, and it is the whole reason the
 * merge exists. It is wrong here, and the first real run proved it: NHD publishes **Lake Erie as
 * FTYPE 390 LakePond** at 6.4 million acres and **Long Island Sound as FTYPE 493 Estuary** at
 * 801,802, so a permissive merge hands the corpus an ocean on a technicality.
 *
 * `Ocean or Great Lake` is 3DHP's own dedicated class and there is no reading of it under which we
 * want the body. A veto is the right shape precisely because it is *not* evidence to be weighed.
 */
export const VETO_TOKENS: ReadonlySet<string> = new Set([
  '3dhp:featuretype=4', // Ocean or Great Lake
  'nhd:ftype=445', // SeaOcean
  'nhd:ftype=493', // Estuary — tidal and saline; Long Island Sound is the fixture
]);

/**
 * Why a group was vetoed — three independent refusals, counted apart because they fail differently.
 *
 * `token` is a catalogue naming the ocean. `name` and `area` need **no cross-catalogue match at all**,
 * which is the point: the token veto only fires when the vetoing feature landed in the merged group,
 * and that is contingent on a `polygonIoU` match succeeding over the largest polygons in the archive.
 */
export type VetoReason = 'token' | 'name' | 'area';

/**
 * Does any member of this group carry a refusal no other source may overturn?
 *
 * ## Three vetoes, and only the first one used to exist
 *
 * 1. **`token`** — a catalogue's own class says ocean (`VETO_TOKENS`). Read from `sourceToken`, never
 *    from `token`, because the classification ladder can overwrite the latter with `name:reservoir`.
 * 2. **`name`** — `assertsOceanOrGreatLake`. **NHD publishes Lake Erie as FTYPE 390 `LakePond`**, so
 *    rule 1 could only refuse Erie if 3DHP's counterpart matched it geometrically; the merge's own
 *    test suite pinned that hole rather than closing it. A name needs no match.
 * 3. **`area`** — over `MAX_BODY_SURFACE_AREA_ACRES` without an allow-list entry. The unnamed half of
 *    the same hole: an ocean polygon nobody named, a fragment of a Great Lake, a bay of the Gulf of
 *    Maine. Measured on the **largest** member's area, because a group's own outline has not been
 *    chosen yet at veto time and the biggest claim is the conservative one to test.
 *
 * Returns the reason rather than a boolean so the run report can tell "the veto is working" from
 * "the veto is now doing something new", which a single count cannot.
 */
export function vetoReason(members: readonly Feature[]): VetoReason | undefined {
  if (members.some((m) => VETO_TOKENS.has(m.sourceToken))) return 'token';
  // **The name veto reads the area too**, because a substring rule on its own deletes real lakes:
  // `Lake Superior` is a 179-acre body in Sullivan County, New York, and `Little Lake Erie` a
  // 4-acre reservoir. See `OCEAN_NAME_VETO_MIN_ACRES`. Measured against the *largest* member for the
  // same reason the ceiling is: the group's own outline has not been chosen yet.
  const biggest = members.reduce((max, m) => Math.max(max, m.areaSqM), 0);
  if (members.some((m) => assertsOceanOrGreatLake(m.name, biggest))) return 'name';
  const largest = members.reduce((max, m) => Math.max(max, m.areaSqM), 0);
  // **Every name any member offers**, not the first one. Champlain is the allow-list's only entry and
  // three catalogues spell it three ways; testing only the first named member would veto the largest
  // body we cover on whichever ordering the union-find happened to produce.
  const names = members.map((m) => m.name).filter((n) => n.length > 0);
  const allowed = names.some((name) => !exceedsAreaCeiling({ name, surfaceAreaSqM: largest }));
  if (!allowed && exceedsAreaCeiling({ name: '', surfaceAreaSqM: largest })) return 'area';
  return undefined;
}

/** Does any member of this group carry a refusal no other source may overturn? */
export function isVetoed(members: readonly Feature[]): boolean {
  return vetoReason(members) !== undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Salt water
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **No salt water** (founder call, 2026-08-06) — and the reason it needed a new mechanism.
 *
 * The token veto refuses NHD's `Estuary` and `SeaOcean` and 3DHP's `Ocean or Great Lake`, but only
 * when the vetoing feature **lands in the merged group** — which requires a cross-catalogue
 * `polygonIoU` match to have succeeded. It routinely does not: the federal catalogues draw one
 * enormous estuary polygon where OSM draws forty separate coves, so the IoU between any one cove and
 * the estuary is near zero and the cove arrives as its own body. And then `hasBayParent` finds no
 * parent for it — because the parent *is* the ocean, which we refused — so the bay is **demoted to
 * `unclassified` and admitted**, which is the worst of the available outcomes: tidal water in the
 * corpus wearing the label we give water nobody has described.
 *
 * Measured on the pre-fix master list: **364 bodies** intersect a federal salt-water polygon, 87 of
 * them more than half contained. Every single one inspected from 8% containment upward is tidal —
 * Waquoit Bay, New Bedford Harbor, Hampton Harbor, Plum Island Sound, Merrymeeting Bay, Seabrook
 * Salt Marsh, Menemsha Pond, Sengekontacket Pond, Cutler Harbor.
 *
 * So the fix is to ask the question **spatially instead of by group membership**: is this body
 * inside water a federal catalogue calls the sea? That needs no match to succeed, which is the
 * property `VETO_TOKENS` lacks and the reason Lake Erie escaped it in the first audit.
 */
export const SALT_TOKENS: ReadonlySet<string> = new Set([
  'nhd:ftype=445', // SeaOcean
  'nhd:ftype=493', // Estuary — NHD's own definition is tidal and saline
  '3dhp:featuretype=4', // Ocean **or Great Lake** — see `isGreatLakeFeature`
]);

/**
 * The Great Lakes, which 3DHP files under the same code as the Atlantic and which are **fresh**.
 *
 * `3dhp:featuretype=4` is spelled *Ocean or Great Lake*, and treating the whole class as salt was
 * wrong in a way the measurement caught: it flagged **Braddock Bay** and **Blind Sodus Bay**, which
 * are freshwater embayments of Lake Ontario and are skated. The clip holds 19 type-4 features — Lake
 * Huron, Lake Erie, Lake Ontario, and 16 Atlantic pieces, of which the 7 unnamed ones all sit on the
 * Maine coast between -70.4° and -67.0°. So the split is exact and needs only the name.
 *
 * The lakes themselves are still refused, by the token veto and by the area ceiling. What this
 * preserves is their *shoreline*.
 */
const GREAT_LAKE_NAME = /\b(?:erie|ontario|huron|michigan|superior)\b/i;

/** Is this feature one of the Great Lakes rather than the sea? Fresh water; do not mask with it. */
export function isGreatLakeFeature(feature: Pick<Feature, 'name'>): boolean {
  return GREAT_LAKE_NAME.test(feature.name);
}

/**
 * Every feature that *is* the sea, indexed for containment — built from the lanes we already loaded.
 *
 * These features are in memory anyway: `parseNhdFeature` and `parseThreeDhpFeature` return them with
 * `cls: null` rather than dropping them, so the mask costs one pass over an array and no new source.
 */
export function saltMask(features: readonly Feature[]): Feature[] {
  return features.filter((f) => SALT_TOKENS.has(f.sourceToken) && !isGreatLakeFeature(f));
}

/**
 * How much of a body has to lie in the sea before we call it the sea.
 *
 * **Five percent**, and the number comes from the measured distribution rather than from caution.
 * The containment histogram over the 364 intersecting bodies is smooth from 0 to 1 with no gap to
 * cut at, so the threshold had to be set by *reading the names in each band* — and every band down
 * to 0.08 is unmixed salt water. Below that the bodies are grazing contacts, where a freshwater pond
 * behind a barrier beach shares a few vertices with the estuary that drains it.
 *
 * The asymmetry is deliberate and is the opposite of `NAME_DROP`'s: keeping a tidal body is a claim
 * about ice on water that goes out twice a day, which is a safety statement we do not want to make;
 * dropping a coastal freshwater pond costs one row and N7b can put it back. Every refusal is named
 * in `dropped.ndjson`, so this is reviewable rather than merely asserted.
 */
export const SALT_MIN_CONTAINMENT = 0.05;

/**
 * Is this body the sea? — the share of its outline inside a federal salt-water polygon.
 *
 * Sampled densely rather than at `REGION_SAMPLE_POINTS`: eight points per ring quantises the answer
 * into ninths, which put a run of unrelated bodies at exactly 0.44 and made the distribution
 * unreadable. `SALT_SAMPLE_POINTS` is the smallest count at which the bands separate.
 */
export function saltContainment(
  body: { polygon: Polygon | MultiPolygon; bbox: BBox },
  grid: Map<string, Feature[]>,
): number {
  const points = sampleOutlineDense(body.polygon, SALT_SAMPLE_POINTS);
  if (points.length === 0) return 0;
  const seen = new Set<Feature>();
  let best = 0;
  for (const cell of cellsFor(body.bbox)) {
    for (const salt of grid.get(cell) ?? []) {
      if (seen.has(salt)) continue;
      seen.add(salt);
      if (!bboxIntersects(salt.bbox, body.bbox)) continue;
      let inside = 0;
      for (const [lng, lat] of points) {
        if (pointInPolygon({ lat, lng }, salt.polygon)) inside++;
      }
      best = Math.max(best, inside / points.length);
      // Nothing above can change the verdict, and the ocean polygon is the most expensive
      // containment test in the pipeline.
      if (best >= 1) return best;
    }
  }
  return best;
}

/** Points sampled around an outline for the salt test. See `saltContainment`. */
export const SALT_SAMPLE_POINTS = 64;

/**
 * Freshwater bodies a federal **estuary polygon covers anyway** — the salt veto's allow-list.
 *
 * ## Why a list, when everything else here is a rule
 *
 * The veto is right 943 times out of 945, and the two it is wrong about cannot be separated from the
 * rest by any threshold or tag. Measured, on the 2026-08-06 run:
 *
 * | body | containment | | |
 * | --- | --- | --- | --- |
 * | **Nequasset Lake**, Woolwich ME | 12.3% | 449 ac | **fresh** — Bath's drinking-water supply, above the fish ladder |
 * | Menemsha Pond, Martha's Vineyard | 15.6% | 695 ac | salt |
 * | Cuttyhunk Pond | 17.3% | 112 ac | salt |
 * | **Winnegance Lake**, Phippsburg ME | 46.3% | 187 ac | **fresh** — impounded above the Winnegance Creek tidal dam |
 * | Little Bay, NH | 47.8% | 1,827 ac | salt |
 *
 * A fresh lake sits *below* a salt pond and another sits *above* a tidal bay, so there is no bar to
 * move. Both are lakes dammed immediately above a tidal inlet of the same name, and NHD's estuary
 * polygon simply runs past the dam.
 *
 * ## And the tag that looked like the answer is not one — measured, so nobody re-tries it
 *
 * `waterClass.ts` has said since it was written that an estuary is *"filtered by elevation, not by
 * class"*, and OSM does carry `ele` on some water. It does not work. Of the **12** salt-refused
 * bodies tagged `ele >= 3` m — high enough that tidal is impossible — only Winnegance is actually
 * fresh; the rest are Maine coves (Gleason Cove `ele=13`, Federal Harbor `ele=14`, Morong Cove,
 * Weir Cove, Red Cove…). **Crows Pond settles it: `ele=5` and `tidal=yes` on the same feature.**
 * Whatever mappers are measuring there, it is not the water surface, and a rescue rule built on it
 * would readmit ten tidal coves to save one lake.
 *
 * `tidal=yes` is the one tag that *does* hold — 96 of the 595 refused OSM bodies carry it, every one
 * of them already refused, which is 96 independent confirmations rather than a rule we need.
 *
 * **Matched on the folded name, like `AREA_CEILING_ALLOW_LIST`, and kept small on purpose.** Every
 * entry costs a review; the general escape hatch for anything this rule takes wrongly is N7b's
 * `includedByRequest`, one body at a time with a human looking.
 */
export const FRESHWATER_ALLOW_LIST: ReadonlySet<string> = new Set([
  'nequasset lake', // 449 ac, 12.3% contained — ME; the Bath Water District's supply
  'winnegance lake', // 187 ac, 46.3% contained — ME; above the Winnegance Creek dam
]);

/** Is this body named as one of the freshwater exceptions the salt veto must not take? */
export function isFreshwaterException(name: string): boolean {
  return FRESHWATER_ALLOW_LIST.has(name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Grouping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Union-find over matched pairs — how three lanes of pairwise matches become one group per lake.
 *
 * **Iterative, not recursive.** The recursive form is the textbook one and it was what shipped, but
 * `find` recurses once per link in an unbalanced chain, and this runs over 178,690 features whose
 * chain lengths are set by data we do not control. A stack overflow here would surface as a crash
 * two hours into a merge run with no partial output.
 */
export class Union {
  private readonly parent = new Map<string, string>();

  find(a: string): string {
    // Walk to the root without recursing…
    let root = a;
    for (;;) {
      const next = this.parent.get(root);
      if (next === undefined || next === root) break;
      root = next;
    }
    // …then compress every node on the path we just walked.
    let node = a;
    while (node !== root) {
      const next = this.parent.get(node) ?? node;
      this.parent.set(node, root);
      if (next === node) break;
      node = next;
    }
    return root;
  }

  join(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Every 0.1° cell a bounding box touches. */
export function cellsFor(box: BBox): string[] {
  const out: string[] = [];
  for (let x = Math.floor(box.minLng / CELL_DEG); x <= Math.floor(box.maxLng / CELL_DEG); x++) {
    for (let y = Math.floor(box.minLat / CELL_DEG); y <= Math.floor(box.maxLat / CELL_DEG); y++) {
      out.push(`${x}:${y}`);
    }
  }
  return out;
}

/** Bucket features into the cells their bounding boxes touch, for candidate lookup. */
export function index<T extends { bbox: BBox }>(features: readonly T[]): Map<string, T[]> {
  const grid = new Map<string, T[]>();
  for (const f of features) {
    for (const cell of cellsFor(f.bbox)) {
      const bucket = grid.get(cell);
      if (bucket) bucket.push(f);
      else grid.set(cell, [f]);
    }
  }
  return grid;
}

/** Does `outer` fully contain `inner`? A cheap prefilter before a containment test. */
export function covers(outer: BBox, inner: BBox): boolean {
  return (
    outer.minLat <= inner.minLat &&
    outer.minLng <= inner.minLng &&
    outer.maxLat >= inner.maxLat &&
    outer.maxLng >= inner.maxLng
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The merge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rank for picking the stored class when a group disagrees. Mirrors core's `CLASS_RANK`.
 *
 * `reservoir` outranks `lakePond` because it is the *more specific* claim — a source that says
 * "reservoir" knows something a source that says "lake" does not. `unclassified` is last because it
 * is not a claim at all.
 */
export const CLASS_ORDER: readonly WaterBodyClass[] = [
  'reservoir',
  'river',
  'lakePond',
  'bay',
  'wetland',
  'unclassified',
];

/**
 * Pick the name for a merged group: **union, preferring the more specific.**
 *
 * A name is a boolean assertion that a place is a place, so taking one over its absence biases
 * nothing (D94). "More specific" is operationalised as *longer*, which is a heuristic and is worth
 * naming as one: it prefers "Little Moose Pond" to "Moose Pond", which is right when the catalogues
 * disagree about which lake this is, and prefers a parenthesised qualifier to a bare name, which is
 * arguably wrong. Ties break toward the earlier member, so a stable order in equals a stable name out.
 */
export function chooseName(members: readonly Feature[]): string {
  let best: Feature | undefined;
  for (const m of members) {
    if (m.name.length === 0) continue;
    if (best === undefined) {
      best = m;
      continue;
    }
    const delta = NAME_SOURCE_RANK[m.source] - NAME_SOURCE_RANK[best.source];
    // Rank first; length only inside one source, where it separates two features of one catalogue in
    // a `sameSourceDuplicate` group and nothing else.
    if (delta < 0 || (delta === 0 && m.name.length > best.name.length)) best = m;
  }
  return best?.name ?? '';
}

/**
 * Every publisher's name for a group, **in authority order** — the winner and the losers alike (N7).
 *
 * `chooseName` returns one string and the rest used to be dropped on the floor. That cost 463 bodies
 * their local name and made them unfindable under it: Auburn's water supply is stored as NHD's
 * `The Basin` while OSM — and every skater — calls it `Lake Auburn`.
 *
 * **Sorted by `NAME_SOURCE_RANK`, because `distinctNameClaims` keeps the first source it sees for a
 * given spelling.** Hand it member order and a spelling both NHD and 3DHP publish would be credited
 * to whichever feature happened to be first in the group, which is grid iteration order — the same
 * nondeterminism `chooseName`'s own rank exists to remove.
 *
 * The gazetteer name is appended as a `gnis` claim rather than merged into a member, because it has
 * no member to belong to: it is what `resolveGnisNames` supplied for a body no catalogue named.
 */
export function nameClaimsOf(
  members: readonly Feature[],
  gnisName?: string | undefined,
): { source: ClaimSource; value: string }[] {
  const claims: { source: ClaimSource; value: string }[] = members
    .filter((m) => m.name.length > 0)
    .map((m) => ({ source: m.source, value: m.name }));
  if (gnisName !== undefined && gnisName.length > 0)
    claims.push({ source: 'gnis', value: gnisName });
  return distinctNameClaims(
    claims.sort((a, b) => NAME_SOURCE_RANK[a.source] - NAME_SOURCE_RANK[b.source]),
  );
}

/**
 * Whose name wins when two catalogues both have one — **authority, not length**.
 *
 * The rule this replaced was longest-wins, and its own docstring defended it as *"right when the
 * catalogues disagree about which lake this is"*. That is backwards: if the catalogues disagree about
 * which lake this is, the merge is already wrong and preferring the longer string entrenches the
 * error under a more confident-looking label. Length is not evidence of anything.
 *
 * The order is the order of authority over US place names:
 *
 * | rank | source | what its name actually is |
 * | --- | --- | --- |
 * | 0 | `gnis` | the gazetteer, from the body that assigns the names |
 * | 1 | `nhd` | NHD's `gnis_name` column — **which IS GNIS**, joined at publication |
 * | 2 | `3dhp` | `gnisidlabel`, the same gazetteer one release later |
 * | 3 | `osm` | a mapper's free text: local, often better, and unaccountable |
 *
 * **OSM ranking last is a real trade and worth naming.** OSM frequently carries the name a local
 * would use where the gazetteer carries an official one, and we lose that. What we buy is that the
 * stored name is always traceable to a publisher, which is the property a name-conflict queue needs
 * in order to be worth opening — and the OSM name survives on the row as `osmId`'s feature, so it is
 * recoverable rather than gone.
 */
export const NAME_SOURCE_RANK: Readonly<Record<ClaimSource, number>> = {
  // A moderator has looked at it, which ends the question — the same precedence `scoreAttribute`
  // gives `user`. No merged feature carries this source today; it is here so that the day one does,
  // the rule is already right rather than quietly outranked by a gazetteer.
  user: -1,
  gnis: 0,
  nhd: 1,
  '3dhp': 2,
  osm: 3,
  // Not a catalogue: `name` is a keyword read off a string a catalogue already supplied.
  name: 4,
};

/**
 * Pick the class for a merged group, or `null` if the group is not water we cover.
 *
 * **A group every catalogue refused is refused — it is not `unclassified`.** `null` means "not water
 * we cover"; `unclassified` means "water, but nobody said what kind". Collapsing the first into the
 * second admitted **Lake Huron and seven polygons of the Atlantic Ocean** on the first real run,
 * because 3DHP publishes ocean and river features that `classifyThreeDhp` drops and the merge then
 * resurrected. A drop that survives a merge is worse than no drop at all: it launders a refusal into
 * a shrug.
 *
 * A group where *some* member refuses and another names a class keeps the class — that is the whole
 * point of merging before filtering, and it is what rescues the 123 bodies OSM calls `wetland=marsh`
 * and NHD calls `LakePond`.
 */
export function chooseClass(members: readonly Feature[]): WaterBodyClass | null {
  const classes = members.map((m) => m.cls).filter((c): c is WaterBodyClass => c !== null);
  if (classes.length === 0) return null;

  // **An explicit refusal beats another source's silence** (N7 audit, founder call 2026-08-06).
  //
  // `unclassified` is what a source says when it drew water and never said what kind — 3DHP has no
  // wetland class at all, and `natural=water` with no subtag is 96% of OSM's silence. It is not a
  // claim. So a group where 3DHP says `featuretype=1 River` (an explicit drop) and OSM says nothing
  // used to resolve to `unclassified` and be **admitted**, because this function only looked at the
  // non-null classes and a drop contributes none.
  //
  // That was inconsistent with the layer directly below it: `strongerClaim` in `@skating/core`'s
  // `waterClass` already ranks drop above silent *within* one source, on the reasoning that "a drop
  // is a decision and silence is not". This applies the same rule *across* sources. It still loses to
  // a real class, which is what rescues the 123 bodies OSM calls `wetland=marsh` and NHD calls
  // `LakePond` — the whole reason the merge exists.
  const refused = members.some((m) => m.cls === null);
  const onlySilence = classes.every((c) => c === 'unclassified');
  if (refused && onlySilence) return null;

  return CLASS_ORDER.find((c) => classes.includes(c)) ?? 'unclassified';
}

/**
 * Which member's outline the merged body draws — **provisional, pending D92's bake-off.**
 *
 * OSM first, then NHD, then whatever is left. Deliberately a placeholder: `geometrySource` is a
 * field, so the bake-off's answer lands as an update rather than a migration. It is nonetheless
 * *wrong today* on at least one known fixture — Beau Lake merges at 2,457 acres from OSM against
 * NHD's measured 1,876.6 — which is why the bake-off runs before the import rather than after it.
 */
export function chooseGeometry(
  members: readonly Feature[],
  overrides: ReadonlyMap<string, ClaimSource> = GEOMETRY_OVERRIDES,
): Feature | undefined {
  // A per-lake override, keyed on any catalogue id in the group. Checked first, because the whole
  // point of D93's minted key is that this decision is a field rather than a migration.
  for (const m of members) {
    const preferred = overrides.get(`${m.source}:${m.id}`);
    if (preferred === undefined) continue;
    const chosen = representativeOf(members, preferred);
    if (chosen) return chosen;
  }
  return (
    representativeOf(members, 'osm') ??
    representativeOf(members, 'nhd') ??
    representativeOf(members)
  );
}

/**
 * The member that speaks for one catalogue in this group — **the largest, never the first**
 * (second audit, 2026-08-06).
 *
 * ## What "the first" was actually choosing
 *
 * A group can hold several features from one catalogue: OSM carries invisible duplicates, and it also
 * traces a big lake as one relation *and* its arms as separate ways. `chooseGeometry` took
 * `members.find(m => m.source === 'osm')` — the first in array order, which is the order the extracts
 * happened to stream in. It is arbitrary, and the run showed what arbitrary costs:
 *
 * | body | stored | the other OSM member | NHD/3DHP |
 * | --- | --- | --- | --- |
 * | **Indian Lake**, NY | **534 ac** | 3,742 ac | 4,296 ac |
 * | Blake Falls Reservoir | 288 ac | 265 + 78 ac | 630 ac |
 * | Fairhill Swamp | 28 ac | 153 ac | 187 ac |
 * | Dodge Pond | 2 ac | 14 ac | 14 ac |
 *
 * Indian Lake is a real 4,300-acre Adirondack lake and we were about to store an eighth of it. The
 * group is flagged `same-source-duplicate` and queued, so a human would eventually see it — but the
 * *stored polygon* was wrong in the meantime, and a fragment under-draws silently where a wrong
 * outline at least looks wrong.
 *
 * **Largest, and it is defensible in all three cases the flag covers.** Whole-versus-fragment: the
 * largest is the lake, definitively. A real duplicate pair (Long Pond as a way and a relation): the
 * two are within a percent, so it is a coin toss either way and at least a *deterministic* one. Two
 * distinct lakes wrongly chained: the largest is no worse than the first, and the flag is what
 * actually addresses that case.
 *
 * **This is not D94's "never the larger of two claims".** That rule is about *area*, and it still
 * holds: the stored area is measured from whichever polygon this returns, never taken as the max of
 * what the catalogues assert. This is about *which polygon* — a different question, and one where
 * taking the biggest piece of one catalogue's account of one lake is the whole point.
 *
 * Used by `chooseGeometry`, `catalogueIdsOf` and the absorbed-member list alike, so all three name
 * the same feature. They did not, before: the key would have been the largest and the `osmId` the
 * first, and a row's `externalId` and `osmId` would have pointed at two different OSM features.
 */
export function representativeOf(
  members: readonly Feature[],
  source?: ClaimSource,
): Feature | undefined {
  let best: Feature | undefined;
  for (const m of members) {
    if (source !== undefined && m.source !== source) continue;
    if (best === undefined || m.areaSqM > best.areaSqM) best = m;
  }
  return best;
}

/**
 * **The per-lake geometry override** (D92) — the thing that made D93's minted key worth building.
 *
 * D92's bake-off found OSM and NHD indistinguishable over 2,359 surveyed lakes (63.2% ties) and set
 * the default to OSM on the cheaper-pipeline tie-break. It also said, explicitly, that the default
 * loses on named cases and that `geometrySource` stays a field so those can be fixed one lake at a
 * time. **Until this table existed the override was a decision with no producer**: the bake-off wrote
 * its per-lake scores to a scratch file nothing read, and `chooseGeometry` was a hardcoded OSM-first
 * placeholder.
 *
 * Keyed `<source>:<id>` on **any** member of the group, because which catalogue we would have picked
 * is exactly what is being overridden — keying on the OSM id alone would be unable to express "prefer
 * NHD for a lake OSM draws badly", which is the only case that ever arises.
 *
 * ## Beau Lake, the fixture this phase is named for
 *
 * 1,875 acres on Maine's published figure, **1,788 acres** on the state's own record and 7.23 km² on
 * Wikipedia — two independent sources that agree with each other to within a percent. NHD's archived
 * polygon measures 7.594 km² = **1,876.6 ac**, ~5% over. OSM merges it at **2,457 ac** — a **37%
 * over-statement** against the state figure, because the Geofabrik extract clips the Québec half and
 * what remains is traced together with the water above the narrows.
 *
 * So the override is not close: NHD is within 5% of two agreeing sources and OSM is not within 35%.
 *
 * @see `scripts/etl/.scratch/bakeoff/scores.ndjson` — the 140 lakes where D92's two metrics disagree
 *      are the candidate pool for extending this table, and each addition wants its acreage recorded
 *      the way Beau Lake's is.
 */
export const GEOMETRY_OVERRIDES: ReadonlyMap<string, ClaimSource> = new Map([
  // Beau Lake, ME/QC. NHD `Permanent_Identifier` {85383A01-DC89-47AA-BC5D-BE373FB0B5C3}, lower-cased
  // by `normalizeNhdId`. NHD 1,876.6 ac vs OSM 2,457 ac vs the state's 1,788 ac.
  ['nhd:85383a01-dc89-47aa-bc5d-be373fb0b5c3', 'nhd' as ClaimSource],
]);

/**
 * Collapse one group of matched features into one body, or `null` if it is refused.
 *
 * Refused means one of two things, and the caller cannot tell them apart from the return value
 * alone — see `mergeGroupWithReason` when the distinction matters for a report.
 */
export function mergeGroup(members: Feature[]): Merged | null {
  return mergeGroupWithReason(members).body;
}

/**
 * Why a group was refused, for a report that would otherwise conflate different findings.
 *
 * The three veto reasons are separated because they say different things about our data: `vetoed`
 * means a catalogue itself called this the ocean, `vetoed-name` and `vetoed-area` mean it did not and
 * we refused anyway. A change in the last two is a change in *our* rules; a change in the first is a
 * change in the source.
 */
export type RefusalReason =
  | 'vetoed'
  | 'vetoed-name'
  | 'vetoed-area'
  /** Inside water a federal catalogue calls the sea — see `saltContainment`. Founder: no salt water. */
  | 'salt-water'
  | 'no-class'
  | 'refused-over-silence'
  | 'empty';

/** Map a `VetoReason` onto the refusal label the report groups by. */
const VETO_REFUSAL: Readonly<Record<VetoReason, RefusalReason>> = {
  token: 'vetoed',
  name: 'vetoed-name',
  area: 'vetoed-area',
};

/**
 * `mergeGroup`, but saying *why* on a refusal.
 *
 * The two refusals mean opposite things about our data: `vetoed` is a rule firing correctly on the
 * ocean, `no-class` is every catalogue independently declining to call this water. A report that adds
 * them together — as the first version of this did — cannot tell "the veto is working" from "the
 * classifier has a hole".
 */
export function mergeGroupWithReason(members: Feature[]): {
  body: Merged | null;
  reason?: RefusalReason;
} {
  if (members.length === 0) return { body: null, reason: 'empty' };

  // A veto is not a vote — one source naming this the ocean ends the question. Checked before the
  // class vote, because the vetoed sources DO carry classes and would otherwise win it.
  const veto = vetoReason(members);
  if (veto !== undefined) return { body: null, reason: VETO_REFUSAL[veto] };

  const cls = chooseClass(members);
  if (cls === null) {
    // Two different findings, and the report must not add them together. `no-class` is every
    // catalogue independently declining to call this water — the classifier may have a hole.
    // `refused-over-silence` is a catalogue explicitly refusing it while another said nothing, which
    // is a rule working correctly and is new as of the N7 audit; watching it separately is how we
    // learn whether it removed 12 rivers or 1,200.
    const refusedExplicitly = members.some((m) => m.cls === null);
    const anySilence = members.some((m) => m.cls === 'unclassified');
    return {
      body: null,
      reason: refusedExplicitly && anySilence ? 'refused-over-silence' : 'no-class',
    };
  }

  const preferred = chooseGeometry(members);
  if (preferred === undefined) return { body: null, reason: 'empty' };

  // Two features from ONE catalogue in one group means either our matching chained two distinct
  // lakes, or the catalogue carries a duplicate it cannot see. Both are findings; neither may merge
  // unattended. This is the only guard against a three-lane union-find chaining unrelated bodies.
  const bySource = new Map<ClaimSource, number>();
  for (const m of members) bySource.set(m.source, (bySource.get(m.source) ?? 0) + 1);
  const sameSourceDuplicate = [...bySource.values()].some((v) => v > 1);
  // The members that lose — the ones whose polygon and id the merged body does not carry. Named
  // rather than counted, because they are otherwise the only records in the pipeline that leave no
  // trace at all: not in `bodies.ndjson`, not in any ledger, not on the surviving row.
  // Everything that is NOT its catalogue's representative — the features whose polygon and id the
  // merged body does not carry. Derived from `representativeOf` so it cannot disagree with the two
  // callers above about which member won.
  const kept = new Set(
    (['osm', 'nhd', '3dhp', 'gnis', 'name', 'user'] as ClaimSource[])
      .map((src) => representativeOf(members, src))
      .filter((m): m is Feature => m !== undefined),
  );
  const absorbedIds = members.filter((m) => !kept.has(m)).map((m) => `${m.source}:${m.id}`);

  return {
    body: {
      key: `${preferred.source}:${preferred.id}`,
      absorbedIds,
      members,
      name: chooseName(members),
      cls,
      // **Measured from the polygon we actually stored, never the larger of two claims** (D94).
      areaSqM: preferred.areaSqM,
      bbox: preferred.bbox,
      polygon: preferred.polygon,
      geometrySource: preferred.source,
      sameSourceDuplicate,
    },
  };
}

/**
 * The catalogue id inside a group's key — `osm:way/123` → `way/123`.
 *
 * Split on the *first* colon only: an OSM id contains a slash but a 3DHP id is opaque and an NHD
 * `Permanent_Identifier` is a brace-free GUID, so neither may be assumed colon-free.
 */
export function idFromKey(key: string): string {
  const at = key.indexOf(':');
  return at < 0 ? key : key.slice(at + 1);
}

/**
 * IoU of each member against the group's chosen outline; 1 for the outline itself.
 *
 * The IoU map is keyed by the direction the lane ran in, which is not knowable here — a 3DHP member
 * of an OSM-drawn group was matched `osm→3dhp`, but an NHD member of the same group was matched
 * `osm→nhd`, and the federal lane ran `3dhp→nhd`. So both orderings are tried.
 *
 * ## The fallback used to be a constant, and it was poisoning the score
 *
 * A member that reached the group **transitively** — 3DHP joined to OSM through NHD, never compared
 * to OSM directly — has no entry in either direction, and the old code substituted
 * `RECONCILE_MIN_IOU` (0.5). That sits below `POLYGON_DISAGREE_IOU` (0.7), so **every
 * three-catalogue group scored its polygon `low` by construction**: not because the outlines
 * disagreed, but because of which lane happened to run. The published confidence distribution was
 * measuring our own pipeline, which is the exact failure D85 and the bake-off both already guard
 * against elsewhere.
 *
 * So the pair is computed. It costs one `polygonIoU` per transitive member — roughly one per
 * three-source body, against the millions the matching lanes already do — and it is the difference
 * between a number about the data and a number about the code.
 */
export function polygonClaims(
  group: Pick<Merged, 'members' | 'geometrySource' | 'key' | 'polygon'>,
  iou: ReadonlyMap<string, number>,
): AttributeClaim<number>[] {
  const chosen = idFromKey(group.key);
  return group.members.map((m) => {
    if (m.source === group.geometrySource && m.id === chosen) return { source: m.source, value: 1 };
    const known = iou.get(`${m.id}|${chosen}`) ?? iou.get(`${chosen}|${m.id}`);
    return {
      source: m.source,
      value: known ?? polygonIoU(m.polygon, group.polygon),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The name lane — what IoU alone cannot reach
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **The second audit's headline finding, and this is the fix.**
 *
 * A missed match does not produce a gap — it produces a **duplicate**. The upsert key is a catalogue
 * id (D93), so a group with no OSM member has no `osmId`, meets a corpus that has one, and inserts a
 * brand-new row alongside the lake it already had. Nothing downstream can tell the two apart.
 * Measured on the pre-fix master list: **632 pairs of separate bodies overlapping at IoU ≥ 0.3**, of
 * which **408 share a name** — `Peabody Pond` 7 ac beside `Peabody Pond` 16 ac, `Freeses Pond` 25
 * beside 55.
 *
 * ## Why they were missed, which is not a tuning problem
 *
 * `scoreCandidates` skips any pair whose **exact** IoU ceiling `min(area)/max(area)` falls under the
 * bar. At `RECONCILE_MIN_IOU = 0.5` that means **any pair whose areas differ by more than 2× is
 * rejected before an intersection is ever computed** — and on small ponds the two catalogues differ
 * by 2–3× routinely, because they disagree about where a marshy margin stops being water. The bar is
 * unreachable exactly where the catalogues disagree most, which is also the measured explanation for
 * the long-open *"OSM↔NHD matches 33% and nobody knows why"*.
 *
 * Lowering the bar is not the answer: 0.5 is what refuses a bay its parent's identity, and that
 * refusal is load-bearing.
 *
 * ## So the second signal is the name, and it is constrained by geography
 *
 * **The founder's condition, and it is the whole safety of this lane** (2026-08-06): *"So long as we
 * can be sure that the two bodies with the same name are also in the same-ish geolocation… I do NOT
 * want a name match to merge one pond in Maine with another pond in New York."* There are 180 Mud
 * Ponds in the region; a name is worthless on its own.
 *
 * It is therefore never a proximity rule. A pair qualifies only when the two outlines **actually
 * overlap** — `NAME_MATCH_MIN_IOU` of shared area, not a shared bounding box and not a distance —
 * and:
 *
 * 1. both names are non-empty and `sameName` (case, accent, apostrophe, possessive, word order);
 * 2. exactly **one** candidate qualifies, so a chain of same-named ponds refuses rather than guesses;
 * 3. the pair is not already matched by the geometric lane, which needs no help.
 *
 * Two lakes 400 km apart cannot overlap by any amount, so rule 1 can never fire across the region.
 * What the name adds is permission to accept an overlap the area-ratio ceiling would have refused.
 */
export const NAME_MATCH_MIN_IOU = RECONCILE_MIN_IOU_WITH_GNIS;

/**
 * **Why the bar is 0.3 and not something lower — the run corrected the first guess.**
 *
 * It shipped at 0.1, and the very first full run showed what that buys: a **534-acre** OSM feature
 * named `Indian Lake` was absorbed into the **3,743-acre** OSM `Indian Lake` beside it, because both
 * carry the name and a lobe inside its parent scores IoU ≈ 0.12. That is a *lake merged into a
 * fragment's* mirror image, and D93 has already written the rule for exactly this evidence class:
 *
 * > `RECONCILE_MIN_IOU_WITH_GNIS` **0.3** — both publishers independently naming the same place is
 * > real evidence, but not a bypass, because a lake NHD splits shares its GNIS id with both halves.
 * > **Accepting those merges a real lake into a fragment.**
 *
 * A matching *name* is strictly weaker evidence than a matching *GNIS id* — the gazetteer is an
 * authority and a name is a string two mappers typed — so this lane cannot justify a looser bar than
 * the one D93 settled for the stronger signal. Pinned to that constant rather than restating it, so
 * the two can never drift.
 *
 * **It still covers the case the lane exists for.** The target is the band where the area-ratio
 * ceiling `min/max` refuses a real pair: Peabody Pond at 7 ac against 16 has a ceiling of 0.44 and
 * clears this comfortably. What it now declines is anything beyond a ~3.3× size difference, where
 * "the same lake drawn differently" and "an arm of it" genuinely cannot be told apart by overlap.
 */

/**
 * Pairs the name lane proposes: `[targetId, candidateId]`, same shape the geometric lanes emit.
 *
 * `alreadyMatched` is the set of target ids the geometric lanes have already spoken for. Skipping
 * them is not an optimisation — it keeps the geometric verdict authoritative, so a lane that said
 * `ambiguous` (*"geometry cannot separate these"*) is not then overruled by a name.
 */
export function nameMatchPairs(
  targets: readonly Feature[],
  candidateGrid: Map<string, Feature[]>,
  alreadyMatched: ReadonlySet<string>,
  sameName: (a: string, b: string) => boolean,
  minIou = NAME_MATCH_MIN_IOU,
): { pairs: [string, string][]; ambiguous: string[] } {
  const pairs: [string, string][] = [];
  const ambiguous: string[] = [];
  for (const target of targets) {
    if (target.name.length === 0 || alreadyMatched.has(target.id)) continue;
    const seen = new Set<string>();
    const hits: Feature[] = [];
    for (const cell of cellsFor(target.bbox)) {
      for (const candidate of candidateGrid.get(cell) ?? []) {
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        if (candidate.name.length === 0) continue;
        if (!bboxIntersects(candidate.bbox, target.bbox)) continue;
        if (!sameName(target.name, candidate.name)) continue;
        // The geometry is still the arbiter — the name only lowers the bar it has to clear.
        if (polygonIoU(target.polygon, candidate.polygon) < minIou) continue;
        hits.push(candidate);
      }
    }
    const only = hits[0];
    if (hits.length === 1 && only) pairs.push([target.id, only.id]);
    else if (hits.length > 1) ambiguous.push(`${target.id} "${target.name}" ×${hits.length}`);
  }
  return { pairs, ambiguous };
}

// ─────────────────────────────────────────────────────────────────────────────
// The duplicate sweep — the backstop for whatever the lanes still miss
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where two **kept** bodies still cover the same water — reported, never merged.
 *
 * The name lane closes the case where both catalogues named the lake. It cannot close the case where
 * neither did, and 4,070 of the NHD-only bodies in the master list are unnamed ponds. So this runs
 * over the final set as a backstop and flags both sides `duplicate-candidate`, which is a review
 * reason a moderator can act on and — critically — a thing that *exists*, where today a duplicate
 * pair is indistinguishable from two real lakes forever.
 *
 * **It does not merge.** Merging two rows that user content may point at is a moderator action
 * (`requiresReview`, `bodyIdentity.ts`), and an automatic merge that is wrong is unrecoverable in a
 * way a queued one is not. The founder's rule for this lane, 2026-08-06: resolve automatically only
 * where confidence is high — which is what the *name* lane does, upstream, where the evidence is —
 * *"otherwise if we're not sure or there's a good chance we're wrong, put these in the queue."*
 */
export const DUPLICATE_SWEEP_MIN_IOU = 0.3;

export function overlapDuplicates(
  bodies: readonly Merged[],
  minIou = DUPLICATE_SWEEP_MIN_IOU,
): Map<string, string[]> {
  const grid = index(bodies);
  const out = new Map<string, string[]>();
  const tested = new Set<string>();
  const note = (a: string, b: string) => {
    const list = out.get(a);
    if (list) list.push(b);
    else out.set(a, [b]);
  };
  for (const body of bodies) {
    const seen = new Set<Merged>();
    for (const cell of cellsFor(body.bbox)) {
      for (const other of grid.get(cell) ?? []) {
        if (other === body || seen.has(other)) continue;
        seen.add(other);
        const pair = body.key < other.key ? `${body.key}|${other.key}` : `${other.key}|${body.key}`;
        if (tested.has(pair)) continue;
        tested.add(pair);
        if (!bboxIntersects(body.bbox, other.bbox)) continue;
        // The same exact bound `scoreCandidates` uses: IoU can never exceed the area ratio, and the
        // pairs this sweep runs over include the largest polygons in the corpus.
        const ratio =
          Math.min(body.areaSqM, other.areaSqM) /
          Math.max(body.areaSqM, other.areaSqM, Number.EPSILON);
        if (ratio < minIou) continue;
        if (polygonIoU(body.polygon, other.polygon) < minIou) continue;
        note(body.key, other.key);
        note(other.key, body.key);
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The bay rule
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The larger body this bay is an arm of, if there is one.
 *
 * ## Two outcomes, and both of them used to end in a top-level body
 *
 * A bay is an arm OF something, and what we do about that is now split (founder call, 2026-08-06):
 *
 * - **A bay with a parent is a sub-area, not a body.** N2 built `waterBodySubAreas` for exactly this
 *   shape — Malletts Bay is part of Champlain, not a lake beside it — and emitting it as a body
 *   instead double-counts the water: the corpus held `West Branch Keuka Lake` (2,707 ac), `Spencer
 *   Bay` (4,742 ac, on Moosehead) and Winnipesaukee's `Alton`, `Paugus` and `Meredith` bays as rows
 *   overlapping their own parents, so a search for the lake returned it twice and the deciles counted
 *   its water twice.
 * - **A bay with no parent cannot support the claim** — **Half Moon Cove is 330 acres, named "Cove",
 *   and is a wetland** — so it is demoted to `unclassified` and queued for a human rather than
 *   dropped.
 *
 * Returning the parent rather than a boolean is what makes the first outcome expressible; see
 * `hasBayParent` for the predicate the second one still wants.
 *
 * ## The test is now geometric, in both directions (N7 audit, 2026-08-06)
 *
 * It used to be `covers()` on **bounding boxes alone**, which was wrong twice over:
 *
 * - **False positives.** A large L-shaped or crescent body's box encloses the boxes of bays it never
 *   touches, so a cove in the notch of an L inherited a parent on the far side of dry land.
 * - **False negatives, which are the costlier half.** `covers()` demands *full* box containment, so a
 *   bay whose outline pokes one vertex past its parent's box lost its parent and was demoted to
 *   `unclassified` — for a reason that has nothing to do with whether it is a bay.
 *
 * So the box test is demoted to what it is good at — a prefilter — using `bboxIntersects` rather than
 * `covers`, and the real question is asked of the polygons: **is most of this bay's outline actually
 * inside the candidate?** That is `BAY_PARENT_MIN_CONTAINMENT`, sampled the same way `inRegion`
 * samples, and it is what Half Moon Cove fails (0.00 contained in anything) while a genuine arm of a
 * lake passes near 1 — a bay's shoreline lies on its parent's boundary, which `pointInPolygon`
 * counts as inside.
 *
 * The candidate must still be strictly larger: a bay is an arm *of* something bigger.
 */
export function bayParent(
  bay: Pick<Merged, 'bbox' | 'areaSqM' | 'polygon'>,
  grid: Map<string, Merged[]>,
): Merged | undefined {
  const samples = sampleOutline(bay.polygon);
  if (samples.length === 0) return undefined;
  const seen = new Set<Merged>();
  // **The smallest qualifying parent wins**, which is Decision 9's rule one layer up: a cove inside a
  // bay inside a lake belongs to the bay. Without it the answer depends on grid iteration order.
  let best: Merged | undefined;
  for (const cell of cellsFor(bay.bbox)) {
    for (const candidate of grid.get(cell) ?? []) {
      // A body spans many cells, so the same candidate arrives repeatedly; the containment test is
      // the expensive part and must not be paid per cell.
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (candidate.areaSqM <= bay.areaSqM) continue;
      if (best !== undefined && candidate.areaSqM >= best.areaSqM) continue;
      if (!bboxIntersects(candidate.bbox, bay.bbox)) continue;
      let inside = 0;
      for (const [lng, lat] of samples) {
        if (pointInPolygon({ lat, lng }, candidate.polygon)) inside++;
      }
      if (inside / samples.length >= BAY_PARENT_MIN_CONTAINMENT) best = candidate;
    }
  }
  return best;
}

/** Does this bay have a larger body it could be an arm of? The predicate half of `bayParent`. */
export function hasBayParent(
  bay: Pick<Merged, 'bbox' | 'areaSqM' | 'polygon'>,
  grid: Map<string, Merged[]>,
): boolean {
  return bayParent(bay, grid) !== undefined;
}

/**
 * How much of a bay's outline must lie inside a body before that body is its parent.
 *
 * **A half**, and the half is doing work in both directions. Not higher, because the two catalogues
 * disagree at the edges and a bay traced by OSM against a parent drawn by NHD will have shoreline
 * vertices falling just outside. Not lower, because a body merely *adjacent* to a bay — the next lake
 * in a chain, sharing a narrows — would otherwise adopt it.
 *
 * It is a fraction and never a count, so a nine-vertex cove and a nine-hundred-vertex fjord are
 * judged the same way — the same reasoning as `MIN_SURVEY_CONTAINMENT` in the bathymetry join.
 */
export const BAY_PARENT_MIN_CONTAINMENT = 0.5;

/**
 * The Great Lakes as parents — **the bodies we deliberately do not carry** (founder, 2026-08-07).
 *
 * Lake Ontario is not in the corpus and is never going to be: it draws from the basemap, and putting
 * a 4.7-million-acre polygon in `waterBodies` would pull a Great Lake into every viewport query for
 * 300 miles of shoreline. So `bayParent` cannot find it, and eleven of the largest freshwater bays
 * in New York — **Chaumont Bay 9,169 ac, Black River Bay 4,455, Braddock, Little Sodus, Blind Sodus,
 * Three Mile, Muskellunge, Sherwin, Sawmill, Long Carrying Place, Long Bay** — were demoted to
 * `unclassified` for having no parent, when what they have is a parent we chose not to carry.
 *
 * They are skated. Braddock Bay is the body D119 already had to rescue from the salt veto for exactly
 * this reason: *"freshwater embayments of Lake Ontario, and they are skated."*
 *
 * **An area floor, because `isGreatLakeFeature` is a name test and `Huron Pond` is a real pond in
 * Maine** — it appears in the archive and would otherwise adopt every cove near it. `OCEAN_NAME_VETO_MIN_ACRES`
 * is the bar D120 already set for the same trap, where a substring rule aimed at the Great Lakes was
 * about to delete `Lake Superior`, NY (179 ac) and `Little Lake Erie` (4 ac).
 */
export function greatLakeMask(features: readonly Feature[]): Feature[] {
  return features.filter(
    (f) => isGreatLakeFeature(f) && f.areaSqM >= OCEAN_NAME_VETO_MIN_ACRES * SQ_M_PER_ACRE,
  );
}

/**
 * How much of a bay's outline must lie inside a Great Lake before it counts as an arm of one.
 *
 * **A quarter, and much lower than `BAY_PARENT_MIN_CONTAINMENT` on purpose.** A bay of an ordinary
 * lake is drawn *inside* its parent's outline and scores near 1. A Great Lakes bay is drawn across
 * the mouth: half of it is inland water the lake polygon does not cover, and the measured spread over
 * the eleven is **0.28 – 0.76**, with Braddock Bay at the bottom. A half would keep four of eleven.
 *
 * Safe at this bar only because the candidate set is two lakes rather than the whole corpus — the
 * "next lake in a chain adopts it" failure that forces 0.5 above cannot happen when the only
 * candidates are Erie and Ontario.
 */
export const GREAT_LAKE_ARM_MIN_CONTAINMENT = 0.25;

/** The Great Lake this bay is an arm of, if any — same sampling as `bayParent`. */
export function greatLakeParent(
  bay: Pick<Merged, 'bbox' | 'polygon'>,
  grid: Map<string, Feature[]>,
): Feature | undefined {
  const samples = sampleOutline(bay.polygon);
  if (samples.length === 0) return undefined;
  const seen = new Set<Feature>();
  for (const cell of cellsFor(bay.bbox)) {
    for (const lake of grid.get(cell) ?? []) {
      if (seen.has(lake)) continue;
      seen.add(lake);
      if (!bboxIntersects(lake.bbox, bay.bbox)) continue;
      let inside = 0;
      for (const [lng, lat] of samples) {
        if (pointInPolygon({ lat, lng }, lake.polygon)) inside++;
      }
      if (inside / samples.length >= GREAT_LAKE_ARM_MIN_CONTAINMENT) return lake;
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// The region clip
// ─────────────────────────────────────────────────────────────────────────────

export interface Boundary {
  readonly bbox: BBox;
  readonly polygon: Polygon | MultiPolygon;
}

/**
 * How many points to sample along each outer ring on the **first** pass of the region test.
 *
 * Eight is a fast path, not the answer. A `true` from eight samples is a proof — a point either is in
 * a boundary polygon or is not — but a `false` never was, and 35,637 bodies were excluded on it. So
 * `inRegion` now escalates: any body whose bbox comes near the mask and failed the sample is re-tested
 * against **every vertex of every outer ring** before it is dropped. See `inRegion`.
 */
export const REGION_SAMPLE_POINTS = 8;

/** The outer ring of each polygon in a geometry. Holes are irrelevant to "is any part in region". */
export function outerRings(g: Polygon | MultiPolygon): number[][][] {
  return g.type === 'Polygon'
    ? [g.coordinates[0] as number[][]]
    : g.coordinates.map((poly) => poly[0] as number[][]);
}

/**
 * Evenly-spaced sample points around a whole geometry, to a **total** budget.
 *
 * Different from `sampleOutline` in the one way that matters: that one takes `REGION_SAMPLE_POINTS`
 * from *each ring*, which is right for "does any part touch the mask" (a `true` from any ring is a
 * proof) and wrong for any question whose answer is a **fraction**. At eight per ring the answer is
 * quantised into ninths — which is why the first salt-water measurement stacked twenty unrelated
 * bodies at exactly 0.44, and why `inRegionFraction` reported a border-straddler's share to one
 * significant figure.
 */
export function sampleOutlineDense(g: Polygon | MultiPolygon, budget: number): [number, number][] {
  const rings = outerRings(g).filter((r): r is number[][] => Array.isArray(r) && r.length > 0);
  const total = rings.reduce((n, r) => n + r.length, 0);
  if (total === 0) return [];
  const step = Math.max(1, Math.floor(total / Math.max(1, budget)));
  const points: [number, number][] = [];
  // **Per ring, so a component shorter than the stride still contributes.** The stride is computed
  // over the whole geometry, so a big ring can set one longer than a small ring — and walking the
  // rings end-to-end as one sequence would drop those components entirely, which is the archipelago
  // case and exactly the water the Maine coast is made of. Starting each ring at index 0 guarantees
  // every component at least one sample.
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += step) {
      const c = ring[i];
      if (c) points.push([c[0] as number, c[1] as number]);
    }
  }
  return points;
}

/** Evenly-spaced sample points along every outer ring of a geometry. */
export function sampleOutline(g: Polygon | MultiPolygon): [number, number][] {
  const points: [number, number][] = [];
  for (const ring of outerRings(g)) {
    if (!ring) continue;
    const step = Math.max(1, Math.floor(ring.length / REGION_SAMPLE_POINTS));
    for (let i = 0; i < ring.length; i += step) {
      const c = ring[i];
      if (c) points.push([c[0] as number, c[1] as number]);
    }
  }
  return points;
}

/**
 * Does any part of this body lie in our five states?
 *
 * **Any part, not its centre**, and that is the difference between keeping Beau Lake and losing it.
 * Beau Lake is the phase's headline fixture — 1,875 acres, absent from the corpus because Geofabrik
 * clips the Québec half — and a centre-based test on a body that straddles the border is a coin flip.
 * Sampling the outline and keeping on the first hit answers the question we actually mean.
 */
export function inRegion(
  body: { polygon: Polygon | MultiPolygon; bbox: BBox },
  grid: Map<string, Boundary[]>,
): boolean {
  if (anyPointInRegion(sampleOutline(body.polygon), grid)) return true;

  // ── The escalation, and why a sampled `false` was never good enough ──────────────────────────
  //
  // A `true` from eight samples is a proof; a `false` is only "none of the eight happened to land
  // inside". A body genuinely in-state whose in-region sliver is narrower than the sampling stride
  // was deleted from the corpus with nothing recording it, and 35,637 bodies rode on that test.
  //
  // So before dropping anything, walk **every** vertex. The cost is bounded by the prefilter below:
  // a body whose bounding box does not even meet the mask's cells cannot be in region however many
  // points we test, and that is the overwhelming majority of the 35,637 — a Pennsylvania pond in the
  // New York geodatabase is nowhere near a boundary and exits in four comparisons.
  if (!nearRegionCells(body.bbox, grid)) return false;
  for (const ring of outerRings(body.polygon)) {
    if (!ring) continue;
    if (anyPointInRegion(ring as [number, number][], grid)) return true;
  }
  return false;
}

/** Does the body's bbox touch any grid cell the mask occupies? The escalation's cheap gate. */
function nearRegionCells(box: BBox, grid: Map<string, Boundary[]>): boolean {
  for (const cell of cellsFor(box)) {
    if ((grid.get(cell)?.length ?? 0) > 0) return true;
  }
  return false;
}

/** Is any of these points inside any boundary polygon? The shared inner loop of the two passes. */
function anyPointInRegion(
  points: readonly (readonly [number, number])[],
  grid: Map<string, Boundary[]>,
): boolean {
  for (const [lng, lat] of points) {
    const cell = `${Math.floor(lng / CELL_DEG)}:${Math.floor(lat / CELL_DEG)}`;
    for (const b of grid.get(cell) ?? []) {
      if (lng < b.bbox.minLng || lng > b.bbox.maxLng) continue;
      if (lat < b.bbox.minLat || lat > b.bbox.maxLat) continue;
      if (pointInPolygon({ lat, lng }, b.polygon)) return true;
    }
  }
  return false;
}

/**
 * What share of this body's outline lies inside our five states — **in `[0, 1]`** (N7 audit).
 *
 * `inRegion` is deliberately generous: one in-region vertex admits the whole polygon, which is what
 * keeps Beau Lake, whose Québec half is most of it. The cost of that generosity is that the corpus
 * silently holds bodies that are mostly *not* ours — a Québec lake touching the border at one point
 * enters at its full area, contributes its full area to the deciles, and nothing on the row says so.
 *
 * **Stored, never acted on — and that is now a decision rather than an omission** (founder,
 * 2026-08-06): *"It's okay that cross-border bodies enter whole, even if they only barely enter our
 * five states… let's keep all cross-border bodies for now and trim later if we need to, especially
 * if we have their name and full polygon."* So there is deliberately no threshold here. The field
 * exists so that a future trim is a query rather than a re-import.
 *
 * Sampled to a **total** budget (`IN_REGION_FRACTION_POINTS`) rather than per ring, because this is
 * the only fraction-valued answer in the file and per-ring sampling quantises it — see
 * `sampleOutlineDense`.
 */
export function inRegionFraction(
  body: { polygon: Polygon | MultiPolygon; bbox: BBox },
  grid: Map<string, Boundary[]>,
): number {
  const samples = sampleOutlineDense(body.polygon, IN_REGION_FRACTION_POINTS);
  if (samples.length === 0) return 0;
  let inside = 0;
  for (const point of samples) if (anyPointInRegion([point], grid)) inside++;
  return inside / samples.length;
}

/** Outline samples behind `inRegionFraction`. Enough that a percentage means something. */
export const IN_REGION_FRACTION_POINTS = 64;

/**
 * Is this body's middle inside one of the excluded counties? (D111)
 *
 * **Its middle, where `inRegion` asks about any part of its outline**, and the asymmetry is the
 * point. `inRegion` is generous because a body straddling the Québec border is one we want and only
 * its edge proves it. This one is not asking whether the body *touches* the excluded area but whether
 * it *is* in it, so a reservoir lying across the Putnam/Dutchess line is decided by where its bulk
 * sits rather than by whichever county its southernmost inlet happens to reach.
 *
 * ⚠ **The bbox centre is not guaranteed to be inside the body.** For a crescent or an L, it lands in
 * open ground — the same trap `waterBodies.centroid` fell into by storing a `pointOnFeature`. It is
 * tolerable here and nowhere else in this file, because the question is answered against *county*
 * polygons: being a few hundred metres off the water changes the answer only for a body sitting
 * exactly on the cut line, where either answer is defensible. Do not copy this pattern to a test
 * whose polygons are lake-sized.
 */
export function inDownstate(body: { bbox: BBox }, excluded: readonly Boundary[]): boolean {
  const lng = (body.bbox.minLng + body.bbox.maxLng) / 2;
  const lat = (body.bbox.minLat + body.bbox.maxLat) / 2;
  for (const county of excluded) {
    if (lng < county.bbox.minLng || lng > county.bbox.maxLng) continue;
    if (lat < county.bbox.minLat || lat > county.bbox.maxLat) continue;
    if (pointInPolygon({ lat, lng }, county.polygon)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// The GNIS lane
// ─────────────────────────────────────────────────────────────────────────────

export interface GnisPoint {
  readonly lng: number;
  readonly lat: number;
  readonly name: string;
  readonly featureClass: string;
  /**
   * The GNIS Feature ID — **D105's other half, which was specified and never read.**
   *
   * The lane was built to do two jobs: supply names for bodies whose catalogue entry is unnamed, and
   * *settle a GNIS id where OSM, NHD and 3DHP disagree*. Only the first was implemented; `loadGnis`
   * read `feature_name`, `feature_class` and the coordinates and never touched `feature_id`, so the
   * gazetteer could not resolve the identifier it is the authority for.
   */
  readonly featureId?: string | undefined;
}

/** What the gazetteer had to say about a body: a name, and the id behind it where there is one. */
export interface GnisMatch {
  readonly name: string;
  readonly featureId?: string | undefined;
}

/**
 * How far outside its outline a gazetteer point may sit and still name a body.
 *
 * **Zero was the wrong answer and it was silently costing matches.** GNIS publishes one coordinate
 * per feature, and for water it is not reliably the middle: for many lakes it is placed at the outlet
 * or the mouth, which lands *on* the shoreline — and a shoreline traced by a different publisher than
 * the one that placed the point puts it a few tens of metres outside as often as not. The lane
 * decides admission for hundreds of bodies (D96 admits a *named* wetland at five acres and refuses an
 * unnamed one under fifty), so a miss here deletes a lake.
 *
 * A hundred metres is small against the bodies this matters for — an acre is 64 m across, but a body
 * that a *name* rescues is by definition one where the name changes the verdict, and those are the
 * five-to-fifty-acre wetlands, 160 m across and up. The ambiguity rule does the real safety work:
 * a buffered point is accepted only if it is still the **only** candidate, so a pond next door
 * reaching into the buffer refuses both rather than guessing.
 */
export const GNIS_ATTACH_BUFFER_M = 100;

/**
 * The single GNIS feature inside this outline, if there is exactly one.
 *
 * **Exactly one, or none.** A tidal bay swallows seven GNIS points (Great Bay contains Great Bay,
 * plus six coves and inlets); picking the first would be arbitrary and picking the largest would need
 * an area GNIS does not publish. Ambiguity here is a reason to stay unnamed, not to guess.
 *
 * This runs **before** the admission floor, and that ordering is the lane's whole point: D96 admits a
 * *named* wetland at five acres and refuses an unnamed one under fifty, so a gazetteer name does not
 * merely relabel a body — it decides whether the body exists. 306 bodies are in the corpus solely
 * because of it.
 */
/**
 * Resolve the gazetteer against **every** unnamed body at once — a point may name at most one.
 *
 * ## The ambiguity rule was one-directional, and the run showed what that costs
 *
 * `gnisNameFor` refuses when *several points* fall in **one body**: Great Bay swallows seven, and
 * picking one would be arbitrary. It is asked once per body, though, so the mirror case was never
 * tested — **one point falling near several bodies**. A gazetteer point sitting in a cluster of ponds
 * is legitimately "the only point near" each of them, independently, and each one takes the name.
 *
 * Measured on the 2026-08-06 run: **963 GNIS ids ended up on more than one body under the same
 * name.**
 *
 * ```
 * gnis 616007 → 6 bodies, all "Twinings Pond":   70ac · 4ac · 30ac · 26ac · 123ac · 14ac
 * gnis 614353 → 5 bodies, all "Teal Pond":       64ac · 1146ac · 16ac · 152ac · 22ac
 * ```
 *
 * Those are not one lake a catalogue split — the documented case, which is 158 ids and which shows up
 * as two features of *similar* size. They are six different ponds wearing one pond's name.
 *
 * **And the name is not cosmetic here**, which is what makes this worth a restructure rather than a
 * caveat: D96 admits a *named* wetland at five acres and refuses an unnamed one under fifty, so a
 * misattached name does not merely mislabel a body — it **admits** one. 1,771 bodies in the run exist
 * solely because the gazetteer named them.
 *
 * So the resolution is global and the rule becomes symmetric with the one already there: **a point
 * that could name more than one body names none of them.** Ambiguity in either direction is a reason
 * to stay unnamed, which is the lane's own principle applied to the side it had not been applied to.
 *
 * Takes the candidate bodies already filtered to the ones that can be named — see `buildMasterList`,
 * where this now runs after the geographic cuts and before the floor.
 */
export function resolveGnisNames<
  T extends { key: string; polygon: Polygon | MultiPolygon; bbox: BBox },
>(bodies: readonly T[], grid: Map<string, GnisPoint[]>): Map<string, GnisMatch> {
  /** Every body each point could name, so a point claimed twice can be withdrawn from both. */
  const claims = new Map<GnisPoint, string[]>();
  const proposed = new Map<string, GnisPoint>();
  for (const body of bodies) {
    const point = gnisPointFor(body, grid);
    if (point === undefined) continue;
    proposed.set(body.key, point);
    const list = claims.get(point);
    if (list) list.push(body.key);
    else claims.set(point, [body.key]);
  }
  const out = new Map<string, GnisMatch>();
  for (const [key, point] of proposed) {
    if ((claims.get(point)?.length ?? 0) !== 1) continue; // claimed twice → names nobody
    if (point.name.length === 0) continue;
    out.set(key, { name: point.name, featureId: point.featureId });
  }
  return out;
}

export function gnisNameFor(
  body: { polygon: Polygon | MultiPolygon; bbox: BBox },
  grid: Map<string, GnisPoint[]>,
): GnisMatch | undefined {
  const only = gnisPointFor(body, grid);
  return only === undefined ? undefined : { name: only.name, featureId: only.featureId };
}

/**
 * The single gazetteer point this body could be named by — the half of `gnisNameFor` that
 * `resolveGnisNames` needs, since it has to compare *points* across bodies rather than names.
 */
export function gnisPointFor(
  body: { polygon: Polygon | MultiPolygon; bbox: BBox },
  grid: Map<string, GnisPoint[]>,
): GnisPoint | undefined {
  // The bbox is grown by the buffer so the candidate sweep can see a point just outside the outline;
  // the exact distance test below is what actually decides. Erring wide in a prefilter costs one
  // comparison, erring tight silently drops a real match.
  const box = expandBBox(body.bbox, GNIS_ATTACH_BUFFER_M);
  const inside: GnisPoint[] = [];
  const near: GnisPoint[] = [];
  const seen = new Set<GnisPoint>();
  // A body's bbox spans many cells, so a point can be reached from several of them; the `seen` set
  // is what stops one point counting twice and reading as ambiguity.
  for (const cell of cellsFor(box)) {
    for (const p of grid.get(cell) ?? []) {
      if (seen.has(p)) continue;
      seen.add(p);
      if (p.lng < box.minLng || p.lng > box.maxLng) continue;
      if (p.lat < box.minLat || p.lat > box.maxLat) continue;
      const point = { lat: p.lat, lng: p.lng };
      if (pointInPolygon(point, body.polygon)) inside.push(p);
      else if (distanceToPolygonMeters(point, body.polygon) <= GNIS_ATTACH_BUFFER_M) near.push(p);
    }
  }
  // **Containment first, and it is a stronger claim than proximity.** A lake with one point inside
  // and three coves in the buffer is named by the point inside; falling straight to "how many are
  // within 100 m" would make a large body ambiguous precisely because it is large.
  const chosen = inside.length > 0 ? inside : near;
  if (chosen.length !== 1) return undefined; // none, or ambiguous — both are "stay unnamed"
  return chosen[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// The lanes — one raw record in, one Feature or one counted refusal out
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why a raw source record never became a `Feature`.
 *
 * **Every one of these used to be a bare `continue`** in `merge.ts`, and that is the finding the N7
 * audit turned up: the plan's proudest claim is that its numbers balance — *"178,690 groups = 11,631
 * refused + 35,637 out of region + 104,348 filtered + 27,074 kept"* — and they balance only from the
 * grouping stage onward. Upstream of it, the **largest single filter in the whole pipeline** (the
 * one-acre floor, which removes roughly two thirds of raw OSM) emitted no number at all, and four
 * other exits were entirely silent.
 *
 * That is the same class of failure `DropLedger` was built for after the `normalizeNhdId` near-miss,
 * applied one layer up: a rejection that is not counted is indistinguishable from a record that was
 * never there.
 */
export type LaneDropReason =
  /** The line was not JSON. Should be zero; a non-zero count means a truncated extract. */
  | 'unparseable'
  /** Parsed, but carried no geometry — `osmium` emits these for unclosed ways. */
  | 'no-geometry'
  /** OSM only: no `@type`/`@id`, so it cannot be keyed. Means the export lost `-a type,id`. */
  | 'no-id'
  /** NHD only: `permanent_identifier` failed `normalizeNhdId`. Counted under its own DropLedger too. */
  | 'unusable-id'
  /** Seen already — the five state extracts overlap at every border, and NHD's overlap heavily. */
  | 'duplicate'
  /**
   * Below `HARD_MIN_SURFACE_AREA_SQM`. D96 rule 1, the only rule no other source can overturn.
   *
   * ## Two known, measured, accepted asymmetries — flagged rather than fixed (second audit)
   *
   * **1. The floor is applied per lane, on each catalogue's own area.** "Merge first, filter once" is
   * the rule this file exists for, and this is the one place it is not applied — because it cannot
   * be: the floor removes roughly two thirds of raw OSM, and carrying those into the matching stage
   * would triple the most expensive computation in the pipeline to decide the same thing afterwards.
   * The cost is a narrow band: a body OSM draws at 0.9 acres and NHD at 1.1 loses its OSM member at
   * the lane, so the merged row arrives carrying only an `nhdId`. It is not *lost* — it is admitted
   * on NHD's outline, correctly — it simply has one fewer id than it could. Fixing it properly means
   * deferring the floor past the merge and paying for it there; the band is not worth that.
   *
   * **2. NHD and 3DHP are pre-filtered on the publisher's `areasqkm`, OSM is not.** `nhdExtractArgs`
   * passes `-where areasqkm >= ONE_ACRE_SQ_KM` so `ogr2ogr` never emits the sub-acre rows, where the
   * OSM lane measures every feature geodesically and refuses it here. A body the publisher computes
   * as a hair under an acre and we would measure as a hair over never reaches us. Both measures are
   * within a fraction of a percent of each other and the band is one acre wide, so this is a rounding
   * difference at the very bottom of the corpus — recorded so it is a known quantity rather than a
   * discovery.
   */
  | 'below-hard-floor';

/** A raw record that did not become a feature, with the reason and enough of it to diagnose. */
export interface LaneDrop {
  readonly ok: false;
  readonly reason: LaneDropReason;
  /** A short identifying fragment — an id where we have one, else a truncated raw line. */
  readonly sample: string;
}

export type LaneOutcome = { readonly ok: true; readonly feature: Feature } | LaneDrop;

const laneDrop = (reason: LaneDropReason, sample: string): LaneDrop => ({
  ok: false,
  reason,
  sample: sample.slice(0, 120),
});

/**
 * Tally lane outcomes by reason, with a bounded sample of each.
 *
 * Deliberately **not** `@skating/run-log`'s `DropLedger`, which is a different instrument for a
 * different question. That one asks *"did this normalizer work?"* over three fixed reasons
 * (`absent` / `sentinel` / `malformed`) and carries `expectAcceptance`, a floor asserted against a
 * stored census. This one asks *"where did the rows go?"* over reasons that are properties of the
 * pipeline rather than of a value. Both are used in the NHD lane, for their own halves.
 */
export class LaneLedger {
  private readonly counts = new Map<LaneDropReason, number>();
  private readonly samples = new Map<LaneDropReason, string[]>();
  private seenCount = 0;
  private keptCount = 0;

  /** Record one outcome and hand back the feature, if there is one. */
  record(outcome: LaneOutcome): Feature | undefined {
    this.seenCount += 1;
    if (outcome.ok) {
      this.keptCount += 1;
      return outcome.feature;
    }
    this.counts.set(outcome.reason, (this.counts.get(outcome.reason) ?? 0) + 1);
    const bucket = this.samples.get(outcome.reason) ?? [];
    if (bucket.length < LANE_SAMPLE_CAP) bucket.push(outcome.sample);
    this.samples.set(outcome.reason, bucket);
    return undefined;
  }

  get seen(): number {
    return this.seenCount;
  }

  get kept(): number {
    return this.keptCount;
  }

  get dropped(): number {
    return this.seenCount - this.keptCount;
  }

  /**
   * `seen === kept + dropped`, asserted rather than assumed.
   *
   * A tautology as the class stands, and that is the point of writing it down: it is the invariant a
   * future `return` added inside a lane would break, and the equation the run report is built on.
   */
  balances(): boolean {
    let total = 0;
    for (const n of this.counts.values()) total += n;
    return this.keptCount + total === this.seenCount;
  }

  entries(): { reason: LaneDropReason; count: number; samples: string[] }[] {
    return [...this.counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count, samples: this.samples.get(reason) ?? [] }));
  }

  /** Flattened `{ name, value }` counts for a run row. */
  counts_(label: string): { name: string; value: number }[] {
    return [
      { name: `${label}.seen`, value: this.seenCount },
      { name: `${label}.kept`, value: this.keptCount },
      ...this.entries().map((e) => ({ name: `${label}.dropped.${e.reason}`, value: e.count })),
    ];
  }
}

/** How many raw samples to keep per reason. Enough to diagnose, small enough for a run row. */
export const LANE_SAMPLE_CAP = 5;

/**
 * The shape `osmium export -a type,id` emits, as far as we read it.
 *
 * **`unknown` values, not `string`**, and that is not fussiness: `osmium export -a type,id` emits
 * `@id` as a **number** while every real tag is a string, so a bag typed as `Record<string, string>`
 * is asserting something false about the same object. `transform.ts` learned this the expensive way —
 * `readTag` calls `.split(';')` on whatever it is handed, so a numeric value became a `TypeError`
 * inside a per-feature `try`/`catch`, i.e. a silently skipped body.
 */
export interface RawOsmFeature {
  properties?: Record<string, unknown> | null;
  geometry?: Polygon | MultiPolygon | null;
}

/** Read one property as a string, or `undefined` — the only safe way to read an OSM tag bag. */
function tag(props: Record<string, unknown>, key: string): string | undefined {
  const v = props[key];
  return typeof v === 'string' ? v : undefined;
}

/** The string-valued tags only, which is what the classifier is entitled to assume it has. */
function stringTags(props: Record<string, unknown>): OsmTagBag {
  const out: OsmTagBag = {};
  for (const [k, v] of Object.entries(props)) if (typeof v === 'string') out[k] = v;
  return out;
}

/**
 * One OSM export record → a classified `Feature`, or a counted refusal.
 *
 * `seen` is the caller's dedup set: the five state extracts overlap at every border, so the same
 * `way/123` arrives up to five times and only the first is a body. Mutated here rather than in the
 * caller so the duplicate is *counted* instead of being skipped before it is ever seen.
 */
export function parseOsmFeature(raw: RawOsmFeature, seen: Set<string>): LaneOutcome {
  const p = raw.properties;
  const type = p ? tag(p, '@type') : undefined;
  const rawId = p?.['@id'];
  if (!p || !type || (typeof rawId !== 'string' && typeof rawId !== 'number')) {
    return laneDrop('no-id', JSON.stringify(p ?? {}));
  }
  const id = `${type}/${rawId}`;
  if (!raw.geometry) return laneDrop('no-geometry', id);
  if (seen.has(id)) return laneDrop('duplicate', id);
  seen.add(id);

  const areaSqM = surfaceAreaSqM(raw.geometry);
  if (areaSqM < HARD_MIN_SURFACE_AREA_SQM) return laneDrop('below-hard-floor', id);

  const name = tag(p, 'name') ?? '';
  // **`gnis:feature_id`, captured for the first time.** The stored corpus has none, which is why the
  // GNIS-assisted reconciliation bar has never once fired; 35.3% of named OSM water features have one.
  const gnis = normalizeGnisId(tag(p, 'gnis:feature_id'));
  const verdict = classifyWaterBody({ name, claim: classifyOsmTags(stringTags(p)) });
  return {
    ok: true,
    feature: {
      source: 'osm',
      id,
      name,
      cls: verdict.cls,
      token: verdict.token,
      sourceToken: verdict.sourceToken,
      gnisId: gnis.ok ? gnis.value : undefined,
      polygon: raw.geometry,
      bbox: polygonBBox(raw.geometry),
      areaSqM,
    },
  };
}

/** The NHD columns the merge's `ogr2ogr -select` asks for. */
export interface RawNhdFeature {
  properties?: Record<string, unknown> | null;
  geometry?: Polygon | MultiPolygon | null;
}

/**
 * One NHD record → a classified `Feature`, or a counted refusal.
 *
 * `onId` receives the raw `permanent_identifier` normalization outcome so the caller can feed a
 * `DropLedger` and assert it against `NHD_ID_CENSUS` — the id rule's own floor, which is a separate
 * question from where the rows went and deserves its own instrument.
 */
export function parseNhdFeature(
  raw: RawNhdFeature,
  seen: Set<string>,
  onId?: (raw: unknown, outcome: ReturnType<typeof normalizeNhdId>) => void,
): LaneOutcome {
  const props = raw.properties ?? {};
  const rawId = props.permanent_identifier;
  const id = normalizeNhdId(rawId as string);
  onId?.(rawId, id);
  if (!id.ok) return laneDrop('unusable-id', String(rawId ?? ''));
  if (!raw.geometry) return laneDrop('no-geometry', id.value);
  // The five geodatabases overlap heavily; audited as area-identical, so first-writer-wins.
  if (seen.has(id.value)) return laneDrop('duplicate', id.value);
  seen.add(id.value);

  const areaSqM = surfaceAreaSqM(raw.geometry);
  if (areaSqM < HARD_MIN_SURFACE_AREA_SQM) return laneDrop('below-hard-floor', id.value);

  const name = (props.gnis_name as string) ?? '';
  const gnis = normalizeGnisId(props.gnis_id as string);
  const verdict = classifyWaterBody({
    name,
    claim: classifyNhd(Number(props.ftype), Number(props.fcode)),
  });
  return {
    ok: true,
    feature: {
      source: 'nhd',
      id: id.value,
      name,
      cls: verdict.cls,
      token: verdict.token,
      sourceToken: verdict.sourceToken,
      gnisId: gnis.ok ? gnis.value : undefined,
      polygon: raw.geometry,
      bbox: polygonBBox(raw.geometry),
      areaSqM,
    },
  };
}

/** The 3DHP columns the merge's `ogr2ogr -select` asks for. */
export interface RawThreeDhpFeature {
  properties?: Record<string, unknown> | null;
  geometry?: Polygon | MultiPolygon | null;
}

/** One 3DHP record → a classified `Feature`, or a counted refusal. */
export function parseThreeDhpFeature(raw: RawThreeDhpFeature, seen: Set<string>): LaneOutcome {
  const props = raw.properties ?? {};
  const id = String(props.id3dhp ?? '');
  if (id.length === 0 || id === 'undefined' || id === 'null') {
    return laneDrop('no-id', JSON.stringify(props).slice(0, 80));
  }
  if (!raw.geometry) return laneDrop('no-geometry', id);
  // `id3dhp` audited as a clean primary key over all 274,994 rows — so a hit here is a real finding
  // rather than expected overlap, and it is counted rather than assumed impossible.
  if (seen.has(id)) return laneDrop('duplicate', id);
  seen.add(id);

  const areaSqM = surfaceAreaSqM(raw.geometry);
  if (areaSqM < HARD_MIN_SURFACE_AREA_SQM) return laneDrop('below-hard-floor', id);

  const name = (props.gnisidlabel as string) ?? '';
  const gnis = normalizeGnisId(props.gnisid as number);
  const verdict = classifyWaterBody({
    name,
    claim: classifyThreeDhp(Number(props.featuretype)),
  });
  return {
    ok: true,
    feature: {
      source: '3dhp',
      id,
      name,
      cls: verdict.cls,
      token: verdict.token,
      sourceToken: verdict.sourceToken,
      gnisId: gnis.ok ? gnis.value : undefined,
      polygon: raw.geometry,
      bbox: polygonBBox(raw.geometry),
      areaSqM,
    },
  };
}

/**
 * Parse one NDJSON line into whatever the lane expects, or report it unparseable.
 *
 * Shared by all three lanes because a truncated extract fails identically in each, and because
 * `JSON.parse` inside a `try { } catch { continue }` was one of the silent exits the audit found.
 */
export function parseLine<T>(line: string): { ok: true; value: T } | LaneDrop {
  try {
    return { ok: true, value: JSON.parse(line) as T };
  } catch {
    return laneDrop('unparseable', line);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The drop ledger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why the admission floor refused a body — the label that appears in the merge report.
 *
 * **Reads the merged name, not the catalogue name.** The first version of this read `group.name`
 * while `belongsInCorpus` was given the GNIS-augmented name, so a wetland admitted by its gazetteer
 * name and then refused for size was reported as "unnamed" — the one lane whose contribution the
 * report exists to measure, described as absent.
 */
export function dropReason(body: { name: string; cls: WaterBodyClass; areaSqM: number }): string {
  const acres = body.areaSqM / SQ_M_PER_ACRE;
  if (acres < 1) return 'below 1 acre';
  if (body.cls === 'wetland') {
    return body.name.length > 0 ? 'wetland, named, under floor' : 'unnamed wetland under 50 acres';
  }
  return 'unnamed, 1–5 acres';
}

// ─────────────────────────────────────────────────────────────────────────────
// The emit stage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The catalogue ids a merged group carries — **the upsert key `importCanonical` now runs on** (D93).
 *
 * One id per catalogue, and a group holding two features from the same catalogue takes the *first*
 * — which is safe only because such a group is already flagged `sameSourceDuplicate` and queued for
 * a human. Silently picking one of two OSM ids for a body that may be two lakes chained together is
 * exactly the kind of guess that should not also decide identity, so the flag is what makes this
 * tolerable rather than the tie-break being clever.
 *
 * `gnisId` is included and is **not** an upsert key: it proposes candidates, and 92 GNIS ids resolve
 * to more than one NHD body. Taken from any member that has one, since all three catalogues publish
 * the same gazetteer id for the same place.
 *
 * `fromGazetteer` is the id the GNIS lane itself resolved, used **only when no catalogue asserted
 * one**. The ordering is deliberate: a catalogue naming a GNIS id is naming *this feature*, where the
 * gazetteer is naming a place we located geometrically — and geometric location is exactly the
 * inference `gnisId` is documented not to be trusted for. So it fills a hole and never overrules.
 */
export function catalogueIdsOf(
  members: readonly Feature[],
  fromGazetteer?: string | undefined,
): {
  osmId?: string;
  nhdId?: string;
  threeDhpId?: string;
  gnisId?: string;
} {
  const out: { osmId?: string; nhdId?: string; threeDhpId?: string; gnisId?: string } = {};
  // **The largest per source, matching `chooseGeometry`** — see `representativeOf`. Taking the first
  // here while the geometry took the largest would put a row's `externalId` and its `osmId` on two
  // different OSM features.
  const osm = representativeOf(members, 'osm');
  const nhd = representativeOf(members, 'nhd');
  const dhp = representativeOf(members, '3dhp');
  if (osm) out.osmId = osm.id;
  if (nhd) out.nhdId = nhd.id;
  if (dhp) out.threeDhpId = dhp.id;
  // The gazetteer id is a property of the place rather than of a feature, so the first member that
  // carries one answers for the group.
  for (const m of members) {
    if (out.gnisId === undefined && m.gnisId) out.gnisId = m.gnisId;
  }
  if (out.gnisId === undefined && fromGazetteer) out.gnisId = fromGazetteer;
  return out;
}

/** The five states we cover, by the name their TIGER boundary carries. */
export const STATE_CODE_BY_NAME: Readonly<Record<string, string>> = {
  Maine: 'ME',
  'New Hampshire': 'NH',
  Vermont: 'VT',
  Massachusetts: 'MA',
  'New York': 'NY',
};

/**
 * Every state this body touches — **all of them, not the first.**
 *
 * A border-spanning body belongs to each state it reaches: Champlain is in both VT and NY, and
 * filtering "lakes in Vermont" must find it. The OSM lane got this for free by importing one state
 * extract at a time and letting `importCanonical` union a `--state` tag per batch; a merged corpus
 * is loaded in a single pass, so there are no per-state batches and the answer has to be computed
 * here instead.
 *
 * Tested against **state-level** boundaries only. The region mask is built from counties and towns
 * because those are the finer, more reliable outlines, but a county does not know its state's code —
 * so this is a second, coarser pass over a different set, and a body that clears the mask can still
 * come back empty here if it sits in a gap between two state polygons. An empty result is left empty
 * rather than guessed: a wrong state code is worse than a missing one, because it silently moves a
 * lake into someone else's region filter.
 */
export function statesFor(
  body: { polygon: Polygon | MultiPolygon; bbox: BBox },
  stateGrid: Map<string, (Boundary & { name: string })[]>,
): string[] {
  const found = collectStates(sampleOutline(body.polygon), stateGrid);
  if (found.size > 0) return [...found].sort();

  // ── The escalation, and why a sampled empty was never good enough ────────────────────────────
  //
  // **`inRegion` walks every vertex before it drops a body; this used to walk eight per ring.** Two
  // functions asking nearly the same question at different rigour, and the gap between them is a
  // body that is admitted to the corpus and belongs to no state — invisible in the feed, in the
  // drive-time filter and in every state chip in the app, with nothing anywhere saying so.
  //
  // Measured on the 2026-08-06 run: **9 bodies**, every one of them a border-straddler admitted on a
  // single vertex the sparse sample missed — Greenwood Lake on the NY/NJ line, 100 Acre Cove and
  // Central Pond on the MA/RI line, a Québec-border pond in northern Maine.
  //
  // Only paid when the cheap pass found nothing, which is those nine bodies and not the other
  // 25,463.
  for (const ring of outerRings(body.polygon)) {
    if (!ring) continue;
    const all = collectStates(ring as [number, number][], stateGrid);
    if (all.size > 0) return [...all].sort();
  }
  return [];
}

/** Which of the five states these points fall in. The shared inner loop of `statesFor`'s two passes. */
function collectStates(
  points: readonly (readonly [number, number])[],
  stateGrid: Map<string, (Boundary & { name: string })[]>,
): Set<string> {
  const found = new Set<string>();
  for (const [lng, lat] of points) {
    const cell = `${Math.floor(lng / CELL_DEG)}:${Math.floor(lat / CELL_DEG)}`;
    for (const b of stateGrid.get(cell) ?? []) {
      const code = STATE_CODE_BY_NAME[b.name];
      if (code === undefined || found.has(code)) continue;
      if (lng < b.bbox.minLng || lng > b.bbox.maxLng) continue;
      if (lat < b.bbox.minLat || lat > b.bbox.maxLat) continue;
      if (pointInPolygon({ lat, lng }, b.polygon)) found.add(code);
    }
  }
  return found;
}
