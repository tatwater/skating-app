/**
 * Resolve every source lake to our water bodies, and cache the result (N6b).
 *
 *   pnpm --filter @skating/bathymetry join [--states=VT,NH] [--refresh]
 *
 * Calls `waterBodies:matchBathymetryLakes`, server-side because that is where the cell index lives.
 * Writes `.scratch/join/lakes.json`: the matched body's `externalId` (what tiles are stamped with),
 * its polygon (the shoreline constraint), and any bays the survey also covers, keyed by
 * `<source>:<lakeKey>`.
 *
 * **Not the same resolver as N6a's depth ETL**, though it was written to be. Placing a whole survey
 * and placing one depth reading want opposite answers when a lake's deepest point falls in one of its
 * bays — see `matchBathymetryLakes`. The first run of this ETL sent every acre of Moosehead Lake to
 * North Bay, and sent nothing at all about it to the log.
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
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import { SCRATCH_ROOT } from './cache';
import { type JoinCandidate, joinInBatches } from './joinQuery';
import { runJoinQuery } from './joinRunner';
import { readAllLakes } from './lakeSources';
import { type ArchivedLake, representativePoint, shapePoints, splitByBody } from './lakes';

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
  /**
   * Bays of the surveyed lake — bodies nested inside it, largest first, omitted when there are none.
   *
   * The builder draws the survey once against the primary polygon and then re-clips those lines to
   * each of these, so opening a bay shows the bay's share of its lake's basin rather than nothing.
   */
  alsoCovers?: { externalId?: string; waterBodyId: string; name: string; polygon?: unknown }[];
}

function log(message: string): void {
  process.stderr.write(`[bathymetry] ${message}\n`);
}

export function lakeId(lake: ArchivedLake): string {
  return `${lake.sourceKey}:${lake.lakeKey}`;
}

/**
 * Measurements per lake sent to the containment gate.
 *
 * **A fixed sample, not the whole survey.** Vermont's densest lake carries 136,856 soundings and
 * Champlain 20,345; sending them would put hundreds of megabytes through a query whose read budget is
 * already the binding constraint. A containment *fraction* converges long before 64 points — the
 * decision it feeds is "most of this, or almost none of it", never a close call.
 */
const FOOTPRINT_SAMPLE = 64;

/**
 * An evenly-strided sample of a lake's own measurements.
 *
 * Strided rather than random, for two reasons that both matter more than sampling purity: a stride is
 * reproducible, so a re-run of the join produces the same verdicts as the run whose rejects someone
 * is reading; and source rows arrive grouped by transect, so a stride crosses every transect while
 * any contiguous slice would sample one line of a lake and call it the lake.
 */
