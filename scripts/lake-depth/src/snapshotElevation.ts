/**
 * Fetch 3DEP elevation into `.raw-elevation/` — **the pass that happens once** (D101/D104, N7-2).
 *
 *   pnpm --filter @skating/lake-depth snapshot-elevation --from=<bodies.ndjson> [--concurrency=N]
 *   pnpm --filter @skating/lake-depth snapshot-elevation --from-convex [--import-floor]
 *   pnpm --filter @skating/lake-depth snapshot-elevation --from=… --refresh   # re-ask everything
 *
 * ## Split from the load on purpose
 *
 * `scripts/bathymetry` separates `snapshot` from `derive` and `HANDOFF-wind-climate-archive.md`
 * argues at length that the wind pass should have: *"after the one fetch, changing a threshold,
 * adding a statistic, or rebuilding from scratch is `mirror-r2.sh pull` + `derive`."* This is the
 * fetch half. `loadElevation.ts` is the derive half and **reads the archive only** — it never
 * reaches the network, which is the property that makes the split real rather than nominal.
 *
 * It also has to be a separate command because the archive has a **second consumer that has no
 * Convex ids at all**: the merge reads it to refuse tidal bodies, and it does that *before* any of
 * them exists as a row.
 *
 * ## Reads points from either end of the pipeline, deliberately
 *
 * `--from=<artifact>` takes the merge's own `bodies.ndjson`, which is what the tidal referee needs
 * — those points exist before the load. `--from-convex` walks the stored corpus, which is what an
 * incremental top-up after a campaign wants. Both produce the same coordinate keys, so the archive
 * does not care which filled it.
 *
 * All decisions live in `./epqs` and `./elevationArchive`, both tested; this is argv, concurrency,
 * retry and file I/O, and is excluded from coverage.
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import {
  type ElevationArchiveEntry,
  type ElevationArchiveManifest,
  mergeArchiveEntries,
  missingKeys,
  resolutionBands,
} from './elevationArchive';
import { coordinateKey, EPQS_URL, type EpqsRefusal, epqsUrl, parseEpqsResponse } from './epqs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = resolve(HERE, '../.raw-elevation');
const READINGS = `${ARCHIVE_DIR}/readings.ndjson`;
const MANIFEST = `${ARCHIVE_DIR}/manifest.json`;

/**
 * Requests in flight. **Eight, measured** — see `epqs.ts`: latency is ~4 s, so throughput is
 * concurrency divided by latency and nothing else. Eight gives 1.74/s and ~4 h for the corpus.
 *
 * Not raised further without a reason: EPQS publishes no rate limit, which means there is no
 * documented budget to spend and no 429 to back off from — the polite reading of "no published cap"
 * is to stay modest rather than to discover the unpublished one.
 */
const DEFAULT_CONCURRENCY = 8;

/** Attempts per point before it is counted as a failure rather than retried. */
const MAX_ATTEMPTS = 4;
/** Base backoff. A point that fails is one point, not the run — the whole pass must not die on it. */
const BACKOFF_MS = 1_500;
/** How often to checkpoint the archive to disk, in readings. A four-hour run must survive a kill. */
const CHECKPOINT_EVERY = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Point {
  lat: number;
  lng: number;
}

/** Read `{ interiorPoint | representativePoint | centroid }` out of a merge artifact. */
async function pointsFromArtifact(path: string): Promise<Point[]> {
  const out: Point[] = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const body = JSON.parse(line) as {
      interiorPoint?: Point;
      representativePoint?: Point;
      centroid?: Point;
    };
    // **`interiorPoint` first, and this ordering is load-bearing.** `representativePoint` is Turf
    // `pointOnFeature` and lands ON the shoreline, so a DEM read there returns the height of the
    // BANK — biased upward, systematically, exactly where the number is meant to be a water
    // surface. Measured: a hand-picked shoreline point near Paugus Bay read 171 m against the
    // lake's 153 m.
    const point = body.interiorPoint ?? body.representativePoint ?? body.centroid;
    if (point && Number.isFinite(point.lat) && Number.isFinite(point.lng)) out.push(point);
  }
  return out;
}

