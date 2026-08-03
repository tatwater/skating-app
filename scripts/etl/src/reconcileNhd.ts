/**
 * Reconcile the stored corpus against the NHD archive — campaign step 2 (N7, D93).
 *
 *   pnpm --filter @skating/etl reconcile --export     # corpus + NHD geometry → .scratch/ (once)
 *   pnpm --filter @skating/etl reconcile --match      # score + decide, offline (many times)
 *   pnpm --filter @skating/etl reconcile              # both
 *
 * ## Fetch once, derive many — the same split the archives use
 *
 * `--export` pages the corpus out of Convex and dumps NHD's post-floor polygons out of the five
 * geodatabases. `--match` reads only those files. That matters because the thresholds
 * (`RECONCILE_MIN_IOU` and friends) will want tuning against real distributions, and re-running
 * 21,665 × 40,928 candidate comparisons through Convex to try a different number would be absurd.
 *
 * **This writes nothing to Convex.** It produces a mapping and a ledger for review; a separate
 * loader applies it. Step 2 is explicitly safe against a live corpus, and a reconciliation that
 * writes as it goes cannot be reviewed before it has already happened.
 *
 * ## The blocking grid
 *
 * 21,665 bodies against 40,928 candidates is 887 million polygon pairs, which is not a computation.
 * NHD features are indexed into a 0.1° grid by bbox, so each body only scores the handful of
 * candidates that could possibly overlap it. `bboxIntersects` then rejects most of those before any
 * geodesic area is computed.
 */

import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  type BBox,
  findCollapsedDuplicates,
  polygonBBox,
  type ReconcileCandidate,
  reconcileOne,
} from '@skating/core';
import {
  convexRun,
  DropLedger,
  formatLedger,
  RunLogger,
  resolveDeployment,
} from '@skating/run-log';
import type { MultiPolygon, Polygon } from 'geojson';
import { NHD_SOURCES, nhdArchiveKey, normalizeGnisId, normalizeNhdId } from './nhdArchive';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(HERE, '..', '.scratch');
const NHD_DIR = join(HERE, '..', '.raw-nhd');
const CORPUS_FILE = join(SCRATCH, 'corpus.ndjson');
const NHD_FILE = join(SCRATCH, 'nhd-postfloor.ndjson');
const OUT_FILE = join(SCRATCH, 'reconcile.ndjson');

/** Grid cell size for the candidate index. 0.1° ≈ 11 km — a few candidates per cell in our region. */
const CELL_DEG = 0.1;
const FLOOR_SQKM = 0.020234;

function log(message: string): void {
  process.stderr.write(`[reconcile] ${message}\n`);
}

interface Body {
  key: string; // Convex _id
  externalId: string;
  name: string;
  polygon: Polygon | MultiPolygon;
  bbox: BBox;
}

interface NhdFeature {
  nhdId: string;
  gnisId?: string;
  name?: string;
  polygon: Polygon | MultiPolygon;
  bbox: BBox;
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

/** Page the corpus out of Convex. One pass; everything after this is local. */
function exportCorpus(): number {
  mkdirSync(SCRATCH, { recursive: true });
  const out = createWriteStream(CORPUS_FILE);
  let cursor: string | undefined;
  let total = 0;
  for (let page = 0; page < 500; page++) {
    const args: Record<string, unknown> = { batchSize: 200 };
    if (cursor) args.cursor = cursor;
    const res = spawnSync(
      'pnpm',
      [
        '--filter',
        '@skating/convex',
        'exec',
        'convex',
        'run',
        'waterBodies:listForReconcile',
        JSON.stringify(args),
      ],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, cwd: join(HERE, '..', '..', '..') },
    );
    if (res.status !== 0) throw new Error(`convex run failed: ${res.stderr?.slice(0, 400)}`);
    const text = res.stdout ?? '';
    const parsed = JSON.parse(text.slice(text.indexOf('{'))) as {
      bodies: { key: string; externalId: string; name: string; polygon: Polygon | MultiPolygon }[];
      cursor: string;
      isDone: boolean;
    };
    for (const b of parsed.bodies) {
      out.write(`${JSON.stringify(b)}\n`);
      total++;
    }
    cursor = parsed.cursor;
    if (page % 20 === 0) log(`  corpus: ${total.toLocaleString()}…`);
    if (parsed.isDone) break;
  }
  out.end();
  log(`corpus exported: ${total.toLocaleString()} bodies → ${CORPUS_FILE}`);
  return total;
}