export function sampleFootprint(
  points: readonly { lat: number; lng: number }[],
  limit = FOOTPRINT_SAMPLE,
): { lat: number; lng: number }[] {
  if (points.length <= limit) return points.map((p) => ({ lat: p.lat, lng: p.lng }));
  const stride = points.length / limit;
  const out: { lat: number; lng: number }[] = [];
  for (let i = 0; i < limit; i += 1) {
    const p = points[Math.floor(i * stride)];
    if (p) out.push({ lat: p.lat, lng: p.lng });
  }
  return out;
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

  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);
  const logger = new RunLogger({
    kind: 'bathymetry_join',
    label: 'bathymetry join — archived lakes → corpus bodies',
    campaignId,
    target: resolveDeployment(),
    call: convexRun,
    stages: [
      {
        name: 'resolve',
        detail:
          'every archived source key resolved to a water body, split first so a key holding two ponds cannot match one polygon',
      },
    ],
  });
  logger.start();

  log('reading every archived source…');
  const all = (await readAllLakes()).filter((l) => !states || states.includes(l.state));

  // Split BEFORE the join. A key holding two ponds cannot be resolved to one polygon.
  const lakes = all.flatMap(splitByBody);
  const splits = lakes.length - all.length;
  if (splits > 0)
    log(`${splits} extra lake(s) from source keys that held more than one water body`);

  // **Every candidate carries a sample of its own measurements**, and that is the fix for the
  // quietest bug this ETL has had. The server's gate is conditional on this field being present; the
  // loop used to send nothing, so the gate never ran once across 2,491 lakes. The clearest casualties
  // were Caribou Lake's 28,250 acres of soundings published inside Ripogenus Lake's 1,798, and Fahi
  // Pond's 200 acres inside a 9-acre Mud Pond. Nothing threw, and a wrong basin renders exactly as
  // confidently as a right one.
  //
  // **Counting those casualties needs care, and a first attempt got it wrong.** Maine files some
  // lakes as several rows under one MIDAS — Moose Pond has five, three of them 0.0 acres — so taking
  // the first row per id compares a survey against a fragment and manufactures mismatches that are
  // not there. Aggregate the rows, or compare against the largest.
  //
  // It sends *points* rather than an area, and that took two attempts. An area derived from soundings
  // under-states its lake — they sample the interior — so the first version rejected 68 correct lakes
  // as thousand-fold mismatches, worst on Maine's sparse surveys. What the server can answer reliably
  // is "how much of this survey is inside that polygon", and that needs the points themselves.
  const candidates: JoinCandidate[] = [];
  const noPoint: string[] = [];
  for (const lake of lakes) {
    const point = representativePoint(lake);
    if (!point) {
      noPoint.push(lakeId(lake));
      continue;
    }
    const samplePoints = sampleFootprint(shapePoints(lake));
    candidates.push({
      key: lakeId(lake),
      point,
      ...(samplePoints.length > 0 ? { samplePoints } : {}),
    });
  }
  const unsampled = candidates.filter((c) => c.samplePoints === undefined).length;
  if (unsampled > 0) {
    log(
      `  ⚠ ${unsampled} lake(s) carry no measurements to sample — the join runs ungated for them`,
    );
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
  let bays = 0;
  for (const m of matches) {
    const alsoCovers = (m.alsoCovers ?? []).map((b) => ({
      externalId: b.externalId,
      waterBodyId: b.waterBodyId,
      name: b.name,
      polygon: b.polygon,
    }));
    bays += alsoCovers.length;
    joined[m.key] = {
      externalId: m.externalId,
      waterBodyId: m.waterBodyId,
      name: m.name,
      state: byKey.get(m.key)?.state ?? '',
      polygon: m.polygon,
      ...(alsoCovers.length > 0 ? { alsoCovers } : {}),
    };
  }

  mkdirSync(JOIN_DIR, { recursive: true });
  writeFileSync(JOIN_FILE, JSON.stringify({ joined, rejects, noPoint }, null, 0));

  const pct = ((Object.keys(joined).length / Math.max(1, candidates.length)) * 100).toFixed(0);
  log(`✓ matched ${Object.keys(joined).length}/${candidates.length} (${pct}%)`);
  if (noPoint.length > 0) log(`  ${noPoint.length} lake(s) had no usable representative point`);
  if (bays > 0) log(`  ${bays} nested body/bodies also covered by a surveyed lake`);

  // Group the rejections by kind. An ETL that silently matches 60% looks exactly like one that
  // matched all of it, so the shape of the misses is the output that matters most here.
  const kinds: Record<string, number> = {};
  for (const r of rejects) {
    const kind = r.reason.startsWith('no body here holds the survey')
      ? 'no body here holds the survey'
      : r.reason.startsWith('join failed')
        ? 'query failed'
        : r.reason;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  for (const [kind, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
    log(`  ${n} × ${kind}`);
  }

  // Every rejection itemized, not just tallied by kind — "412 × area mismatch" tells you the shape
  // of the problem, and only the named lakes tell you whether it is the right shape.
  for (const r of rejects) logger.fail({ stage: 'resolve', key: r.key, reason: r.reason });
  for (const key of noPoint) {
    logger.fail({
      stage: 'resolve',
      key,
      reason: 'no usable representative point in the source geometry',
    });
  }

  logger.count('archivedLakes', all.length);
  logger.count('afterSplit', lakes.length);
  logger.count('candidates', candidates.length);
  logger.count('matched', Object.keys(joined).length);
  logger.count('rejected', rejects.length);
  logger.count('noRepresentativePoint', noPoint.length);
  logger.count('nestedBodiesAlsoCovered', bays);
  logger.count('surveysWithNoSampledMeasurements', unsampled);
  logger.coverage({
    unit: 'archived lakes',
    eligible: lakes.length,
    covered: Object.keys(joined).length,
    omissions: [
      ...Object.entries(kinds).map(([reason, count]) => ({ reason, count })),
      { reason: 'no usable representative point in the source geometry', count: noPoint.length },
    ].filter((o) => o.count > 0),
  });
  logger.stage({
    name: 'resolve',
    detail:
      'every archived source key resolved to a water body, split first so a key holding two ponds cannot match one polygon',
    output: JOIN_FILE,
    counts: [
      { name: 'candidates', value: candidates.length },
      { name: 'matched', value: Object.keys(joined).length },
      { name: 'rejected', value: rejects.length },
    ],
  });
  logger.succeed([
    `match rate ${pct}% (${Object.keys(joined).length}/${candidates.length})`,
    ...(splits > 0 ? [`${splits} extra lake(s) from source keys holding more than one body`] : []),
  ]);
}

if (process.argv[1]?.endsWith('join.ts')) {
  main().catch((error: unknown) => {
    process.stderr.write(`[bathymetry] join failed: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