/** Walk the stored corpus for points, for an incremental top-up after a campaign. */
function pointsFromConvex(importFloorOnly: boolean): Point[] {
  const out: Point[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = convexRun<{
      targets: { lat: number; lng: number }[];
      cursor: string;
      isDone: boolean;
    }>('waterBodies:listNeedingElevation', {
      ...(cursor ? { cursor } : {}),
      // Every row, not just the unstamped ones: the archive is the source of truth and a body
      // already carrying a GLO-90 reading is precisely one we want a 3DEP number for.
      refresh: true,
      ...(importFloorOnly ? { importFloorOnly: true } : {}),
    });
    out.push(...page.targets.map((t) => ({ lat: t.lat, lng: t.lng })));
    cursor = page.cursor;
    if (page.isDone) break;
  }
  return out;
}

function readArchive(): ElevationArchiveEntry[] {
  if (!existsSync(READINGS)) return [];
  return readFileSync(READINGS, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ElevationArchiveEntry);
}

function writeArchive(entries: readonly ElevationArchiveEntry[], refusals: Record<string, number>) {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  writeFileSync(READINGS, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const manifest: ElevationArchiveManifest = {
    archive: 'usgs-3dep-epqs',
    sourceUrl: EPQS_URL,
    // 3DEP is a USGS product; US federal government works are public domain (17 U.S.C. § 105).
    licence: 'Public domain (US Government work, 17 U.S.C. § 105) — USGS 3DEP',
    fetchedAt: new Date().toISOString(),
    entries: entries.length,
    resolutionsM: resolutionBands(entries),
    refusals,
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function fetchPoint(
  lat: number,
  lng: number,
): Promise<{ ok: true; entry: ElevationArchiveEntry } | { ok: false; reason: EpqsRefusal }> {
  let lastReason: EpqsRefusal = 'unparseable';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_MS * 2 ** (attempt - 1));
    let body: unknown;
    try {
      const res = await fetch(epqsUrl(lat, lng), { signal: AbortSignal.timeout(45_000) });
      if (!res.ok) continue;
      const text = await res.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    } catch {
      continue; // network / timeout — worth another go
    }
    const outcome = parseEpqsResponse(body, lat);
    if (outcome.ok) {
      return {
        ok: true,
        entry: {
          key: coordinateKey(lat, lng),
          lat,
          lng,
          fetchedAt: new Date().toISOString(),
          ...outcome.reading,
        },
      };
    }
    // **`implausible` is an ANSWER, not a failure.** EPQS said "no data here" and retrying asks
    // the same raster the same question. Only a mangled response is worth another attempt.
    if (outcome.reason === 'implausible') return { ok: false, reason: 'implausible' };
    lastReason = outcome.reason;
  }
  return { ok: false, reason: lastReason };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const from = args.find((a) => a.startsWith('--from='))?.slice('--from='.length);
  const fromConvex = args.includes('--from-convex');
  const refresh = args.includes('--refresh');
  const importFloorOnly = args.includes('--import-floor');
  const limit = Number(args.find((a) => a.startsWith('--limit='))?.slice('--limit='.length));
  const concurrency =
    Number(args.find((a) => a.startsWith('--concurrency='))?.slice('--concurrency='.length)) ||
    DEFAULT_CONCURRENCY;

  if (!from && !fromConvex) {
    process.stderr.write(
      '[3dep] need --from=<bodies.ndjson> or --from-convex.\n' +
        '       --from reads a merge artifact (the points exist before the load, which is what\n' +
        '       the tidal referee needs); --from-convex walks the stored corpus.\n',
    );
    process.exit(1);
  }

  const points = from ? await pointsFromArtifact(resolve(from)) : pointsFromConvex(importFloorOnly);
  const existing = refresh ? [] : readArchive();
  const archived = new Set(existing.map((e) => e.key));
  let todo = missingKeys(points, archived, coordinateKey);
  process.stderr.write(
    `[3dep] ${points.length.toLocaleString()} points · ${archived.size.toLocaleString()} already archived · ` +
      `${todo.length.toLocaleString()} to fetch\n`,
  );
  if (Number.isFinite(limit) && limit > 0) {
    todo = todo.slice(0, limit);
    process.stderr.write(`[3dep] --limit=${limit}: fetching ${todo.length}\n`);
  }
  if (todo.length === 0) {
    process.stderr.write('[3dep] archive already answers every point — nothing to do.\n');
    // Still rewrite the manifest: a run that found nothing to do should leave a current census.
    if (existing.length > 0) writeArchive(existing, {});
    return;
  }

  const estimateH = (todo.length / (concurrency / 4) / 3600).toFixed(1);
  process.stderr.write(
    `[3dep] concurrency ${concurrency}, ~4 s per request → roughly ${estimateH} h\n`,
  );

  const logger = new RunLogger({
    kind: 'elevation',
    label: '3DEP snapshot (archive)',
    campaignId: args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length),
    target: resolveDeployment(),
    call: convexRun,
    stages: [
      {
        name: 'usgs-3dep · epqs',
        detail:
          'epqs.nationalmap.gov point service — 1 m LiDAR where the region has been flown, ' +
          'no key and no documented cap. Replaces Open-Meteo, whose free tier counts each ' +
          "coordinate and is shared with the product's own weather crons (D101).",
        sourceUrl: EPQS_URL,
      },
      { name: 'archive', detail: `.raw-elevation/readings.ndjson`, output: ARCHIVE_DIR },
    ],
  });
  logger.start();

  const fetched: ElevationArchiveEntry[] = [];
  const refusals: Record<string, number> = {};
  let cursor = 0;
  let done = 0;
  const started = Date.now();
  const checkpoint = () => writeArchive(mergeArchiveEntries(existing, fetched), refusals);

  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (;;) {
          const i = cursor++;
          const point = todo[i];
          if (!point) return;
          const result = await fetchPoint(point.lat, point.lng);
          if (result.ok) fetched.push(result.entry);
          else refusals[result.reason] = (refusals[result.reason] ?? 0) + 1;
          done++;
          if (done % CHECKPOINT_EVERY === 0) {
            // **Checkpointed, because four hours is long enough to be interrupted.** Everything
            // fetched so far survives, and a re-run picks up from the archive rather than from zero.
            checkpoint();
            const rate = done / ((Date.now() - started) / 1000);
            const leftH = (todo.length - done) / rate / 3600;
            process.stderr.write(
              `[3dep] ${done.toLocaleString()}/${todo.length.toLocaleString()} · ` +
                `${rate.toFixed(2)}/s · ~${leftH.toFixed(1)} h left\n`,
            );
            logger.count('fetched', fetched.length);
            logger.flush();
          }
        }
      }),
    );
  } catch (err) {
    checkpoint();
    logger.failed(err);
    throw err;
  }

  const all = mergeArchiveEntries(existing, fetched);
  writeArchive(all, refusals);
  const bands = resolutionBands(all);
  process.stderr.write(
    `[3dep] archived ${fetched.length.toLocaleString()} new · ${all.length.toLocaleString()} total\n` +
      `[3dep] resolutions: ${JSON.stringify(bands)}\n` +
      `[3dep] refused: ${JSON.stringify(refusals)}\n`,
  );

  logger.count('fetched', fetched.length);
  logger.count('archived', all.length);
  for (const [band, n] of Object.entries(bands)) logger.count(`resolution.${band}`, n);
  for (const [reason, n] of Object.entries(refusals)) logger.count(`refused.${reason}`, n);
  logger.coverage({
    unit: 'points',
    eligible: todo.length,
    covered: fetched.length,
    omissions: Object.entries(refusals).map(([reason, count]) => ({ reason, count })),
  });
  logger.succeed([
    `${all.length.toLocaleString()} points archived at ${ARCHIVE_DIR}`,
    'mirror with scripts/lake-depth/mirror-elevation-r2.sh push',
  ]);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[3dep] FAILED: ${err instanceof Error ? err.message : String(err)}\n` +
      '[3dep] Re-running is safe and resumes: the archive is checkpointed and already-archived\n' +
      '       points are never re-fetched.\n',
  );
  process.exit(1);
});
