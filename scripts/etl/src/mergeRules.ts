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
  type BBox,
  type ClaimSource,
  pointInPolygon,
  RECONCILE_MIN_IOU,
  type WaterBodyClass,
} from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';

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
  /** The classifier's token, e.g. `3dhp:featuretype=4`. Carried so a VETO can be recognised. */
  readonly token: string;
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

/** Does any member of this group carry a refusal no other source may overturn? */
export function isVetoed(members: readonly Feature[]): boolean {
  return members.some((m) => VETO_TOKENS.has(m.token));
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
  let best: string | undefined;
  for (const m of members) {
    if (m.name.length === 0) continue;
    if (best === undefined || m.name.length > best.length) best = m.name;
  }
  return best ?? '';
}

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
export function chooseGeometry(members: readonly Feature[]): Feature | undefined {
  return (
    members.find((m) => m.source === 'osm') ?? members.find((m) => m.source === 'nhd') ?? members[0]
  );
}

/**
 * Collapse one group of matched features into one body, or `null` if it is refused.
 *
 * Refused means one of two things, and the caller cannot tell them apart from the return value
 * alone — see `mergeGroupWithReason` when the distinction matters for a report.
 */
export function mergeGroup(members: Feature[]): Merged | null {
  return mergeGroupWithReason(members).body;
}