/**
 * Dump NHD's post-floor polygons, deduped across the overlapping state files.
 *
 * The five geodatabases overlap heavily — the audit measured 9,792 ids appearing in more than one,
 * with **zero** area disagreements — so first-writer-wins is lossless here. That is exactly why the
 * audit asserts the agreement rather than assuming it.
 */
function exportNhd(): number {
  mkdirSync(SCRATCH, { recursive: true });
  const seen = new Set<string>();
  const out = createWriteStream(NHD_FILE);
  const ids = new DropLedger('nhdId');
  const gnis = new DropLedger('gnisId');
  let written = 0;

  for (const source of NHD_SOURCES) {
    const key = nhdArchiveKey(source);
    const { filename } = JSON.parse(readFileSync(join(NHD_DIR, key, 'manifest.json'), 'utf8')) as {
      filename: string;
    };
    const geojson = join(SCRATCH, `nhd-${key}.geojsonl`);
    log(`${source.state}: extracting polygons…`);
    const res = spawnSync(
      'ogr2ogr',
      [
        '-f',
        'GeoJSONSeq',
        geojson,
        `/vsizip/${join(NHD_DIR, key, filename)}`,
        'NHDWaterbody',
        '-select',
        'permanent_identifier,gnis_id,gnis_name,areasqkm',
        '-where',
        `areasqkm >= ${FLOOR_SQKM}`,
        '-t_srs',
        'EPSG:4326',
        '-dim',
        'XY',
        '-overwrite',
      ],
      { encoding: 'utf8' },
    );
    if (res.status !== 0) throw new Error(`${source.state}: ogr2ogr exited ${res.status}`);

    for (const line of readFileSync(geojson, 'utf8').split('\n')) {
      const trimmed = line.trim().replace(/^/, '');
      if (!trimmed) continue;
      const f = JSON.parse(trimmed) as {
        properties: Record<string, unknown>;
        geometry: Polygon | MultiPolygon | null;
      };
      if (!f.geometry) continue;
      const id = ids.normalize(f.properties.permanent_identifier, (r) =>
        normalizeNhdId(r as string),
      );
      if (!id.ok) continue;
      if (seen.has(id.value)) continue; // the known cross-file overlap; audited as area-identical
      seen.add(id.value);
      const g = gnis.normalize(f.properties.gnis_id, (r) => normalizeGnisId(r as string));
      out.write(
        `${JSON.stringify({
          nhdId: id.value,
          ...(g.ok ? { gnisId: g.value } : {}),
          ...(f.properties.gnis_name ? { name: String(f.properties.gnis_name) } : {}),
          polygon: f.geometry,
        })}\n`,
      );
      written++;
    }
  }
  out.end();
  log(formatLedger(ids.report()));
  log(formatLedger(gnis.report()));
  log(`NHD exported: ${written.toLocaleString()} distinct post-floor polygons → ${NHD_FILE}`);
  return written;
}

// ─────────────────────────────────────────────────────────────────────────────
// Match
// ─────────────────────────────────────────────────────────────────────────────

