/**
 * **The master list** — three catalogues in, one record per lake out (N7, D109/D110).
 *
 *   pnpm --filter @skating/etl merge            # read-only; writes .scratch/merge/
 *   pnpm --filter @skating/etl merge --refresh  # re-extract the sources first
 *
 * ## The ordering, and why it is the whole point
 *
 * The campaign as first built filtered each source *before* anything merged, and that is the defect
 * this file exists to remove: OSM tags a body `wetland=marsh`, the floor deletes it as an unnamed
 * wetland, and NHD — which calls the same polygon `LakePond` and gives it a name — never gets a say.
 * It cost **123 measured bodies**, 17 of them GNIS-named.
 *
 * So: **merge first, filter once.** The only rule applied before the merge is the one-acre hard floor
 * (D96 rule 1), because it is the only admission rule no other source can overturn — every other rule
 * reads `name` or `class`, and the merge is precisely the thing that changes those.
 *
 * ## Federal first, then OSM — and all three lanes count
 *
 * NHD and 3DHP are matched to each other before either meets OSM (founder call, 2026-08-04), because
 * it is both the easiest match in the project and the one that keeps the arithmetic honest: 3DHP
 * re-publishes NHD across the whole Northeast, 68% of the polygons byte-identical and the rest
 * differing only by float round-trip through the Albers reprojection. Two sources that are the same
 * data are not two opinions, and collapsing them first means `independentVoices` cannot be fooled.
 *
 * **But no lane is a discarded control.** All three sets of pairs feed the grouping. An earlier draft
 * ran OSM↔3DHP purely as a diagnostic and threw its matches away, which meant a 3DHP feature with no
 * NHD counterpart could never reach OSM at all — evidence paid for and binned. The false-negative
 * measurement needs no sacrificial lane; it is a set difference over what each lane matched.
 *
 * **NHD is nonetheless the identity spine, and the reason is not currency.** Currency points the
 * other way — NHD froze in 2023 and 3DHP improves every year — but 3DHP carries no
 * `Permanent_Identifier` (so it cannot hold the MIDAS bathymetry linkage or collapse the OSM
 * duplicate pairs) and publishes **no wetland class at all**, against NHD's 44,295 SwampMarsh
 * features above an acre. A 3DHP-primary merge would fail to match every wetland in the region.
 * Which catalogue draws the better *outline* is a separate question, and `geometrySource` answers it
 * as a field.
 *
 * ## What it does not do
 *
 * Writes nothing to Convex. Chooses geometry by a **provisional** rule pending D92's bake-off — which
 * is safe precisely because `geometrySource` is a field, so changing it later is an update rather
 * than a migration.
 */

import { spawnSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  type AttributeClaim,
  type BBox,
  belongsInCorpus,
  type ClaimSource,
  classifyNhd,
  classifyOsmTags,
  classifyThreeDhp,
  classifyWaterBody,
  HARD_MIN_SURFACE_AREA_SQM,
  isNearMiss,
  mergeReviewReasons,
  needsAttention,
  type OsmTagBag,
  polygonBBox,
  RECONCILE_MIN_IOU,
  type ReconcileCandidate,
  reconcileOne,
  scoreBody,
  surfaceAreaSqM,
  type WaterBodyClass,
} from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import { NHD_SOURCES, nhdArchiveKey, normalizeGnisId, normalizeNhdId } from './nhdArchive';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(HERE, '..', '.scratch', 'merge');
const CLASSIFY_SCRATCH = join(HERE, '..', '.scratch', 'classify');
const OSM_DIR = join(HERE, '..', '.raw');
const NHD_DIR = join(HERE, '..', '.raw-nhd');
const THREE_DHP_DIR = join(HERE, '..', '.raw-3dhp', 'waterbody');

const OSM_STATES = ['me', 'nh', 'vt', 'ma', 'ny'] as const;
const RECORD_SEPARATOR = String.fromCharCode(0x1e);
/** 0.1° ≈ 11 km. A few candidates per cell in our region. */
const CELL_DEG = 0.1;

