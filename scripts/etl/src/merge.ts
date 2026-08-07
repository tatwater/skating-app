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
import { createHash } from 'node:crypto';
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
import { polygonBBox } from '@skating/core';
import {
  convexRun,
  DropLedger,
  expectAcceptance,
  formatLedger,
  RunLogger,
  resolveDeployment,
} from '@skating/run-log';
import type { MultiPolygon, Polygon } from 'geojson';
import { nhdExtractArgs, osmExportArgs, osmFilterArgs, threeDhpExtractArgs } from './extract';
// **`./gnisSource`, never `./gnisArchive`.** That module runs its `main()` at import, so importing a
// constant from it re-ran the entire five-state GNIS download as a side effect of starting a merge —
// six curls and six unzips before a single lake was read. Same trap `admin-areas/tiger.ts` was split
// out to escape, one package over.
import {
  GNIS_STATE_CODES,
  GNIS_WATER_CLASSES,
  gnisColumnIndexes,
  gnisTextPath,
  isNullIsland,
} from './gnisSource';
import { buildMasterList, emitCanonicalBodies, type LaneStats } from './masterList';
import {
  type Boundary,
  CELL_DEG,
  cellsFor,
  type Feature,
  type GnisPoint,
  LaneLedger,
  parseLine,
  parseNhdFeature,
  parseOsmFeature,
  parseThreeDhpFeature,
  type RawNhdFeature,
  type RawOsmFeature,
  type RawThreeDhpFeature,
  SQ_M_PER_ACRE,
} from './mergeRules';
import { NHD_ID_CENSUS, NHD_SOURCES, nhdArchiveKey, normalizeGnisId } from './nhdArchive';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(HERE, '..', '.scratch', 'merge');
const CLASSIFY_SCRATCH = join(HERE, '..', '.scratch', 'classify');
const OSM_DIR = join(HERE, '..', '.raw');
const NHD_DIR = join(HERE, '..', '.raw-nhd');
const THREE_DHP_DIR = join(HERE, '..', '.raw-3dhp', 'waterbody');

const OSM_STATES = ['me', 'nh', 'vt', 'ma', 'ny'] as const;
const RECORD_SEPARATOR = String.fromCharCode(0x1e);

/**
 * The downstate mask, produced by `@skating/admin-areas build-region` from the same TIGER counties
 * the basemap's mask is cut from — so the line on the map and the line in the corpus cannot drift.
 */
const DOWNSTATE_FILE = join(HERE, '..', '..', 'basemap', '.scratch', 'downstate-ny.geojson');

/**
 * How well-formed `permanent_identifier` has to be before the pass refuses to continue.
 *
 * `NHD_ID_CENSUS` says the archive is **100% accepted** across all five states (44,862 numeric +
 * 8,268 GUID of 53,130, zero malformed), so anything below this is the source having changed shape
 * or the rule having been narrowed — both worth stopping for, and neither worth discovering three
 * passes downstream. Set just under 1 rather than at it so a handful of new rows cannot fail a
 * campaign, which is the failure mode that trains people to remove the floor.
 */
const NHD_ID_ACCEPTANCE_FLOOR = 0.99;

function log(message: string): void {
  process.stderr.write(`[merge] ${message}\n`);
}

/** Set once `main` has opened its run row, so the top-level catch can close it as failed. */
let activeLogger: RunLogger | undefined;

// ─────────────────────────────────────────────────────────────────────────────
// Sources
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read an NDJSON / GeoJSONSeq file a line at a time.
 *
 * **Streamed, not slurped.** The NHD and 3DHP lanes used to do
 * `readFileSync(file, 'utf8').split('\n')` on files of several hundred megabytes, materialising the
 * whole thing as one string and then again as an array of them — which is the same shape of problem
 * that already forces `NODE_OPTIONS=--max-old-space-size=8192` on the per-state transform. The OSM
 * lane always streamed; now all three do.
 *
 * Strips `osmium`'s RFC 7464 record separator, which only its output carries and which is harmless
 * to look for everywhere.
 */
