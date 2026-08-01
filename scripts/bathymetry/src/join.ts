/**
 * Resolve source lakes to our water bodies, and cache the result (N6b).
 *
 *   pnpm --filter @skating/bathymetry join [<source-key>…] [--refresh]
 *
 * Reads the archived soundings/contours, picks a representative point per lake, and calls the
 * `waterBodies.matchBathymetryLakes` query — the same geometric join N6a's depth ETL uses, running
 * server-side because that is where the cell index lives. Writes `.scratch/join/<key>.json`: the
 * matched body's `externalId` (which tiles are stamped with) and its polygon (the shoreline
 * constraint), keyed by the source's own lake id.
 *
 * **The representative point is the deepest sounding, not a centroid**, and that is not a detail.
 * A centroid of soundings is not guaranteed to be *on the water*: a crescent or horseshoe lake puts
 * it on the headland in the middle, and the join then finds nothing — or worse, finds the pond on
 * the other side of that headland. A sounding is on water by definition, and the deepest one is
 * furthest from any shore, which makes it the least likely to fall outside a shoreline that a
 * different survey drew at a different date. This was found by watching a hand-rolled centroid join
 * miss 4 of 6 real Maine lakes.
 *
 * For the contour lanes the equivalent is a vertex of the *deepest* contour, for the same reason:
 * the deepest isobath is the innermost ring, so any point on it is comfortably inside the basin.
 *
 * Untestable subprocess + file glue, excluded from coverage.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import process from 'node:process';
import type { Position } from 'geojson';
import { listRawPages, readRawPage, SCRATCH_ROOT } from './cache';
import { joinInBatches } from './joinQuery';
import { runJoinQuery } from './joinRunner';
import {
  groupByLake,
  type NormalizedContour,
  type NormalizedSounding,
  normalizeChamplainSoundings,
  normalizeMaContours,
  normalizeMeSoundings,
  normalizeNhContours,
} from './normalize';
import { parseSelection, selectSources } from './select';
import { SOURCES } from './sources';
import type { BathymetrySource } from './types';

const JOIN_DIR = pathJoin(SCRATCH_ROOT, 'join');

/**
 * Lakes per query, optimistically.
 *
 * **Not a safe constant, and it isn't meant to be one.** A Convex function may read 16 MB in a single
 * execution, and each lake pulls every listed body near its point with polygons attached — so the
 * cost per lake ranges over three orders of magnitude between a farm pond and a point in the middle
 * of Champlain. `joinInBatches` splits any batch that trips the cap, which is what lets this be sized
 * for the common case instead of for the worst one.
 */
const BATCH = 20;

export interface JoinedLake {
  externalId?: string;
  waterBodyId: string;
  name: string;
  polygon?: unknown;
}

function log(message: string): void {
  process.stderr.write(`[bathymetry] ${message}\n`);
}

/** Read a source's archived pages through its normalizer. */
function readSource(source: BathymetrySource): {
  soundings?: Map<string, NormalizedSounding[]>;
  contours?: Map<string, NormalizedContour[]>;
} {
  const features: GeoJSON.Feature[] = [];
  for (const page of listRawPages(source.key)) {
    const parsed = JSON.parse(readRawPage(source.key, page)) as { features?: GeoJSON.Feature[] };
    features.push(...(parsed.features ?? []));
  }
  switch (source.key) {
    case 'nh-granit-contours':
      return { contours: groupByLake(normalizeNhContours(features).records) };
    case 'ma-massgis-contours':
      return { contours: groupByLake(normalizeMaContours(features).records) };
    case 'me-dep-soundings':
      return { soundings: groupByLake(normalizeMeSoundings(features).records) };
    case 'vt-vcgi-champlain-soundings':
      return { soundings: groupByLake(normalizeChamplainSoundings(features).records) };
    default:
      // VT ANR is a CSV inside a zip, handled by the sounding reader in `sweep`/`build` rather than
      // here. Named rather than silently skipped.
      throw new Error(`join: no page reader for ${source.key} (file sources are read separately)`);
  }
}