/** Why a group was refused, for a report that would otherwise conflate two different findings. */
export type RefusalReason = 'vetoed' | 'no-class' | 'empty';

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
  if (isVetoed(members)) return { body: null, reason: 'vetoed' };

  const cls = chooseClass(members);
  if (cls === null) return { body: null, reason: 'no-class' };

  const preferred = chooseGeometry(members);
  if (preferred === undefined) return { body: null, reason: 'empty' };

  // Two features from ONE catalogue in one group means either our matching chained two distinct
  // lakes, or the catalogue carries a duplicate it cannot see. Both are findings; neither may merge
  // unattended. This is the only guard against a three-lane union-find chaining unrelated bodies.
  const bySource = new Map<ClaimSource, number>();
  for (const m of members) bySource.set(m.source, (bySource.get(m.source) ?? 0) + 1);
  const sameSourceDuplicate = [...bySource.values()].some((v) => v > 1);

  return {
    body: {
      key: `${preferred.source}:${preferred.id}`,
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
 * `osm→nhd`, and the federal lane ran `3dhp→nhd`. So both orderings are tried. A miss falls back to
 * `RECONCILE_MIN_IOU`, which is the *floor* of what the match must have scored to exist at all —
 * conservative, and never invented upward.
 */
export function polygonClaims(
  group: Pick<Merged, 'members' | 'geometrySource' | 'key'>,
  iou: ReadonlyMap<string, number>,
): AttributeClaim<number>[] {
  const chosen = idFromKey(group.key);
  return group.members.map((m) => ({
    source: m.source,
    value:
      m.source === group.geometrySource
        ? 1
        : (iou.get(`${m.id}|${chosen}`) ?? iou.get(`${chosen}|${m.id}`) ?? RECONCILE_MIN_IOU),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// The bay rule
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does this bay have a larger body it could be an arm of?
 *
 * A bay is an arm OF something. With no parent we cannot support the claim — **Half Moon Cove is 330
 * acres, named "Cove", and is a wetland** — so the body is demoted to `unclassified` and queued for a
 * human rather than dropped.
 *
 * ⚠ **The test is bounding-box containment, not polygon containment**, and that is weaker than it
 * reads. `covers()` asks whether the candidate's *box* encloses the bay's *box*, which a large
 * L-shaped or crescent body satisfies for bays it does not actually touch. It is preserved as it ran
 * because tightening it moves bodies between `bay` and `unclassified` — 159 sit on this rule today —
 * and that is a measurement to take deliberately, not a side effect of adding a test. See the
 * `bay-parent` cases in the test file for the exact false positive it admits.
 */
export function hasBayParent(
  bay: Pick<Merged, 'bbox' | 'areaSqM'>,
  grid: Map<string, Merged[]>,
): boolean {
  for (const cell of cellsFor(bay.bbox)) {
    for (const candidate of grid.get(cell) ?? []) {
      if (candidate.areaSqM > bay.areaSqM && covers(candidate.bbox, bay.bbox)) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// The region clip
// ─────────────────────────────────────────────────────────────────────────────

export interface Boundary {
  readonly bbox: BBox;
  readonly polygon: Polygon | MultiPolygon;
}

/**
 * How many points to sample along each outer ring when asking whether a body is in region.
 *
 * ⚠ **A sample, not a proof.** Eight points per ring is cheap and catches every ordinary case, but a
 * body can be genuinely in-state and have all eight of its sampled vertices land in a gap between two
 * boundary polygons — the county and town layers are separately generalised, so they do not tile the
 * state exactly. 35,637 bodies were excluded by this test on the last run; the number is plausible
 * (the state geodatabases are not clipped to their states) but has not been audited against a
 * known-in-region set. Raising it costs linear time and nothing else.
 */
export const REGION_SAMPLE_POINTS = 8;

/** The outer ring of each polygon in a geometry. Holes are irrelevant to "is any part in region". */
export function outerRings(g: Polygon | MultiPolygon): number[][][] {
  return g.type === 'Polygon'
    ? [g.coordinates[0] as number[][]]
    : g.coordinates.map((poly) => poly[0] as number[][]);
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
  for (const [lng, lat] of sampleOutline(body.polygon)) {
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
}

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
export function gnisNameFor(
  body: { polygon: Polygon | MultiPolygon; bbox: BBox },
  grid: Map<string, GnisPoint[]>,
): string | undefined {
  let found: GnisPoint | undefined;
  // A point can sit in more than one cell's bucket only if the buckets overlap, which they do not —
  // but a body's bbox spans many cells, so the same point is never seen twice while distinct points
  // in different cells both count. Two is enough to give up.
  for (const cell of cellsFor(body.bbox)) {
    for (const p of grid.get(cell) ?? []) {
      if (p.lng < body.bbox.minLng || p.lng > body.bbox.maxLng) continue;
      if (p.lat < body.bbox.minLat || p.lat > body.bbox.maxLat) continue;
      if (!pointInPolygon({ lat: p.lat, lng: p.lng }, body.polygon)) continue;
      if (found !== undefined) return undefined; // ambiguous
      found = p;
    }
  }
  return found?.name;
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
 */
export function catalogueIdsOf(members: readonly Feature[]): {
  osmId?: string;
  nhdId?: string;
  threeDhpId?: string;
  gnisId?: string;
} {
  const out: { osmId?: string; nhdId?: string; threeDhpId?: string; gnisId?: string } = {};
  for (const m of members) {
    if (m.source === 'osm' && out.osmId === undefined) out.osmId = m.id;
    if (m.source === 'nhd' && out.nhdId === undefined) out.nhdId = m.id;
    if (m.source === '3dhp' && out.threeDhpId === undefined) out.threeDhpId = m.id;
    if (out.gnisId === undefined && m.gnisId) out.gnisId = m.gnisId;
  }
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
  const found = new Set<string>();
  for (const [lng, lat] of sampleOutline(body.polygon)) {
    const cell = `${Math.floor(lng / CELL_DEG)}:${Math.floor(lat / CELL_DEG)}`;
    for (const b of stateGrid.get(cell) ?? []) {
      const code = STATE_CODE_BY_NAME[b.name];
      if (code === undefined || found.has(code)) continue;
      if (lng < b.bbox.minLng || lng > b.bbox.maxLng) continue;
      if (lat < b.bbox.minLat || lat > b.bbox.maxLat) continue;
      if (pointInPolygon({ lat, lng }, b.polygon)) found.add(code);
    }
  }
  return [...found].sort();
}
