/**
 * Build the filled depth bands for every lake the line layer drew (B03 §2).
 *
 *   pnpm --filter @skating/bathymetry build-bands [--only=<bodyId>,…] [--states=NH,MA] [--concurrency=8]
 *
 * Reads `.scratch/build/contours.geojsonl` (the line build's output) and the cached join, traces each
 * lake's bands (`bandChain.ts`), checks them (`bandCheck.ts`), and writes
 * `.scratch/build/bands.geojsonl`. Everything refused is named in `bands-dropped.json`, with every
 * lake's measurements in `bands-check.json` — a lake that silently built no bands would read on the
 * map exactly like one nobody surveyed, which is the failure this package is organized against.
 *
 * Bays (`alsoCovers`) get their parent lake's bands re-clipped, the same rule the lines follow.
 *
 * Local derivation only: no network, no Convex run row (the line build records one; this re-traces its
 * output and changes nothing upstream). Subprocess and file glue; excluded from coverage.
 */

import { createReadStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import type { MultiPolygon, Polygon, Position } from 'geojson';
import {
  type BandFeature,
  type BandLine,
  clipBandsToBody,
  type TracedBands,
  traceBands,
} from './bandChain';
import { type BandCheck, bandVerdict, checkBands } from './bandCheck';
import { SCRATCH_ROOT } from './cache';
import { stampBodyId } from './feature';
import { readJoin } from './join';

const BUILD_DIR = join(SCRATCH_ROOT, 'build');
const IN_FILE = join(BUILD_DIR, 'contours.geojsonl');
const OUT_FILE = join(BUILD_DIR, 'bands.geojsonl');
const DROPPED_FILE = join(BUILD_DIR, 'bands-dropped.json');
const CHECK_FILE = join(BUILD_DIR, 'bands-check.json');
const WORK_DIR = join(SCRATCH_ROOT, 'bands');

function log(message: string): void {
  process.stderr.write(`[bands] ${message}\n`);
}

function flag(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

interface BodyLines {
  lane: 'surveyed' | 'interpolated';
  state: string;
  lines: BandLine[];
}

async function readLines(): Promise<Map<string, BodyLines>> {
  const bodies = new Map<string, BodyLines>();
  const rl = createInterface({
    input: createReadStream(IN_FILE),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const row of rl) {
    if (!row.trim()) continue;
    const f = JSON.parse(row) as {
      properties: { bodyId: string; depthFt: number; lane: BodyLines['lane']; state: string };
      geometry: { coordinates: Position[] };
    };
    const entry = bodies.get(f.properties.bodyId) ?? {
      lane: f.properties.lane,
      state: f.properties.state,
      lines: [],
    };
    entry.lines.push({ depthFt: f.properties.depthFt, coordinates: f.geometry.coordinates });
    bodies.set(f.properties.bodyId, entry);
  }
  return bodies;
}

function label(bodyId: string): string {
  return bodyId.replace(/[^\w.-]+/g, '_');
}

function features(
  bodyId: string,
  lane: BodyLines['lane'],
  bands: TracedBands['bands'],
): BandFeature[] {
  return bands.map(({ spec, geometry }) => ({
    type: 'Feature',
    properties: {
      bodyId,
      bandIndex: spec.bandIndex,
      minDepthFt: spec.minDepthFt,
      // Omitted rather than null on the deepest band: tippecanoe drops nulls anyway, and "absent"
      // is the documented reading — nothing measured bounds this band from below.
      ...(spec.maxDepthFt !== undefined ? { maxDepthFt: spec.maxDepthFt } : {}),
      lane,
    },
    geometry,
  }));
}

async function pool<T>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next] as T;
        next += 1;
        await work(item);
      }
    }),
  );
}

