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
  pointInPolygon,
  polygonBBox,
  RECONCILE_MIN_IOU,
  type ReconcileCandidate,
  reconcileOne,
  scoreBody,
  surfaceAreaSqM,
  type WaterBodyClass,
} from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import { GNIS_STATE_CODES, GNIS_WATER_CLASSES, gnisTextPath, isNullIsland } from './gnisArchive';
import {
  type Boundary,
  CELL_DEG,
  cellsFor,
  dropReason,
  type Feature,
  type GnisPoint,
  gnisNameFor,
  hasBayParent,
  inDownstate,
  index,
  inRegion,
  type Merged,
  mergeGroupWithReason,
  polygonClaims,
  SQ_M_PER_ACRE,
  Union,
} from './mergeRules';
import { NHD_SOURCES, nhdArchiveKey, normalizeGnisId, normalizeNhdId } from './nhdArchive';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(HERE, '..', '.scratch', 'merge');
const CLASSIFY_SCRATCH = join(HERE, '..', '.scratch', 'classify');
const OSM_DIR = join(HERE, '..', '.raw');
const NHD_DIR = join(HERE, '..', '.raw-nhd');
const THREE_DHP_DIR = join(HERE, '..', '.raw-3dhp', 'waterbody');

const OSM_STATES = ['me', 'nh', 'vt', 'ma', 'ny'] as const;
const RECORD_SEPARATOR = String.fromCharCode(0x1e);

function log(message: string): void {
  process.stderr.write(`[merge] ${message}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sources
// ─────────────────────────────────────────────────────────────────────────────

/** Flatten a verdict onto the fields a `Feature` carries. */
function verdictFields(v: { cls: WaterBodyClass | null; token: string }) {
  return { cls: v.cls, token: v.token };
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
        ...verdictFields(classifyWaterBody({ name, claim: classifyOsmTags(p) })),
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
        ...verdictFields(
          classifyWaterBody({
            name,
            claim: classifyNhd(Number(f.properties.ftype), Number(f.properties.fcode)),
          }),
        ),
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
      ...verdictFields(
        classifyWaterBody({ name, claim: classifyThreeDhp(Number(f.properties.featuretype)) }),
      ),
      gnisId: gnis.ok ? gnis.value : undefined,
      polygon: f.geometry,
      bbox: polygonBBox(f.geometry),
      areaSqM,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// GNIS — the gazetteer, consulted BEFORE the floor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Domestic Names gazetteer, per state — **the only lane whose output can change what is
 * admitted, not just what is displayed.**
 *
 * A name here is not cosmetic. D96 admits a *named* wetland at five acres and refuses an unnamed one
 * under fifty, so a GNIS name is the difference between Cicero Swamp existing and not. That is why
 * this is read before `belongsInCorpus` rather than stamped on afterwards — the same ordering
 * mistake, one level deeper, is what cost 123 LakePond bodies when each source filtered itself.
 *
 * Pipe-delimited text with a BOM, 2.77 MB for five states, public domain.
 */
function loadGnis(): Map<string, GnisPoint[]> {
  const grid = new Map<string, GnisPoint[]>();
  let n = 0;
  for (const code of GNIS_STATE_CODES) {
    const file = gnisTextPath(code);
    if (!existsSync(file)) {
      throw new Error(`missing ${file} — run \`pnpm --filter @skating/etl archive-gnis\` first`);
    }
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const lines = text.split('\n');
    const header = (lines[0] ?? '').split('|');
    const ix = (name: string) => header.indexOf(name);
    const [iName, iClass, iLat, iLng] = [
      ix('feature_name'),
      ix('feature_class'),
      ix('prim_lat_dec'),
      ix('prim_long_dec'),
    ];
    if (iName < 0 || iClass < 0 || iLat < 0 || iLng < 0) {
      throw new Error(`${code}: unexpected GNIS header — ${header.slice(0, 6).join('|')}`);
    }
    for (const line of lines.slice(1)) {
      if (line.trim().length === 0) continue;
      const cells = line.split('|');
      const featureClass = cells[iClass] ?? '';
      if (!GNIS_WATER_CLASSES.has(featureClass)) continue;
      const lat = Number(cells[iLat]);
      const lng = Number(cells[iLng]);
      // `0,0` is GNIS's "no coordinate" and it is a real place — see `isNullIsland`.
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || isNullIsland(lat, lng)) continue;
      const cell = `${Math.floor(lng / CELL_DEG)}:${Math.floor(lat / CELL_DEG)}`;
      const bucket = grid.get(cell);
      const point = { lng, lat, name: cells[iName] ?? '', featureClass };
      if (bucket) bucket.push(point);
      else grid.set(cell, [point]);
      n++;
    }
  }
  log(`  ${n.toLocaleString()} GNIS water features`);
  return grid;
}

