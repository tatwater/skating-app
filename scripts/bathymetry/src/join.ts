/**
 * Resolve every source lake to our water bodies, and cache the result (N6b).
 *
 *   pnpm --filter @skating/bathymetry join [--states=VT,NH] [--refresh]
 *
 * Calls `waterBodies:matchBathymetryLakes` — the same geometric join N6a's depth ETL uses, running
 * server-side because that is where the cell index lives. Writes `.scratch/join/lakes.json`: the
 * matched body's `externalId` (what tiles are stamped with) and its polygon (the shoreline
 * constraint), keyed by `<source>:<lakeKey>`.
 *
 * **The representative point is the deepest measurement, not a centroid**, and that is not a detail.
 * A centroid of soundings is not guaranteed to be *on the water*: a crescent or horseshoe lake puts
 * it on the headland in the middle, and the join then finds nothing — or worse, finds the pond on the
 * other side of that headland. This was found by watching a hand-rolled centroid join miss 4 of 6
 * real Maine lakes.
 *
 * **Reads through `lakeSources`, not its own page loop.** It used to carry a second copy of the
 * per-source reading, which meant Vermont's BioBase archive — a CSV inside a zip rather than an
 * ArcGIS lane — had no join at all, and the 66 densest lakes in the corpus were unreachable. One
 * reader also means one place where a key that holds two water bodies gets split, which it must be
 * *before* the join: one key resolves to one polygon, so an unsplit key sends the second pond's
 * geometry to be clipped against a shoreline miles away and it vanishes without an error.
 *
 * Untestable subprocess + file glue, excluded from coverage.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import process from 'node:process';
import { SCRATCH_ROOT } from './cache';
import { joinInBatches } from './joinQuery';
import { runJoinQuery } from './joinRunner';
import { readAllLakes } from './lakeSources';
import { type ArchivedLake, representativePoint, splitByBody } from './lakes';

const JOIN_DIR = pathJoin(SCRATCH_ROOT, 'join');
const JOIN_FILE = pathJoin(JOIN_DIR, 'lakes.json');

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
  state: string;
  polygon?: unknown;
}

function log(message: string): void {
  process.stderr.write(`[bathymetry] ${message}\n`);
}

export function lakeId(lake: ArchivedLake): string {
  return `${lake.sourceKey}:${lake.lakeKey}`;
}

/** Read a cached join, for the builder and the sample renderer. */
export function readJoin(): Record<string, JoinedLake> {
  if (!existsSync(JOIN_FILE)) return {};
  return (JSON.parse(readFileSync(JOIN_FILE, 'utf8')) as { joined: Record<string, JoinedLake> })
    .joined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const states = args
    .find((a) => a.startsWith('--states='))
    ?.slice(9)
    .split(',')
    .map((s) => s.trim().toUpperCase());

  if (existsSync(JOIN_FILE) && !refresh) {
    log(`skip — ${JOIN_FILE} exists (pass --refresh to redo)`);
    return;
  }

  log('reading every archived source…');
  const all = (await readAllLakes()).filter((l) => !states || states.includes(l.state));

  // Split BEFORE the join. A key holding two ponds cannot be resolved to one polygon.
  const lakes = all.flatMap(splitByBody);
  const splits = lakes.length - all.length;
  if (splits > 0)
    log(`${splits} extra lake(s) from source keys that held more than one water body`);

  const candidates: { key: string; point: { lat: number; lng: number } }[] = [];
  const noPoint: string[] = [];
  for (const lake of lakes) {
    const point = representativePoint(lake);
    if (point) candidates.push({ key: lakeId(lake), point });
    else noPoint.push(lakeId(lake));
  }

  log(`resolving ${candidates.length} lakes, starting at ${BATCH} per query…`);
  const { matches, rejects } = await joinInBatches(
    candidates,
    BATCH,
    async (batch) => runJoinQuery(batch),
    (done, total) => {
      if (done % (BATCH * 10) < BATCH) log(`  ${done}/${total}`);
    },
  );

  const byKey = new Map(lakes.map((l) => [lakeId(l), l]));
  const joined: Record<string, JoinedLake> = {};
  for (const m of matches) {
    joined[m.key] = {
      externalId: m.externalId,
      waterBodyId: m.waterBodyId,
      name: m.name,
      state: byKey.get(m.key)?.state ?? '',
      polygon: m.polygon,
    };
  }

  mkdirSync(JOIN_DIR, { recursive: true });
  writeFileSync(JOIN_FILE, JSON.stringify({ joined, rejects, noPoint }, null, 0));

  const pct = ((Object.keys(joined).length / Math.max(1, candidates.length)) * 100).toFixed(0);
  log(`✓ matched ${Object.keys(joined).length}/${candidates.length} (${pct}%)`);
  if (noPoint.length > 0) log(`  ${noPoint.length} lake(s) had no usable representative point`);

  // Group the rejections by kind. An ETL that silently matches 60% looks exactly like one that
  // matched all of it, so the shape of the misses is the output that matters most here.
  const kinds: Record<string, number> = {};
  for (const r of rejects) {
    const kind = r.reason.startsWith('area mismatch')
      ? 'area mismatch'
      : r.reason.startsWith('join failed')
        ? 'query failed'
        : r.reason;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  for (const [kind, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
    log(`  ${n} × ${kind}`);
  }
}

if (process.argv[1]?.endsWith('join.ts')) {
  main().catch((error: unknown) => {
    process.stderr.write(`[bathymetry] join failed: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