interface Outcome {
  bodyId: string;
  parent?: string;
  state: string;
  lane: BodyLines['lane'];
  bands: number;
  cellM?: number;
  seededRings?: number;
  ambiguousRings?: number;
  specksDropped?: number;
  degenerateLines?: number;
  check?: BandCheck;
  failures?: string[];
  reason?: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = flag(args, 'only')
    ?.split(',')
    .map((s) => s.trim());
  const states = flag(args, 'states')
    ?.split(',')
    .map((s) => s.trim().toUpperCase());
  const concurrency = Number(flag(args, 'concurrency') ?? Math.max(1, cpus().length - 2));

  log(`reading ${IN_FILE}…`);
  const lines = await readLines();
  log(`${lines.size} bodies carry lines`);

  // Who each stamped id is: a lake in its own right, or a bay drawn from its parent's survey.
  const joined = readJoin();
  if (Object.keys(joined).length === 0) throw new Error('no join cached — run `join` first');
  const lakes = new Map<string, Polygon | MultiPolygon>();
  const bays = new Map<string, { id: string; polygon: Polygon | MultiPolygon }[]>();
  for (const body of Object.values(joined)) {
    if (!body.polygon) continue;
    const id = stampBodyId(body);
    lakes.set(id, body.polygon as Polygon | MultiPolygon);
    const nested = (body.alsoCovers ?? [])
      .filter((n) => n.polygon)
      .map((n) => ({ id: stampBodyId(n), polygon: n.polygon as Polygon | MultiPolygon }));
    if (nested.length > 0) bays.set(id, nested);
  }
  const bayIds = new Set([...bays.values()].flat().map((b) => b.id));

  const wanted = (id: string) => {
    const entry = lines.get(id);
    if (!entry) return false;
    if (only && !only.includes(id)) return false;
    if (states && !states.includes(entry.state)) return false;
    return true;
  };
  const topLevel = [...lines.keys()].filter((id) => lakes.has(id) && wanted(id)).sort();
  const orphans = [...lines.keys()].filter((id) => !lakes.has(id) && !bayIds.has(id) && wanted(id));

  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(BUILD_DIR, { recursive: true });

  const outcomes: Outcome[] = orphans.map((bodyId) => ({
    bodyId,
    state: lines.get(bodyId)?.state ?? '?',
    lane: lines.get(bodyId)?.lane ?? 'surveyed',
    bands: 0,
    reason: 'lines carry a bodyId the join has no polygon for',
  }));
  const written = new Map<string, string>();
  let done = 0;
  const started = Date.now();

  const accept = (
    o: Outcome,
    polygon: Polygon | MultiPolygon,
    bodyLines: BandLine[],
    bands: TracedBands['bands'],
    survey?: Polygon | MultiPolygon,
  ) => {
    o.check = checkBands({ lake: polygon, bands, lines: bodyLines, survey });
    o.failures = bandVerdict(o.check);
    if (o.failures.length > 0) {
      o.reason = `failed its check: ${o.failures.join('; ')}`;
      return;
    }
    o.bands = bands.length;
    written.set(
      o.bodyId,
      features(o.bodyId, o.lane, bands)
        .map((f) => JSON.stringify(f))
        .join('\n'),
    );
  };