// ─────────────────────────────────────────────────────────────────────────────
// The region mask
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five states, as counties and towns.
 *
 * Exported from `adminAreas` by `listBoundariesForClip` — see that function for why the mask is built
 * from the finer levels rather than from `state` rows, and for what an unclipped merge imports.
 */
function loadBoundaries(): Boundary[] {
  const file = join(SCRATCH, 'boundaries.ndjson');
  if (!existsSync(file)) {
    throw new Error(
      `missing ${file} — export it first:\n` +
        `  convex run adminAreas:listBoundariesForClip, paged into .scratch/merge/boundaries.ndjson`,
    );
  }
  const out: Boundary[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    const a = JSON.parse(t) as Boundary;
    out.push(a);
  }
  return out;
}

/**
 * New York south of I-84 — in the five states, and deliberately not in the corpus.
 *
 * The map draws downstate New York in full: it is one of our states, Poughkeepsie and Brooklyn are
 * real places, and a user driving north deserves to see where they are starting from. What we do
 * *not* do is claim to know anything about skating on the water down there (founder, 2026-08-05).
 * Coverage and rendering had always been the same question because the basemap was a rectangle that
 * cut them off together; giving the map a world made them two questions, and this is the second one.
 *
 * Generated by `pnpm --filter @skating/admin-areas build-region` — the same TIGER counties the map's
 * mask is cut from, so the line on the map and the line in the corpus cannot drift apart.
 */