async function* readLines(file: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const raw of rl) {
    const t = raw.trim();
    const line = t.startsWith(RECORD_SEPARATOR) ? t.slice(1) : t;
    if (line.length > 0) yield line;
  }
}

async function loadOsm(refresh: boolean, ledger: LaneLedger): Promise<Feature[]> {
  const out: Feature[] = [];
  const seen = new Set<string>();
  for (const state of OSM_STATES) {
    const file = join(CLASSIFY_SCRATCH, `osm-${state}.geojsonseq`);
    if (!existsSync(file) || refresh) extractOsm(state, file);
    for await (const line of readLines(file)) {
      const parsed = parseLine<RawOsmFeature>(line);
      // Every exit is counted. `parseLine` failing used to be `catch { continue }` — invisible, and
      // exactly how a truncated extract would report as a region with fewer lakes.
      const feature = parsed.ok
        ? ledger.record(parseOsmFeature(parsed.value, seen))
        : ledger.record(parsed);
      if (feature) out.push(feature);
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
  // The argv lives in `./extract` so the dry run, the merge and the canonical loader cannot drift
  // apart on which tags an extract keeps — a narrower filter here would not error, it would just
  // produce fewer lakes.
  const a = spawnSync('osmium', osmFilterArgs(join(dir, filename), filtered), { encoding: 'utf8' });
  if (a.status !== 0) throw new Error(`${state}: osmium tags-filter exited ${a.status}`);
  const b = spawnSync('osmium', osmExportArgs(filtered, out), { encoding: 'utf8' });
  if (b.status !== 0) throw new Error(`${state}: osmium export exited ${b.status}`);
}

/**
 * NHD, **at the one-acre floor**.
 *
 * The standalone reconciler exported at five acres, so every corpus body between one and five acres
 * was scored against an empty candidate set — 2,060 of them, measured, indistinguishable in the
 * output from a lake NHD has never heard of.
 */
async function loadNhd(refresh: boolean, ledger: LaneLedger, ids: DropLedger): Promise<Feature[]> {
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
        nhdExtractArgs(`/vsizip/${join(NHD_DIR, key, filename)}`, geojson),
        { encoding: 'utf8' },
      );
      if (res.status !== 0) throw new Error(`${key}: ogr2ogr exited ${res.status}`);
    }
    for await (const line of readLines(geojson)) {
      const parsed = parseLine<RawNhdFeature>(line);
      const feature = parsed.ok
        ? // The id normalizer gets its own `DropLedger` so `expectAcceptance` can assert it against
          // `NHD_ID_CENSUS` — that is a claim about the *rule*, and a different question from where
          // the rows went, which is what the `LaneLedger` answers.
          ledger.record(
            parseNhdFeature(parsed.value, seen, (raw, outcome) => ids.record(outcome, raw)),
          )
        : ledger.record(parsed);
      if (feature) out.push(feature);
    }
  }
  return out;
}