/** The deepest sounding — on water by definition, and furthest from any shoreline. */
function pointForSoundings(
  points: readonly NormalizedSounding[],
): { lat: number; lng: number } | undefined {
  let deepest: NormalizedSounding | undefined;
  for (const p of points) if (!deepest || p.depthFt > deepest.depthFt) deepest = p;
  return deepest ? { lat: deepest.lat, lng: deepest.lng } : undefined;
}

/** A vertex of the deepest contour — the innermost ring, so comfortably inside the basin. */
function pointForContours(
  lines: readonly NormalizedContour[],
): { lat: number; lng: number } | undefined {
  let deepest: NormalizedContour | undefined;
  for (const l of lines) if (!deepest || l.depthFt > deepest.depthFt) deepest = l;
  if (!deepest) return undefined;
  const coords: Position[] =
    deepest.geometry.type === 'LineString'
      ? deepest.geometry.coordinates
      : (deepest.geometry.coordinates[0] ?? []);
  // The midpoint of the ring rather than an endpoint: an open contour's ends sit against the mask or
  // the shore, which is exactly where a shoreline disagreement between two surveys shows up.
  const mid = coords[Math.floor(coords.length / 2)];
  const lng = mid?.[0];
  const lat = mid?.[1];
  return typeof lng === 'number' && typeof lat === 'number' ? { lat, lng } : undefined;
}

async function joinSource(source: BathymetrySource, refresh: boolean): Promise<void> {
  const outPath = pathJoin(JOIN_DIR, `${source.key}.json`);
  if (existsSync(outPath) && !refresh) {
    log(`skip ${source.key} — already joined (pass --refresh to redo)`);
    return;
  }

  const { soundings, contours } = readSource(source);
  const lakes: { key: string; point: { lat: number; lng: number } }[] = [];
  const noPoint: string[] = [];

  for (const [key, group] of soundings ?? contours ?? new Map()) {
    const point = soundings
      ? pointForSoundings(group as NormalizedSounding[])
      : pointForContours(group as NormalizedContour[]);
    if (point) lakes.push({ key, point });
    else noPoint.push(key);
  }

  log(`${source.key}: resolving ${lakes.length} lakes, starting at ${BATCH} per query…`);
  const joined: Record<string, JoinedLake> = {};
  const { matches, rejects } = await joinInBatches(
    lakes,
    BATCH,
    async (batch) => runJoinQuery(batch),
    (done, total) => {
      if (done % (BATCH * 10) < BATCH) log(`  ${source.key}: ${done}/${total}`);
    },
  );
  for (const m of matches) joined[m.key] = m;

  mkdirSync(JOIN_DIR, { recursive: true });
  writeFileSync(outPath, JSON.stringify({ joined, rejects, noPoint }, null, 0));

  const pct = ((Object.keys(joined).length / Math.max(1, lakes.length)) * 100).toFixed(0);
  log(`✓ ${source.key}: matched ${Object.keys(joined).length}/${lakes.length} (${pct}%)`);
  if (noPoint.length > 0) log(`  ${noPoint.length} lake(s) had no usable representative point`);

  // Group the rejections by kind. An ETL that silently matches 60% looks exactly like one that
  // matched all of it, so the shape of the misses is the output that matters most here.
  const kinds: Record<string, number> = {};
  for (const r of rejects) {
    const kind = r.reason.startsWith('area mismatch') ? 'area mismatch' : r.reason;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  for (const [kind, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
    log(`  ${n} × ${kind}`);
  }
}

/** Read a cached join, for the tiler and the sample renderer. */
export function readJoin(key: string): Record<string, JoinedLake> {
  const path = pathJoin(JOIN_DIR, `${key}.json`);
  if (!existsSync(path)) return {};
  return (JSON.parse(readFileSync(path, 'utf8')) as { joined: Record<string, JoinedLake> }).joined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const selected = selectSources(SOURCES, parseSelection(args)).filter(
    (s) => s.fetch.type === 'arcgis',
  );
  for (const source of selected) await joinSource(source, refresh);
}

if (process.argv[1]?.endsWith('join.ts')) {
  main().catch((error: unknown) => {
    process.stderr.write(`[bathymetry] join failed: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