function loadDownstate(): Boundary[] {
  const file = join(HERE, '..', '..', 'basemap', '.scratch', 'downstate-ny.geojson');
  if (!existsSync(file)) {
    throw new Error(
      `missing ${file} — generate it first:\n` +
        '  pnpm --filter @skating/admin-areas build-region',
    );
  }
  const fc = JSON.parse(readFileSync(file, 'utf8')) as {
    features: { geometry: Polygon | MultiPolygon }[];
  };
  return fc.features.map((f) => ({ polygon: f.geometry, bbox: polygonBBox(f.geometry) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Matching
// ─────────────────────────────────────────────────────────────────────────────

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
// The merged record
// ─────────────────────────────────────────────────────────────────────────────

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
  log('loading the GNIS gazetteer…');
  const gnisGrid = loadGnis();

  log('loading the five-state mask…');
  const boundaries = loadBoundaries();
  const boundaryGrid = new Map<string, Boundary[]>();
  for (const b of boundaries) {
    for (const cell of cellsFor(b.bbox)) {
      const bucket = boundaryGrid.get(cell);
      if (bucket) bucket.push(b);
      else boundaryGrid.set(cell, [b]);
    }
  }
  log(`  ${boundaries.length.toLocaleString()} boundary polygons`);
  const downstate = loadDownstate();
  log(`  ${downstate.length} downstate NY counties, refused`);

  // Two refusals, counted apart. `vetoed` is a rule firing correctly on the ocean; `no-class` is
  // every catalogue independently declining to call this water. Adding them together — as the first
  // version did — cannot tell "the veto is working" from "the classifier has a hole".
  const refused = { vetoed: 0, noClass: 0 };
  const outOfRegion = { count: 0 };
  const belowI84 = { count: 0 };
  const gnisNamed = { count: 0, rescued: 0 };
  const merged = [...groups.values()]
    .map((m) => {
      const { body, reason } = mergeGroupWithReason(m);
      if (reason === 'vetoed') refused.vetoed++;
      else if (reason !== undefined) refused.noClass++;
      return body;
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

  // The bay rule needs the whole merged set, so it runs here rather than in the classifier. Indexed
  // on the merged bodies themselves — the old version cast each one through `unknown` into a `Feature`
  // purely to reuse the index, which cost the type check without changing a single field it read.
  const bayGrid = index(merged.filter((m) => m.cls !== 'bay'));

  for (const group of merged) {
    let cls = group.cls;
    // A bay is an arm OF something. With no parent we cannot support the claim — Half Moon Cove is
    // 330 acres, named "Cove", and is a wetland. Demote and let a human look.
    const bayWithoutParent = cls === 'bay' && !hasBayParent(group, bayGrid);
    if (bayWithoutParent) cls = 'unclassified';

    // **The region clip, applied to the merged body rather than to a lane.** A body only NHD knows
    // about still has to be somewhere we cover; a body only OSM knows about already is, by
    // construction. Testing once, after merging, is the same discipline as the floor.
    if (!inRegion(group, boundaryGrid)) {
      outOfRegion.count++;
      continue;
    }

    // In one of our five states and still not ours — see `inDownstate`. Counted separately from
    // `outOfRegion` on purpose: one number is the geodatabases spilling over their state lines, the
    // other is a coverage decision, and totalling them would hide the second inside the first.
    if (inDownstate(group, downstate)) {
      belowI84.count++;
      continue;
    }

    // **GNIS runs BEFORE the floor, and that ordering is the whole point of the lane.** D96 admits a
    // *named* wetland at five acres and refuses an unnamed one under fifty, so a gazetteer name does
    // not merely relabel a body — it decides whether the body exists. Stamping it afterwards would
    // repeat, one level deeper, the mistake that cost 123 LakePond bodies.
    let name = group.name;
    let namedByGnis = false;
    if (name.length === 0) {
      const found = gnisNameFor(group, gnisGrid);
      if (found !== undefined && found.length > 0) {
        name = found;
        namedByGnis = true;
        gnisNamed.count++;
        // Would the floor have refused this body without the name it just gained?
        if (!belongsInCorpus({ name: '', surfaceAreaSqM: group.areaSqM, type: cls })) {
          gnisNamed.rescued++;
        }
      }
    }

    if (!belongsInCorpus({ name, surfaceAreaSqM: group.areaSqM, type: cls })) {
      // **`name`, not `group.name`.** The refusal was decided against the GNIS-augmented name, so
      // labelling it with the catalogue name reported a wetland the gazetteer HAD named as "unnamed"
      // — the one lane whose contribution this report exists to measure, described as absent.
      const reason = dropReason({ name, cls, areaSqM: group.areaSqM });
      dropped.set(reason, (dropped.get(reason) ?? 0) + 1);
      continue;
    }

    const scores = scoreBody({
      names: [
        ...group.members.filter((m) => m.name).map((m) => ({ source: m.source, value: m.name })),
        ...(namedByGnis ? [{ source: 'gnis' as ClaimSource, value: name }] : []),
      ],
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
    kept.push({ ...group, cls, name });
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
  lines.push(`  groups            ${n(merged.length + refused.vetoed + refused.noClass)}`);
  lines.push(
    `  vetoed as ocean   ${n(refused.vetoed)}  (a refusal no other catalogue may overrule)`,
  );
  lines.push(
    `  no class at all   ${n(refused.noClass)}  (every catalogue independently declined to call it water)`,
  );
  lines.push(
    `  outside 5 states  ${n(outOfRegion.count)}  (the geodatabases are not clipped to their states)`,
  );
  lines.push(
    `  NY below I-84     ${n(belowI84.count)}  (in New York, outside the coverage we claim)`,
  );
  lines.push(
    `  named by GNIS     ${n(gnisNamed.count)}  of which ADMITTED by that name alone: ${gnisNamed.rescued.toLocaleString()}`,
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
          acres: Math.round(k.areaSqM / SQ_M_PER_ACRE),
          geometrySource: k.geometrySource,
          sources: k.members.map((m) => `${m.source}:${m.id}`),
        }),
      )
      .join('\n')}\n`,
  );
  log(`master list → ${join(SCRATCH, 'master.ndjson')}`);
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