function log(message: string): void {
  process.stderr.write(`[merge] ${message}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sources
// ─────────────────────────────────────────────────────────────────────────────

interface Feature {
  readonly source: ClaimSource;
  readonly id: string;
  readonly name: string;
  readonly cls: WaterBodyClass | null;
  readonly gnisId?: string | undefined;
  readonly polygon: Polygon | MultiPolygon;
  readonly bbox: BBox;
  readonly areaSqM: number;
}

/** Applied to every lane before anything else: D96 rule 1, the only source-independent rule. */
function admissible(areaSqM: number): boolean {
  return areaSqM >= HARD_MIN_SURFACE_AREA_SQM;
}

async function loadOsm(refresh: boolean): Promise<Feature[]> {
  const out: Feature[] = [];
  const seen = new Set<string>();
  for (const state of OSM_STATES) {
    const file = join(CLASSIFY_SCRATCH, `osm-${state}.geojsonseq`);
    if (!existsSync(file) || refresh) extractOsm(state, file);
    const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const raw of rl) {
      const t = raw.trim();
      const line = t.startsWith(RECORD_SEPARATOR) ? t.slice(1) : t;
      if (line.length === 0) continue;
      let f: {
        properties: OsmTagBag & { '@type'?: string; '@id'?: string | number; name?: string };
        geometry: Polygon | MultiPolygon | null;
      };
      try {
        f = JSON.parse(line);
      } catch {
        continue;
      }
      const p = f.properties;
      if (!p['@type'] || p['@id'] === undefined || !f.geometry) continue;
      const id = `${p['@type']}/${p['@id']}`;
      if (seen.has(id)) continue; // the five extracts overlap at every border
      seen.add(id);
      const areaSqM = surfaceAreaSqM(f.geometry);
      if (!admissible(areaSqM)) continue;
      const name = p.name ?? '';
      // **`gnis:feature_id`, captured for the first time.** The stored corpus has none, which is why
      // the GNIS-assisted bar has never once fired; 35.3% of named OSM water features carry one.
      const gnis = normalizeGnisId(p['gnis:feature_id']);
      out.push({
        source: 'osm',
        id,
        name,
        cls: classifyWaterBody({ name, claim: classifyOsmTags(p) }).cls,
        gnisId: gnis.ok ? gnis.value : undefined,
        polygon: f.geometry,
        bbox: polygonBBox(f.geometry),
        areaSqM,
      });
    }
  }
  return out;
}

function extractOsm(state: string, out: string): void {
  const dir = join(OSM_DIR, state);
  const { filename } = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
    filename: string;
  };
  const filtered = join(CLASSIFY_SCRATCH, `osm-${state}.pbf`);
  log(`${state}: filtering…`);
  const a = spawnSync(
    'osmium',
    [
      'tags-filter',
      '-t',
      join(dir, filename),
      'natural=water',
      'landuse=reservoir',
      'natural=bay',
      'natural=wetland',
      'water',
      '-o',
      filtered,
      '--overwrite',
    ],
    { encoding: 'utf8' },
  );
  if (a.status !== 0) throw new Error(`${state}: osmium tags-filter exited ${a.status}`);
  const b = spawnSync(
    'osmium',
    [
      'export',
      filtered,
      '--geometry-types=polygon',
      '-a',
      'type,id',
      '-f',
      'geojsonseq',
      '-x',
      'print_record_separator=false',
      '-o',
      out,
      '--overwrite',
    ],
    { encoding: 'utf8' },
  );
  if (b.status !== 0) throw new Error(`${state}: osmium export exited ${b.status}`);
}

/**
 * NHD, **at the one-acre floor**.
 *
 * The standalone reconciler exported at five acres, so every corpus body between one and five acres
 * was scored against an empty candidate set — 2,060 of them, measured, indistinguishable in the
 * output from a lake NHD has never heard of.
 */
function loadNhd(refresh: boolean): Feature[] {
  const out: Feature[] = [];
  const seen = new Set<string>();
  for (const source of NHD_SOURCES) {
    const key = nhdArchiveKey(source);
    const { filename } = JSON.parse(readFileSync(join(NHD_DIR, key, 'manifest.json'), 'utf8')) as {
      filename: string;
    };
    const geojson = join(SCRATCH, `nhd-${key}.geojsonl`);
    if (!existsSync(geojson) || refresh) {
      rmSync(geojson, { force: true });
      log(`${key}: extracting NHD polygons at the 1-acre floor…`);
      const res = spawnSync(
        'ogr2ogr',
        [
          '-f',
          'GeoJSONSeq',
          geojson,
          `/vsizip/${join(NHD_DIR, key, filename)}`,
          'NHDWaterbody',
          '-select',
          'permanent_identifier,gnis_id,gnis_name,ftype,fcode,areasqkm',
          '-where',
          'areasqkm >= 0.0040468564224',
          '-t_srs',
          'EPSG:4326',
          '-dim',
          'XY',
          '-overwrite',
        ],
        { encoding: 'utf8' },
      );
      if (res.status !== 0) throw new Error(`${key}: ogr2ogr exited ${res.status}`);
    }
    for (const line of readFileSync(geojson, 'utf8').split('\n')) {
      const t = line.trim();
      if (t.length === 0) continue;
      let f: { properties: Record<string, unknown>; geometry: Polygon | MultiPolygon | null };
      try {
        f = JSON.parse(t);
      } catch {
        continue;
      }
      if (!f.geometry) continue;
      const id = normalizeNhdId(f.properties.permanent_identifier as string);
      // The five geodatabases overlap heavily; audited as area-identical, so first-writer-wins.
      if (!id.ok || seen.has(id.value)) continue;
      seen.add(id.value);
      const areaSqM = surfaceAreaSqM(f.geometry);
      if (!admissible(areaSqM)) continue;
      const name = (f.properties.gnis_name as string) ?? '';
      const gnis = normalizeGnisId(f.properties.gnis_id as string);
      out.push({
        source: 'nhd',
        id: id.value,
        name,
        cls: classifyWaterBody({
          name,
          claim: classifyNhd(Number(f.properties.ftype), Number(f.properties.fcode)),
        }).cls,
        gnisId: gnis.ok ? gnis.value : undefined,
        polygon: f.geometry,
        bbox: polygonBBox(f.geometry),
        areaSqM,
      });
    }
  }
  return out;
}

function loadThreeDhp(refresh: boolean): Feature[] {
  const { filename } = JSON.parse(readFileSync(join(THREE_DHP_DIR, 'manifest.json'), 'utf8')) as {
    filename: string;
  };
  const geojson = join(SCRATCH, '3dhp.geojsonl');
  if (!existsSync(geojson) || refresh) {
    rmSync(geojson, { force: true });
    log('3dhp: extracting polygons at the 1-acre floor…');
    const res = spawnSync(
      'ogr2ogr',
      [
        '-f',
        'GeoJSONSeq',
        geojson,
        join(THREE_DHP_DIR, filename),
        'waterbody',
        '-select',
        'id3dhp,gnisid,gnisidlabel,featuretype,areasqkm',
        '-where',
        'areasqkm >= 0.0040468564224',
        '-t_srs',
        'EPSG:4326',
        '-dim',
        'XY',
        '-overwrite',
      ],
      { encoding: 'utf8' },
    );
    if (res.status !== 0) throw new Error(`3dhp: ogr2ogr exited ${res.status}`);
  }
  const out: Feature[] = [];
  for (const line of readFileSync(geojson, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    let f: { properties: Record<string, unknown>; geometry: Polygon | MultiPolygon | null };
    try {
      f = JSON.parse(t);
    } catch {
      continue;
    }
    if (!f.geometry) continue;
    const areaSqM = surfaceAreaSqM(f.geometry);
    if (!admissible(areaSqM)) continue;
    const name = (f.properties.gnisidlabel as string) ?? '';
    const gnis = normalizeGnisId(f.properties.gnisid as number);
    out.push({
      source: '3dhp',
      id: String(f.properties.id3dhp),
      name,
      cls: classifyWaterBody({ name, claim: classifyThreeDhp(Number(f.properties.featuretype)) })
        .cls,
      gnisId: gnis.ok ? gnis.value : undefined,
      polygon: f.geometry,
      bbox: polygonBBox(f.geometry),
      areaSqM,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Matching
// ─────────────────────────────────────────────────────────────────────────────

function cellsFor(box: BBox): string[] {
  const out: string[] = [];
  for (let x = Math.floor(box.minLng / CELL_DEG); x <= Math.floor(box.maxLng / CELL_DEG); x++) {
    for (let y = Math.floor(box.minLat / CELL_DEG); y <= Math.floor(box.maxLat / CELL_DEG); y++) {
      out.push(`${x}:${y}`);
    }
  }
  return out;
}

function index(features: readonly Feature[]): Map<string, Feature[]> {
  const grid = new Map<string, Feature[]>();
  for (const f of features) {
    for (const cell of cellsFor(f.bbox)) {
      const bucket = grid.get(cell);
      if (bucket) bucket.push(f);
      else grid.set(cell, [f]);
    }
  }
  return grid;
}

interface MatchStats {
  matched: number;
  ambiguous: number;
  none: number;
  nearMiss: number;
}

/** Match every feature in `targets` against `candidates`, returning id→id pairs and a tally. */
function matchLane(
  targets: readonly Feature[],
  candidates: readonly Feature[],
  label: string,
): { pairs: [string, string][]; stats: MatchStats; iou: Map<string, number> } {
  const grid = index(candidates);
  const pairs: [string, string][] = [];
  const iou = new Map<string, number>();
  const stats: MatchStats = { matched: 0, ambiguous: 0, none: 0, nearMiss: 0 };
  let done = 0;
  for (const target of targets) {
    if (++done % 20000 === 0)
      log(`  ${label}: ${done.toLocaleString()} / ${targets.length.toLocaleString()}`);
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
    } else {
      stats.none++;
      if (isNearMiss(outcome)) stats.nearMiss++;
    }
  }
  return { pairs, stats, iou };
}

// ─────────────────────────────────────────────────────────────────────────────
// Grouping — union-find over every matched pair
// ─────────────────────────────────────────────────────────────────────────────

class Union {
  private readonly parent = new Map<string, string>();
  find(a: string): string {
    let root = this.parent.get(a) ?? a;
    if (root === a) return a;
    root = this.find(root);
    this.parent.set(a, root);
    return root;
  }
  join(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The merged record
// ─────────────────────────────────────────────────────────────────────────────

/** Rank for picking the stored class when a group disagrees. Mirrors core's CLASS_RANK. */
const CLASS_ORDER: WaterBodyClass[] = [
  'reservoir',
  'river',
  'lakePond',
  'bay',
  'wetland',
  'unclassified',
];

interface Merged {
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

function mergeGroup(members: Feature[]): Merged | null {
  const bySource = new Map<ClaimSource, Feature[]>();
  for (const m of members) {
    const list = bySource.get(m.source);
    if (list) list.push(m);
    else bySource.set(m.source, [m]);
  }
  // Two features from ONE catalogue in one group means either our matching chained two distinct
  // lakes, or the catalogue carries a duplicate it cannot see. Both are findings; neither may merge
  // unattended.
  const sameSourceDuplicate = [...bySource.values()].some((v) => v.length > 1);

  // **Name: union, preferring the more specific.** A name is a boolean assertion that a place is a
  // place, so taking one over its absence biases nothing (D94).
  const named = members
    .filter((m) => m.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const name = named[0]?.name ?? '';

  // **A group every catalogue refused is refused — it is not `unclassified`.** `null` means "not
  // water we cover"; `unclassified` means "water, but nobody said what kind". Collapsing the first
  // into the second admitted **Lake Huron and seven polygons of the Atlantic Ocean** on the first
  // real run, because 3DHP publishes ocean and river features that `classifyThreeDhp` drops and the
  // merge then resurrected. A drop that survives a merge is worse than no drop at all: it launders a
  // refusal into a shrug.
  //
  // A group where SOME member refuses and another names a class keeps the class — that is the whole
  // point of merging before filtering, and it is what rescues a body OSM calls `wetland=marsh` and
  // NHD calls `LakePond`.
  const classes = members.map((m) => m.cls).filter((c): c is WaterBodyClass => c !== null);
  if (classes.length === 0) return null;
  const cls = CLASS_ORDER.find((c) => classes.includes(c)) ?? ('unclassified' as WaterBodyClass);

  // **Geometry: OSM by default, pending D92.** Provisional and deliberately so — `geometrySource` is
  // a field, so the bake-off's answer lands as an update rather than a migration.
  const preferred =
    members.find((m) => m.source === 'osm') ??
    members.find((m) => m.source === 'nhd') ??
    members[0];
  if (preferred === undefined)
    throw new Error('empty merge group — union-find produced no members');

  return {
    key: `${preferred.source}:${preferred.id}`,
    members,
    name,
    cls,
    // **Measured from the polygon we actually stored, never the larger of two claims** (D94).
    areaSqM: preferred.areaSqM,
    bbox: preferred.bbox,
    polygon: preferred.polygon,
    geometrySource: preferred.source,
    sameSourceDuplicate,
  };
}

/** IoU of each member against the group's chosen outline; 1 for the outline itself. */
function polygonClaims(group: Merged, iou: Map<string, number>): AttributeClaim<number>[] {
  return group.members.map((m) => ({
    source: m.source,
    value:
      m.source === group.geometrySource
        ? 1
        : (iou.get(`${m.id}|${group.key.split(':').slice(1).join(':')}`) ??
          iou.get(`${group.key.split(':').slice(1).join(':')}|${m.id}`) ??
          RECONCILE_MIN_IOU),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const refresh = process.argv.includes('--refresh');
  mkdirSync(SCRATCH, { recursive: true });
  mkdirSync(CLASSIFY_SCRATCH, { recursive: true });

  log('loading sources at the 1-acre floor…');
  const osm = await loadOsm(refresh);
  log(`  osm   ${osm.length.toLocaleString()}`);
  const nhd = loadNhd(refresh);
  log(`  nhd   ${nhd.length.toLocaleString()}`);
  const dhp = loadThreeDhp(refresh);
  log(`  3dhp  ${dhp.length.toLocaleString()}`);

  // Stage 1 — the federal pair, matched to each other first.
  log('stage 1: NHD ↔ 3DHP…');
  const federal = matchLane(dhp, nhd, '3dhp→nhd');
  // Stage 2 — OSM against the federal set. NHD is the federal spine because 3DHP has no
  // Permanent_Identifier and cannot carry the MIDAS linkage.
  log('stage 2: OSM ↔ NHD…');
  const osmNhd = matchLane(osm, nhd, 'osm→nhd');
  log('stage 3: OSM ↔ 3DHP…');
  const osmDhp = matchLane(osm, dhp, 'osm→3dhp');

  // ── Our own error rate, measured ──────────────────────────────────────────
  // 3DHP and NHD are the same polygons here, so a body matching one lane and not the other is OUR
  // matcher erring — the only false-negative estimate available without hand-labelling. It is a set
  // difference over what each lane matched, so both lanes still feed the merge.
  // **Restricted to features BOTH federal catalogues publish, or the number is meaningless.** The
  // first run reported a 15.53% "matcher error rate" that was almost entirely 3DHP simply not
  // carrying the feature: it holds 65,048 features against NHD's 107,955 and publishes **no wetland
  // class at all**. Comparing lanes over features only one of them has measures coverage and calls
  // it error. `federal.pairs` names exactly the NHD features 3DHP also publishes, so the comparison
  // runs over those and nothing else.
  const dualPublished = new Set(federal.pairs.map(([, nhdId]) => nhdId));
  const eligible = new Set(
    osmNhd.pairs.filter(([, nhdId]) => dualPublished.has(nhdId)).map(([a]) => a),
  );
  const dhpHits = new Set(osmDhp.pairs.map(([a]) => a));
  const onlyNhd = [...eligible].filter((a) => !dhpHits.has(a)).length;
  const onlyDhp = [...dhpHits].filter(
    (a) => !eligible.has(a) && osm.some((f) => f.id === a),
  ).length;
  const nhdHits = eligible;

  const iou = new Map([...federal.iou, ...osmNhd.iou, ...osmDhp.iou]);
  const union = new Union();
  // **Every lane contributes identity; none of them is a discarded control** (founder, 2026-08-04).
  //
  // An earlier draft unioned only the federal pair and OSM↔NHD, treating OSM↔3DHP as a diagnostic
  // whose output was thrown away. That is evidence we paid for and then binned: a 3DHP feature with
  // no NHD counterpart could never reach OSM at all. The false-negative measurement does not need a
  // sacrificial lane — it is a set difference over what each lane matched, computed above.
  //
  // **Why NHD is nonetheless the identity spine, and 3DHP cannot be.** 3DHP carries no
  // `Permanent_Identifier`, so it cannot hold the MIDAS bathymetry linkage or collapse the OSM
  // duplicate pairs; and it publishes **no wetland class at all**, against NHD's 44,295 SwampMarsh
  // features above an acre. A 3DHP-primary merge would fail to match every wetland in the region.
  // Currency still points the other way — NHD is frozen at 2023 and 3DHP improves yearly — but that
  // is a question about *geometry*, which `geometrySource` answers as a field, not about identity.
  //
  // Unioning all three can in principle chain two distinct lakes into one group. It is not guarded
  // against here because it does not need to be: two features from one catalogue in one group is
  // exactly what `sameSourceDuplicate` detects, and such a group queues rather than merging.
  for (const [a, b] of [...federal.pairs, ...osmNhd.pairs, ...osmDhp.pairs]) union.join(a, b);

  const byId = new Map<string, Feature>();
  for (const f of [...osm, ...nhd, ...dhp]) byId.set(f.id, f);
  const groups = new Map<string, Feature[]>();
  for (const f of [...osm, ...nhd, ...dhp]) {
    // A feature that matched nothing in any lane is genuinely new and joins as a singleton — which
    // is the case this whole phase exists to capture, and is where Beau Lake arrives from.
    const root = union.find(f.id);
    const g = groups.get(root);
    if (g) g.push(f);
    else groups.set(root, [f]);
  }
  log(`grouped ${byId.size.toLocaleString()} features into ${groups.size.toLocaleString()} bodies`);

  // ── Merge, score, filter ──────────────────────────────────────────────────
  const refusedOutright = { count: 0 };
  const merged = [...groups.values()]
    .map((m) => {
      const out = mergeGroup(m);
      if (out === null) refusedOutright.count++;
      return out;
    })
    .filter((m): m is Merged => m !== null);
  const kept: Merged[] = [];
  const dropped = new Map<string, number>();
  const conf = {
    name: new Map<string, number>(),
    cls: new Map<string, number>(),
    polygon: new Map<string, number>(),
  };
  const queue = new Map<string, number>();
  let backlog = 0;
  let queued = 0;

  // The bay rule needs the whole merged set, so it runs here rather than in the classifier.
  const bayGrid = index(
    merged
      .filter((m) => m.cls !== 'bay')
      .map(
        (m) =>
          ({
            ...m,
            source: m.geometrySource,
            id: m.key,
            cls: m.cls,
            name: m.name,
            areaSqM: m.areaSqM,
          }) as unknown as Feature,
      ),
  );

  for (const group of merged) {
    let cls = group.cls;
    let bayWithoutParent = false;
    if (cls === 'bay') {
      const parent = [...cellsFor(group.bbox)]
        .flatMap((c) => bayGrid.get(c) ?? [])
        .some((p) => p.areaSqM > group.areaSqM && covers(p.bbox, group.bbox));
      if (!parent) {
        // A bay is an arm OF something. With no parent we cannot support the claim — Half Moon Cove
        // is 330 acres, named "Cove", and is a wetland. Demote and let a human look.
        bayWithoutParent = true;
        cls = 'unclassified';
      }
    }

    if (!belongsInCorpus({ name: group.name, surfaceAreaSqM: group.areaSqM, type: cls })) {
      const acres = group.areaSqM / 4046.8564224;
      const reason =
        acres < 1
          ? 'below 1 acre'
          : cls === 'wetland'
            ? group.name
              ? 'wetland, named, under floor'
              : 'unnamed wetland under 50 acres'
            : 'unnamed, 1–5 acres';
      dropped.set(reason, (dropped.get(reason) ?? 0) + 1);
      continue;
    }

    const scores = scoreBody({
      names: group.members.filter((m) => m.name).map((m) => ({ source: m.source, value: m.name })),
      polygons: polygonClaims(group, iou),
      classes: group.members
        .filter((m) => m.cls !== null)
        .map((m) => ({ source: m.source, value: m.cls as WaterBodyClass })),
      depths: [],
    });
    for (const k of ['name', 'cls', 'polygon'] as const) {
      conf[k].set(scores[k], (conf[k].get(scores[k]) ?? 0) + 1);
    }
    const reasons = mergeReviewReasons({
      confidence: scores,
      bayWithoutParent,
      sameSourceDuplicate: group.sameSourceDuplicate,
    });
    if (reasons.length > 0) {
      queued++;
      for (const r of reasons) queue.set(r, (queue.get(r) ?? 0) + 1);
    }
    if (needsAttention(scores)) backlog++;
    kept.push({ ...group, cls });
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const n = (v: number) => v.toLocaleString().padStart(9);
  const lines: string[] = [];
  const lane = (label: string, s: MatchStats) =>
    `  ${label.padEnd(12)} matched ${n(s.matched)}  ambiguous ${n(s.ambiguous)}  none ${n(s.none)}  (near-miss ${s.nearMiss.toLocaleString()})`;
  lines.push('');
  lines.push('══ matching ═══════════════════════════════════════════════════');
  lines.push(lane('3dhp→nhd', federal.stats));
  lines.push(lane('osm→nhd', osmNhd.stats));
  lines.push(lane('osm→3dhp', osmDhp.stats));
  lines.push('');
  lines.push('  matcher error rate — 3DHP and NHD are the same polygons here, so a');
  lines.push('  body one lane matched and the other missed is OUR error:');
  lines.push(`    matched NHD only   ${n(onlyNhd)}`);
  lines.push(`    matched 3DHP only  ${n(onlyDhp)}`);
  lines.push(
    `    disagreement rate  ${(((onlyNhd + onlyDhp) / Math.max(1, nhdHits.size + dhpHits.size)) * 100).toFixed(2)}%`,
  );
  lines.push('');
  lines.push('══ merged ═════════════════════════════════════════════════════');
  lines.push(`  groups            ${n(merged.length + refusedOutright.count)}`);
  lines.push(
    `  refused outright  ${n(refusedOutright.count)}  (every catalogue said drop — ocean, river, canal, sewage)`,
  );
  lines.push(`  kept after filter ${n(kept.length)}`);
  lines.push('  dropped by the post-merge filter:');
  for (const [r, c] of [...dropped.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`    ${n(c)}  ${r}`);
  }
  const byClass = new Map<string, number>();
  for (const k of kept) byClass.set(k.cls, (byClass.get(k.cls) ?? 0) + 1);
  lines.push('  by class:');
  for (const [c, v] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`    ${n(v)}  ${c}`);
  }
  const bySrc = new Map<string, number>();
  for (const k of kept) bySrc.set(k.geometrySource, (bySrc.get(k.geometrySource) ?? 0) + 1);
  lines.push('  geometry source:');
  for (const [c, v] of [...bySrc.entries()].sort((a, b) => b[1] - a[1]))
    lines.push(`    ${n(v)}  ${c}`);
  const sizes = new Map<number, number>();
  for (const k of kept) sizes.set(k.members.length, (sizes.get(k.members.length) ?? 0) + 1);
  lines.push('  sources per body:');
  for (const [c, v] of [...sizes.entries()].sort()) lines.push(`    ${n(v)}  ${c} source(s)`);
  lines.push('');
  lines.push('══ confidence ═════════════════════════════════════════════════');
  for (const k of ['cls', 'name', 'polygon'] as const) {
    lines.push(
      `  ${k.padEnd(8)} ${['high', 'medium', 'low', 'none'].map((l) => `${l} ${String(conf[k].get(l) ?? 0).padStart(6)}`).join('  ')}`,
    );
  }
  lines.push('');
  lines.push(
    `  review queue ${n(queued)}   ${[...queue].map(([k, v]) => `${k}=${v}`).join(' · ')}`,
  );
  lines.push(`  backlog      ${n(backlog)}`);
  process.stdout.write(`${lines.join('\n')}\n`);

  writeFileSync(
    join(SCRATCH, 'master.ndjson'),
    `${kept
      .map((k) =>
        JSON.stringify({
          key: k.key,
          name: k.name,
          cls: k.cls,
          acres: Math.round(k.areaSqM / 4046.8564224),
          geometrySource: k.geometrySource,
          sources: k.members.map((m) => `${m.source}:${m.id}`),
        }),
      )
      .join('\n')}\n`,
  );
  log(`master list → ${join(SCRATCH, 'master.ndjson')}`);
}

/** Does `outer` fully contain `inner`? A cheap prefilter before the containment test. */
function covers(outer: BBox, inner: BBox): boolean {
  return (
    outer.minLat <= inner.minLat &&
    outer.minLng <= inner.minLng &&
    outer.maxLat >= inner.maxLat &&
    outer.maxLng >= inner.maxLng
  );
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