function cellsFor(bbox: BBox): string[] {
  const out: string[] = [];
  const x0 = Math.floor(bbox.minLng / CELL_DEG);
  const x1 = Math.floor(bbox.maxLng / CELL_DEG);
  const y0 = Math.floor(bbox.minLat / CELL_DEG);
  const y1 = Math.floor(bbox.maxLat / CELL_DEG);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${x}:${y}`);
  return out;
}

async function readNdjson<T>(path: string, onRow: (row: T) => void): Promise<void> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) onRow(JSON.parse(line) as T);
  }
}

async function match(logger: RunLogger): Promise<void> {
  if (!existsSync(CORPUS_FILE) || !existsSync(NHD_FILE)) {
    throw new Error('missing exports — run with --export first');
  }

  const grid = new Map<string, NhdFeature[]>();
  let nhdCount = 0;
  await readNdjson<Omit<NhdFeature, 'bbox'>>(NHD_FILE, (row) => {
    const bbox = polygonBBox(row.polygon);
    const feature: NhdFeature = { ...row, bbox };
    nhdCount++;
    for (const cell of cellsFor(bbox)) {
      const list = grid.get(cell);
      if (list) list.push(feature);
      else grid.set(cell, [feature]);
    }
  });
  log(`indexed ${nhdCount.toLocaleString()} NHD features into ${grid.size.toLocaleString()} cells`);

  const out = createWriteStream(OUT_FILE);
  const matches: { key: string; id: string }[] = [];
  let seen = 0;
  let matched = 0;
  let ambiguous = 0;
  let none = 0;
  let gnisAssisted = 0;
  const nearMisses: { name: string; iou: number }[] = [];

  await readNdjson<Omit<Body, 'bbox'>>(CORPUS_FILE, (row) => {
    seen++;
    const bbox = polygonBBox(row.polygon);
    const pool = new Map<string, NhdFeature>();
    for (const cell of cellsFor(bbox)) {
      for (const f of grid.get(cell) ?? []) pool.set(f.nhdId, f);
    }
    const candidates: ReconcileCandidate[] = [...pool.values()].map((f) => ({
      id: f.nhdId,
      polygon: f.polygon,
      bbox: f.bbox,
      gnisId: f.gnisId,
      name: f.name,
    }));
    // The corpus does not carry a GNIS id yet (the OSM transform never captured `gnis:feature_id`),
    // so the GNIS-assisted bar cannot fire on this pass. Recorded rather than silently unused: it
    // becomes live once the transform captures the tag, and the bar is already tested.
    const outcome = reconcileOne({ polygon: row.polygon, bbox }, candidates);

    if (outcome.verdict === 'matched') {
      matched++;
      if (outcome.gnisAgrees) gnisAssisted++;
      matches.push({ key: row.key, id: outcome.id });
    } else if (outcome.verdict === 'ambiguous') {
      ambiguous++;
    } else {
      none++;
      // 0.3 not 0.25: below the threshold floor the area bound may have skipped the pair without
      // scoring it, so a lower band would under-report and look like there were fewer near misses.
      if (outcome.best && outcome.best.iou > 0.3 && nearMisses.length < 20) {
        nearMisses.push({ name: row.name || row.externalId, iou: outcome.best.iou });
      }
    }
    out.write(
      `${JSON.stringify({ key: row.key, externalId: row.externalId, name: row.name, outcome })}\n`,
    );
    if (seen % 2000 === 0) log(`  ${seen.toLocaleString()} / ~21,665…`);
  });
  out.end();

  const dupes = findCollapsedDuplicates(matches);
  const pct = (n: number) => `${((100 * n) / Math.max(seen, 1)).toFixed(1)}%`;
  log('');
  log(`bodies                ${seen.toLocaleString()}`);
  log(`  matched             ${matched.toLocaleString()}  (${pct(matched)})`);
  log(
    `  ambiguous           ${ambiguous.toLocaleString()}  (${pct(ambiguous)})  → review, nothing written`,
  );
  log(`  no counterpart      ${none.toLocaleString()}  (${pct(none)})`);
  log(`  gnis-assisted       ${gnisAssisted.toLocaleString()}`);
  log(`OSM duplicate pairs collapsed onto one nhdId: ${dupes.length.toLocaleString()}`);
  for (const d of dupes.slice(0, 10)) log(`   ${d.id} ← ${d.keys.length} bodies`);
  if (nearMisses.length) {
    log('near misses (best IoU 0.3-0.5, the threshold’s neighbourhood):');
    for (const m of nearMisses.slice(0, 8)) log(`   ${m.name}: ${m.iou.toFixed(3)}`);
  }
  log(`→ ${OUT_FILE}`);

  logger.count('bodies', seen);
  logger.count('matched', matched);
  logger.count('ambiguous', ambiguous);
  logger.count('unmatched', none);
  logger.count('duplicatePairsCollapsed', dupes.length);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const doExport = args.includes('--export') || !args.includes('--match');
  const doMatch = args.includes('--match') || !args.includes('--export');
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.split('=')[1];

  const logger = new RunLogger({
    kind: 'raw_archive',
    label: 'reconcile OSM ↔ NHD',
    campaignId,
    target: resolveDeployment(),
    call: convexRun,
    notes: [
      'Read-only against Convex. Produces a mapping for review; a separate loader applies it.',
    ],
  });
  logger.start();
  try {
    if (doExport) {
      exportCorpus();
      exportNhd();
    }
    if (doMatch) await match(logger);
    logger.succeed();
  } catch (err) {
    logger.fail({
      stage: 'reconcile',
      key: 'osm-nhd',
      reason: err instanceof Error ? err.message : String(err),
    });
    logger.failed(err);
    throw err;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[reconcile] FAILED: ${(error as Error).message}\n`);
  process.exit(1);
});