async function loadThreeDhp(refresh: boolean, ledger: LaneLedger): Promise<Feature[]> {
  const { filename } = JSON.parse(readFileSync(join(THREE_DHP_DIR, 'manifest.json'), 'utf8')) as {
    filename: string;
  };
  const geojson = join(SCRATCH, '3dhp.geojsonl');
  if (!existsSync(geojson) || refresh) {
    rmSync(geojson, { force: true });
    log('3dhp: extracting polygons at the 1-acre floor…');
    const res = spawnSync('ogr2ogr', threeDhpExtractArgs(join(THREE_DHP_DIR, filename), geojson), {
      encoding: 'utf8',
    });
    if (res.status !== 0) throw new Error(`3dhp: ogr2ogr exited ${res.status}`);
  }
  const out: Feature[] = [];
  const seen = new Set<string>();
  for await (const line of readLines(geojson)) {
    const parsed = parseLine<RawThreeDhpFeature>(line);
    const feature = parsed.ok
      ? ledger.record(parseThreeDhpFeature(parsed.value, seen))
      : ledger.record(parsed);
    if (feature) out.push(feature);
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
    // **D105's other half.** The lane was specified to settle a GNIS id where the catalogues
    // disagree, and read only the name — so the gazetteer could not resolve the one identifier it is
    // the authority for. The id is optional: a missing id costs a bridge, a missing coordinate costs
    // the whole lane, and only the latter is worth refusing to run over.
    const col = gnisColumnIndexes(header);
    if (col === null) {
      throw new Error(`${code}: unexpected GNIS header — ${header.slice(0, 6).join('|')}`);
    }
    if (col.id === undefined) {
      log(`  ⚠ ${code}: no feature_id column — the GNIS id bridge will be empty`);
    }
    for (const line of lines.slice(1)) {
      if (line.trim().length === 0) continue;
      const cells = line.split('|');
      const featureClass = cells[col.class] ?? '';
      if (!GNIS_WATER_CLASSES.has(featureClass)) continue;
      const lat = Number(cells[col.lat]);
      const lng = Number(cells[col.lng]);
      // `0,0` is GNIS's "no coordinate" and it is a real place — see `isNullIsland`.
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || isNullIsland(lat, lng)) continue;
      const cell = `${Math.floor(lng / CELL_DEG)}:${Math.floor(lat / CELL_DEG)}`;
      const bucket = grid.get(cell);
      // Normalised the same way every other lane's is, because NHD zero-pads this id to a string
      // and 3DHP stores it as a bare int — joining them raw over Maine matched 0 of 3,031.
      const rawId = col.id === undefined ? undefined : cells[col.id];
      const featureId = normalizeGnisId(rawId);
      const point = {
        lng,
        lat,
        name: cells[col.name] ?? '',
        featureClass,
        featureId: featureId.ok ? featureId.value : undefined,
      };
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
 * Where the region mask comes from — **`build-region`'s local file first** (N7 second audit).
 *
 * The mask decides tens of thousands of exclusions and used to have **no producer at all**: the only
 * instruction for building it was a sentence inside this file's own error message telling the
 * operator to hand-page `adminAreas:listBoundariesForClip` into a scratch file. That route also cost
 * fidelity twice over — TIGER outlines are simplified on the way *into* Convex to fit the
 * 8,192-element array cap (Maine's is 18,932 vertices raw), so the corpus was being clipped against a
 * coarsened copy of a boundary we already hold verbatim on disk.
 *
 * `pnpm --filter @skating/admin-areas build-region` now writes `boundaries.ndjson` beside the two
 * masks it already produced, from the same TIGER archive, at full fidelity. The Convex export stays
 * as a fallback so an existing scratch file keeps working, and it is the *second* choice on purpose.
 */
function boundariesPath(): string {
  const built = join(dirname(DOWNSTATE_FILE), 'boundaries.ndjson');
  return existsSync(built) ? built : join(SCRATCH, 'boundaries.ndjson');
}

/** The five states, as states and counties — the mask the merged corpus is clipped to. */
function loadBoundaries(): (Boundary & { name: string; level: string })[] {
  const file = boundariesPath();
  if (!existsSync(file)) {
    throw new Error(
      `missing ${file} — build it first:\n` +
        '  pnpm --filter @skating/admin-areas build-region\n' +
        '(legacy fallback: convex run adminAreas:listBoundariesForClip, paged into ' +
        '.scratch/merge/boundaries.ndjson)',
    );
  }
  const out: (Boundary & { name: string; level: string })[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    out.push(JSON.parse(t) as Boundary & { name: string; level: string });
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
  const file = DOWNSTATE_FILE;
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

async function main(): Promise<void> {
  const refresh = process.argv.includes('--refresh');
  const campaignId = process.argv
    .find((a) => a.startsWith('--campaign='))
    ?.slice('--campaign='.length);
  const runLogEnabled = !process.argv.includes('--no-run-log');
  mkdirSync(SCRATCH, { recursive: true });
  mkdirSync(CLASSIFY_SCRATCH, { recursive: true });

  // **D99: every pass in the campaign is run-logged.** This one was not, and it is the pass that
  // decides all 27,074 rows — `reconcileNhd` and `auditArchives` both carried a logger while the
  // merge, which makes every admission decision in the phase, reported to a terminal that scrolls.
  //
  // It writes nothing else to Convex, so the row is the only trace it leaves there; `--no-run-log`
  // opts out for a local experiment, and a logger whose `start` fails degrades every later call to a
  // no-op rather than taking the run down with it.
  const logger = new RunLogger({
    kind: 'corpus_merge',
    label: 'N7 master list — three catalogues, one filter',
    campaignId,
    target: resolveDeployment(),
    call: runLogEnabled ? convexRun : () => undefined as never,
    notes: [
      'Read-only against Convex: this pass writes only .scratch/merge/.',
      `sources: OSM ${OSM_STATES.join('/')} · NHD ${NHD_SOURCES.length} states · 3DHP clip · GNIS`,
    ],
  });
  if (runLogEnabled) logger.start();
  activeLogger = logger;

  // Every lane keeps its own ledger, so "where did the rows go" is answerable per catalogue rather
  // than as one number that could mean anything. See `LaneLedger`.
  const lanes = {
    osm: new LaneLedger(),
    nhd: new LaneLedger(),
    '3dhp': new LaneLedger(),
  } as const;
  const nhdIds = new DropLedger('nhdId');

  log('loading sources at the 1-acre floor…');
  const osm = await loadOsm(refresh, lanes.osm);
  log(`  osm   ${osm.length.toLocaleString()}`);
  const nhd = await loadNhd(refresh, lanes.nhd, nhdIds);
  log(`  nhd   ${nhd.length.toLocaleString()}`);
  const dhp = await loadThreeDhp(refresh, lanes['3dhp']);
  log(`  3dhp  ${dhp.length.toLocaleString()}`);

  // ── The first balance: every raw record is accounted for ──────────────────
  //
  // **This is what the audit found missing.** The report's headline claim has always been that its
  // numbers balance — and they balanced only from the grouping stage onward. Upstream, the one-acre
  // floor (the largest single filter in the pipeline) and four other exits emitted nothing at all, so
  // "we read 400,000 records and grouped 264,000" had no explanation for the difference.
  for (const [label, ledger] of Object.entries(lanes)) {
    if (!ledger.balances()) {
      throw new Error(`${label}: lane ledger does not balance — a drop path is uncounted`);
    }
    log(`  ${label}: ${ledger.kept.toLocaleString()} kept of ${ledger.seen.toLocaleString()}`);
    for (const e of ledger.entries()) {
      log(`      ${e.count.toLocaleString().padStart(9)} ${e.reason}  e.g. ${e.samples[0] ?? ''}`);
    }
  }
  log(`  ${formatLedger(nhdIds.report())}`);
  // The census this rule was derived from, printed beside what the archive actually produced. A
  // drift is either a re-published source or a narrowed rule, and both are worth seeing without
  // going to look — `auditArchives` asserts it, this reports it.
  log(
    `      census expected ${NHD_ID_CENSUS.postFloorRows.toLocaleString()} post-floor rows, ` +
      `${NHD_ID_CENSUS.distinct.toLocaleString()} distinct`,
  );
  // The id rule's own floor, asserted against the census stored beside it. `absent` and `sentinel`
  // are properties of the data and are excluded by default; only `malformed` indicts the rule.
  expectAcceptance(nhdIds.report(), NHD_ID_ACCEPTANCE_FLOOR);

  // ── The decision ──────────────────────────────────────────────────────────
  //
  // Every rule from here to the master list now lives in `masterList.ts`, which takes data and
  // returns data. What is left in this file is the archives, the artifacts and the report — see that
  // module for why the extraction had to go one layer deeper than `mergeRules.ts` did.
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
  // A second, coarser index over STATE rows only. The mask is built from counties and towns because
  // those are the finer outlines, but a county row does not carry its state's code — so `states` has
  // to be answered against a different set. See `statesFor`.
  const stateGrid = new Map<string, (Boundary & { name: string })[]>();
  const stateRows = boundaries.filter((x) => x.level === 'state');
  for (const b of stateRows) {
    for (const cell of cellsFor(b.bbox)) {
      const bucket = stateGrid.get(cell);
      if (bucket) bucket.push(b);
      else stateGrid.set(cell, [b]);
    }
  }
  const stateNames = [...new Set(stateRows.map((x) => x.name))];
  log(`  ${stateNames.length} state outlines for the states field`);
  // **Five, or the `states` field is quietly wrong for a whole state.** `adminAreas` carried three
  // state rows for a year and nothing said so (the OSM relations do not close from a per-state
  // extract), which is the entire reason the TIGER lane exists. A mask short of a state still clips
  // fine — the counties cover it — so the only symptom would be tens of thousands of bodies with no
  // `states` value and an empty regional filter in the app.
  if (stateNames.length !== OSM_STATES.length) {
    throw new Error(
      `expected ${OSM_STATES.length} state outlines in the mask, found ${stateNames.length}: ` +
        `${stateNames.join(', ') || '(none)'} — re-export boundaries.ndjson`,
    );
  }
  const downstate = loadDownstate();
  log(`  ${downstate.length} downstate NY counties, refused`);

  const master = buildMasterList({
    osm,
    nhd,
    dhp,
    gnisGrid,
    boundaryGrid,
    downstate,
    log,
  });
  const { bodies: kept, subAreas, dropped, stats } = master;

  // ── The emit stage — the artifact the loader actually consumes (N7 step 5) ────────────────
  const emit = emitCanonicalBodies(kept, stateGrid);
  const failedCount = [...emit.failures.values()].reduce((a, b) => a + b, 0);
  if (emit.emitted.length + failedCount !== kept.length) {
    throw new Error(
      `emit does not balance: ${emit.emitted.length} + ${failedCount} != ${kept.length} kept`,
    );
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const n = (v: number) => v.toLocaleString().padStart(9);
  const lines: string[] = [];
  const lane = (label: string, s: LaneStats) =>
    `  ${label.padEnd(12)} matched ${n(s.matched)}  ambiguous ${n(s.ambiguous)}  none ${n(s.none)}  (near-miss ${s.nearMiss.toLocaleString()})`;
  lines.push('');
  lines.push('══ matching ═══════════════════════════════════════════════════');
  for (const l of stats.lanes) lines.push(lane(l.label, l.stats));
  lines.push(
    `  ${'osm→nhd by NAME'.padEnd(12)} matched ${n(stats.nameLane.pairs)}  ` +
      `(pairs the area-ratio ceiling refused; overlap still required)`,
  );
  for (const sample of stats.nameLane.ambiguous.slice(0, 5)) {
    lines.push(`      ambiguous by name, left unmatched: ${sample}`);
  }
  lines.push('');
  lines.push('  matcher error rate — 3DHP and NHD are the same polygons here, so a');
  lines.push('  body one lane matched and the other missed is OUR error:');
  lines.push(`    matched NHD only   ${n(stats.matcher.onlyNhd)}`);
  lines.push(`    matched 3DHP only  ${n(stats.matcher.onlyDhp)}`);
  lines.push(
    `    disagreement rate  ${(((stats.matcher.onlyNhd + stats.matcher.onlyDhp) / Math.max(1, stats.matcher.nhdHits + stats.matcher.dhpHits)) * 100).toFixed(2)}%`,
  );
  for (const { label, stats: s } of stats.lanes) {
    if (s.ambiguousIds.length === 0) continue;
    lines.push(`  ${label} ambiguous — geometry could not separate these; each stays a SINGLETON,`);
    lines.push('  i.e. a possible duplicate in the corpus that nothing downstream can detect:');
    for (const sample of s.ambiguousIds) lines.push(`    ${sample}`);
  }
  lines.push('');
  lines.push('══ intake ═════════════════════════════════════════════════════');
  lines.push('  every raw record, accounted for (the balance the old report did not have):');
  for (const [label, ledger] of Object.entries(lanes)) {
    lines.push(`    ${label.padEnd(6)} seen ${n(ledger.seen)}  kept ${n(ledger.kept)}`);
    for (const e of ledger.entries()) {
      lines.push(`      ${n(e.count)}  ${e.reason.padEnd(18)} e.g. ${e.samples[0] ?? ''}`);
    }
  }
  lines.push(`    ${formatLedger(nhdIds.report())}`);
  lines.push('');
  lines.push('══ merged ═════════════════════════════════════════════════════');
  lines.push(`  groups            ${n(stats.groups)}`);
  for (const [reason, count] of [...stats.refused.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  refused ${reason.padEnd(21)} ${n(count)}`);
    for (const sample of stats.refusedSamples.get(reason) ?? []) lines.push(`      ${sample}`);
  }
  lines.push(
    `  outside 5 states  ${n(stats.outOfRegion)}  (the geodatabases are not clipped to their states)`,
  );
  lines.push(
    `  NY below I-84     ${n(stats.belowI84)}  (in New York, outside the coverage we claim)`,
  );
  lines.push(
    `  sub-areas         ${n(stats.subAreas)}  (bays with a parent — an arm is not a lake)`,
  );
  lines.push(
    `  named by GNIS     ${n(stats.gnisNamed)}  of which ADMITTED by that name alone: ${stats.gnisRescued.toLocaleString()}`,
  );
  lines.push(`  kept after filter ${n(kept.length)}`);
  lines.push('  dropped by the post-merge filter:');
  for (const [r, c] of [...stats.droppedByFloor.entries()].sort((a, b) => b[1] - a[1])) {
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
      `  ${k.padEnd(8)} ${['high', 'medium', 'low', 'none'].map((l) => `${l} ${String(stats.confidence[k].get(l) ?? 0).padStart(6)}`).join('  ')}`,
    );
  }
  lines.push('');
  lines.push(
    `  review queue ${n(stats.queued)}   ${[...stats.queue].map(([k, v]) => `${k}=${v}`).join(' · ')}`,
  );
  lines.push(`  backlog      ${n(stats.backlog)}`);
  lines.push(
    `  overlapping survivors ${n(stats.duplicatePairs)} pairs — flagged duplicate-candidate, never merged`,
  );
  lines.push(
    `  gazetteer ids  ${n(stats.gazetteerIdsAttached)}  attached BEFORE the lanes, which is what makes the`,
  );
  lines.push('    0.3 GNIS matching bar reachable at all. Zero here means it is dead again.');
  lines.push(
    `  great-lake arms ${n(stats.greatLakeArms)}  bays kept as bodies because their parent is Erie or Ontario,`,
  );
  lines.push('    which we render from the basemap and deliberately do not store as bodies.');
  lines.push(
    `  settled wetland ${n(stats.settledWetland)}  a federal open-water class beating an OSM wetland tag —`,
  );
  lines.push(
    '    resolved, not queued (the 123-body rescue). Watch this number move between runs.',
  );
  lines.push(
    `  class dissent ${n(stats.classDissent)}  one catalogue refused this outright, another classed it;`,
  );
  lines.push(
    '    a real class beats a drop (the 123-body rescue), so these resolve SILENTLY today:',
  );
  for (const sample of stats.classDissentSamples) lines.push(`      ${sample}`);
  process.stdout.write(`${lines.join('\n')}\n`);

  // ── The artifacts ─────────────────────────────────────────────────────────
  writeNdjson(join(SCRATCH, 'bodies.ndjson'), emit.emitted);
  log(
    `canonical bodies → ${join(SCRATCH, 'bodies.ndjson')} (${emit.emitted.length.toLocaleString()})`,
  );
  for (const [reason, count] of [...emit.failures].sort((a, b) => b[1] - a[1])) {
    log(`  ! ${count} body/bodies could not be emitted: ${reason}`);
  }
  if (emit.failureKeys.length > 0) log(`  ! e.g. ${emit.failureKeys.join(', ')}`);

  writeNdjson(join(SCRATCH, 'sub-areas.ndjson'), subAreas);
  log(`sub-areas → ${join(SCRATCH, 'sub-areas.ndjson')} (${subAreas.length.toLocaleString()})`);

  // **Every group that did not become a body, by name** (N7 second audit). The counts always
  // balanced; the *identities* were never written down, so "what happened to Lake X" had no answer
  // and two runs could not be diffed. The largest bucket alone — the post-merge floor — is ~100,000
  // groups, and a rule change that silently moved a thousand of them looked like a slightly
  // different number in a run row.
  writeNdjson(join(SCRATCH, 'dropped.ndjson'), dropped);
  log(`dropped → ${join(SCRATCH, 'dropped.ndjson')} (${dropped.length.toLocaleString()})`);

  // `master.ndjson` is the REPORT half: no geometry, one line per body, readable by eye.
  writeNdjson(
    join(SCRATCH, 'master.ndjson'),
    kept.map((k) => ({
      key: k.key,
      name: k.name,
      cls: k.cls,
      acres: Math.round(k.areaSqM / SQ_M_PER_ACRE),
      geometrySource: k.geometrySource,
      sources: k.members.map((m) => `${m.source}:${m.id}`),
      absorbed: k.absorbedIds,
      confidence: k.confidence,
      reviewReasons: k.reviewReasons,
      duplicateOf: k.duplicateOf,
      inRegionFraction: Number(k.inRegionFraction.toFixed(3)),
      emitted: emit.emittedKeys.has(k.key),
    })),
  );
  log(`master list → ${join(SCRATCH, 'master.ndjson')}`);

  // **The candidate pool for D92's per-lake override**, which until now had no producer at all: the
  // bake-off wrote per-lake scores to a scratch file nothing read, and `GEOMETRY_OVERRIDES` was one
  // hand-typed line. A body whose chosen outline disagrees materially with another catalogue's is
  // exactly the Beau Lake shape — OSM merged it at 2,457 acres against NHD's 1,876.6 — and the
  // polygon confidence score already knows, it just summons nobody (D110: no human can adjudicate
  // "these outlines differ by 20%" by eye, but they CAN check a lake against its published acreage).
  const geometryReview = kept
    .filter((k) => k.confidence.polygon === 'low' && k.members.length > 1)
    .map((k) => ({
      key: k.key,
      name: k.name,
      geometrySource: k.geometrySource,
      acres: Math.round(k.areaSqM / SQ_M_PER_ACRE),
      claims: k.members.map((m) => ({
        source: m.source,
        id: m.id,
        acres: Math.round(m.areaSqM / SQ_M_PER_ACRE),
      })),
      spread: Number(
        (
          Math.max(...k.members.map((m) => m.areaSqM)) /
          Math.max(Math.min(...k.members.map((m) => m.areaSqM)), 1)
        ).toFixed(2),
      ),
    }))
    .sort((a, b) => b.spread - a.spread);
  writeNdjson(join(SCRATCH, 'geometry-review.ndjson'), geometryReview);
  log(
    `geometry review → ${join(SCRATCH, 'geometry-review.ndjson')} (${geometryReview.length.toLocaleString()})`,
  );

  // ── The manifest: what produced this corpus ───────────────────────────────
  const manifestPath = join(SCRATCH, 'merge-manifest.json');
  const previous = readManifest(manifestPath);
  const outputs = {
    groups: stats.groups,
    kept: kept.length,
    emitted: emit.emitted.length,
    emitFailures: failedCount,
    subAreas: subAreas.length,
    dropped: dropped.length,
    outOfRegion: stats.outOfRegion,
    belowI84: stats.belowI84,
    saltWater: stats.saltWater,
    reviewQueue: stats.queued,
    duplicatePairs: stats.duplicatePairs,
    classDissent: stats.classDissent,
    settledWetland: stats.settledWetland,
    greatLakeArms: stats.greatLakeArms,
    gazetteerIdsAttached: stats.gazetteerIdsAttached,
  };
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        producedAt: new Date().toISOString(),
        campaignId,
        inputs: {
          osm: OSM_STATES.map((s) => manifestOf(join(OSM_DIR, s, 'manifest.json'))),
          nhd: NHD_SOURCES.map((s) => manifestOf(join(NHD_DIR, nhdArchiveKey(s), 'manifest.json'))),
          threeDhp: manifestOf(join(THREE_DHP_DIR, 'manifest.json')),
          gnis: manifestOf(join(HERE, '..', '.raw-gnis', 'manifest.json')),
          boundaries: fingerprint(boundariesPath()),
          downstate: fingerprint(DOWNSTATE_FILE),
        },
        outputs,
      },
      null,
      2,
    )}\n`,
  );
  log(`manifest → ${manifestPath}`);

  // ── This run against the last one ─────────────────────────────────────────
  //
  // A campaign is re-run whenever a rule moves, and until now nothing compared the two: a change
  // that removed three thousand lakes and a change that removed three looked identical in the
  // output. The previous manifest is already on disk; reading it costs nothing and turns every
  // re-run into a diff.
  if (previous) {
    const delta: string[] = [];
    for (const [key, value] of Object.entries(outputs)) {
      const before = (previous.outputs as Record<string, number> | undefined)?.[key];
      if (typeof before !== 'number' || before === value) continue;
      const change = value - before;
      const pct = before === 0 ? '—' : `${((change / before) * 100).toFixed(1)}%`;
      delta.push(
        `    ${key.padEnd(16)} ${before.toLocaleString()} → ${value.toLocaleString()}  (${change > 0 ? '+' : ''}${change.toLocaleString()}, ${pct})`,
      );
    }
    process.stdout.write(
      delta.length > 0
        ? `\n══ against the previous run (${String(previous.producedAt ?? 'unknown')}) ═══\n${delta.join('\n')}\n`
        : `\n  identical to the previous run (${String(previous.producedAt ?? 'unknown')})\n`,
    );
  }

  for (const [name, value] of Object.entries(outputs)) logger.count(name, value);
  logger.count('gnisNamed', stats.gnisNamed);
  logger.count('gnisRescued', stats.gnisRescued);
  logger.count('backlog', stats.backlog);
  logger.count('nameLaneMatches', stats.nameLane.pairs);
  for (const [reason, count] of stats.refused) logger.count(`refused.${reason}`, count);
  for (const [reason, count] of stats.droppedByFloor) logger.count(`floor.${reason}`, count);
  for (const [reason, count] of stats.queue) logger.count(`queue.${reason}`, count);
  for (const [label, ledger] of Object.entries(lanes)) {
    for (const c of ledger.counts_(label)) logger.count(c.name, c.value);
  }
  for (const c of nhdIds.counts_()) logger.count(c.name, c.value);
  logger.succeed([
    `master list ${kept.length} bodies; ${emit.emitted.length} loadable; ${subAreas.length} sub-areas`,
  ]);
}

/** One JSON object per line, with a trailing newline — the shape every artifact here uses. */
function writeNdjson(path: string, rows: readonly unknown[]): void {
  writeFileSync(
    path,
    rows.length === 0 ? '' : `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
  );
}

/** The previous run's manifest, for the delta. A missing or unreadable one is not an error. */
function readManifest(path: string): { producedAt?: unknown; outputs?: unknown } | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { producedAt?: unknown; outputs?: unknown };
  } catch {
    return undefined;
  }
}

/** A source archive's manifest, or a marker saying it was missing — never a silent absence. */
function manifestOf(path: string): Record<string, unknown> {
  if (!existsSync(path)) return { path, missing: true };
  try {
    const m = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    // Only the provenance fields; a manifest can be large and this is a record, not a copy.
    const { url, filename, bytes, sha256, lastModified, fetchedAt, vintage } = m;
    return { path, url, filename, bytes, sha256, lastModified, fetchedAt, vintage };
  } catch {
    return { path, unreadable: true };
  }
}

/**
 * Size + digest of an input that has no manifest of its own — the two region masks.
 *
 * They are derived artifacts rather than archives, so there is nothing upstream to checksum against.
 * Recording what we actually read at least makes "was this the same mask?" answerable, which is the
 * question a surprising `outOfRegion` count raises.
 */
function fingerprint(path: string): Record<string, unknown> {
  if (!existsSync(path)) return { path, missing: true };
  const bytes = readFileSync(path);
  return {
    path,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  // **The run row must not be left `running`.** D99 records that the abandoned N6c campaign left
  // three rows in that state, which is the signature of a pass that died before it could say so —
  // and a balance assertion throwing is exactly the case where the row is worth having.
  activeLogger?.failed(error);
  process.exitCode = 1;
});