  await pool(topLevel, concurrency, async (bodyId) => {
    const entry = lines.get(bodyId) as BodyLines;
    const polygon = lakes.get(bodyId) as Polygon | MultiPolygon;
    const o: Outcome = { bodyId, state: entry.state, lane: entry.lane, bands: 0 };
    outcomes.push(o);
    let traced: TracedBands | undefined;
    try {
      traced = await traceBands(label(bodyId), entry.lines, polygon, WORK_DIR);
      Object.assign(o, {
        cellM: Math.round(traced.cellM * 10) / 10,
        seededRings: traced.seededRings,
        ambiguousRings: traced.ambiguousRings,
        specksDropped: traced.specksDropped,
        degenerateLines: traced.degenerateLines,
      });
      if (traced.note) o.reason = traced.note;
      else accept(o, polygon, entry.lines, traced.bands);
    } catch (error) {
      o.reason = `chain threw: ${(error as Error).message.slice(0, 200)}`;
    }

    // The bays, only from a parent whose own bands passed.
    for (const bay of bays.get(bodyId) ?? []) {
      const bayId = bay.id;
      // A bay that is also a lake in its own right was traced from its own survey above.
      if (!wanted(bayId) || lakes.has(bayId)) continue;
      const bayLines = (lines.get(bayId) as BodyLines).lines;
      const b: Outcome = {
        bodyId: bayId,
        parent: bodyId,
        state: entry.state,
        lane: entry.lane,
        bands: 0,
      };
      outcomes.push(b);
      if (!traced || o.reason) {
        b.reason = 'its parent lake built no bands';
        continue;
      }
      try {
        const clipped = await clipBandsToBody(
          `${label(bodyId)}.${label(bayId)}`,
          traced.bands,
          bay.polygon,
          WORK_DIR,
        );
        if (clipped.length === 0) b.reason = 'the clip to the bay left no band';
        // Judged against the part of the bay its parent's survey covers: a bay outline reaching past
        // the parent's is water nobody measured, and it stays unfilled rather than failing the bay.
        else accept(b, bay.polygon, bayLines, clipped, polygon);
      } catch (error) {
        b.reason = `bay clip threw: ${(error as Error).message.slice(0, 200)}`;
      }
    }

    // Scratch is per lake and large (a grid per pass); keep only what a failure needs to be read.
    if (!o.reason) rmSync(join(WORK_DIR, label(bodyId)), { recursive: true, force: true });
    done += 1;
    if (done % 50 === 0 || done === topLevel.length) {
      const rate = (Date.now() - started) / done;
      log(
        `  ${done}/${topLevel.length} lakes · ~${Math.round(((topLevel.length - done) * rate) / 60000)} min left`,
      );
    }
  });

  // Deterministic order, so an unchanged input rebuilds byte-identical output.
  const ids = [...written.keys()].sort();
  writeFileSync(OUT_FILE, ids.length > 0 ? `${ids.map((id) => written.get(id)).join('\n')}\n` : '');
  outcomes.sort((a, b) => a.bodyId.localeCompare(b.bodyId));
  const dropped = outcomes.filter((o) => o.reason);
  writeFileSync(
    DROPPED_FILE,
    JSON.stringify(
      dropped.map((o) => ({
        bodyId: o.bodyId,
        parent: o.parent,
        state: o.state,
        reason: o.reason,
      })),
      null,
      1,
    ),
  );
  writeFileSync(CHECK_FILE, JSON.stringify(outcomes, null, 1));

  const built = outcomes.filter((o) => !o.reason);
  const featureCount = built.reduce((n, o) => n + o.bands, 0);
  log(`\n✓ ${built.length} bodies → ${featureCount.toLocaleString()} band features`);
  log(`  ${OUT_FILE}`);
  const tally = (key: (o: Outcome) => string) => {
    const t: Record<string, number> = {};
    for (const o of built) t[key(o)] = (t[key(o)] ?? 0) + 1;
    return Object.entries(t)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
  };
  log(`  by state: ${tally((o) => o.state)} · by lane: ${tally((o) => o.lane)}`);
  const sum = (k: keyof Outcome) => built.reduce((n, o) => n + (Number(o[k]) || 0), 0);
  log(
    `  seeded ${sum('seededRings')} empty rings · left ${sum('ambiguousRings')} ambiguous · dropped ${sum('specksDropped')} speck rings · ${sum('degenerateLines')} degenerate lines`,
  );
  const kinds: Record<string, number> = {};
  for (const d of dropped) {
    const kind = (d.reason as string).replace(/\d[\d,.]*/g, 'N').slice(0, 90);
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  log(`\n  ${dropped.length} bodies with no bands, by reason:`);
  for (const [kind, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
    log(`    ${String(n).padStart(5)} × ${kind}`);
  }
  log(`  every one named in ${DROPPED_FILE}; measurements for all in ${CHECK_FILE}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`[bands] build failed: ${(error as Error).stack}\n`);
  process.exit(1);
});
