/**
 * Measure how much of 3DHP is elevation-derived, and file it as a `catalogue_edh_coverage` snapshot.
 *
 *   pnpm --filter @skating/etl measure-3dhp [--no-live] [--date=YYYY-MM-DD] [--dry-run]
 *
 * ## What this is watching
 *
 * USGS retired NHD in 2023 and replaced it with the 3D Hydrography Program, whose promise is
 * hydrography traced from LiDAR rather than compiled at 1:24,000. Where that elevation-derived
 * hydrography does not exist yet, **3DHP republishes NHD** — and says so per feature in `workunitid`.
 *
 * So this pass is a long-horizon watch on the base map under the whole product getting re-surveyed.
 * It is expected to read **zero for our five states for a while**, and the number is worth storing
 * anyway: a series that starts at zero and steps up is only legible if somebody recorded the zeroes.
 *
 * ## Two sources, because they disagree and the disagreement is the interesting part
 *
 * - **the archive** — the annual staged release we mirror. Reproducible, citable, up to a year stale,
 *   and the number our corpus actually reflects.
 * - **the live service** — the same layer, refreshed quarterly. A leading indicator. `--no-live`
 *   skips it; an unreachable service degrades to a warning rather than losing the archive lane.
 *
 * Measured 2026-08-03: the FY26 archive has **0** elevation-derived features in our envelope while
 * the live service already has **1,590**, all in western Massachusetts. That gap *is* the annual
 * cadence's cost, and recording both makes it visible instead of a surprise next year.
 *
 * Untestable file + network glue, excluded from coverage. The provenance rule and the tally live in
 * `./threeDhpArchive` (`isElevationDerived`, `summarizeEdhCoverage`), tested.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import {
  CURRENT_3DHP_RELEASE,
  type EdhCoverage,
  NORTHEAST_CLIP,
  summarizeEdhCoverage,
  THREE_DHP_WATERBODY_LAYER,
} from './threeDhpArchive';

const CLIP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.raw-3dhp', 'waterbody');
const METRIC = 'catalogue_edh_coverage';
const SERVICE = 'https://hydro.nationalmap.gov/arcgis/rest/services/3DHP_all/MapServer/60/query';

function log(message: string): void {
  process.stderr.write(`[3dhp] ${message}\n`);
}

/**
 * Tally the archived clip.
 *
 * Streams `workunitid` out of the GeoPackage through `ogrinfo` rather than loading 275k rows: the
 * measurement is a `GROUP BY`, so let SQLite do it and parse the handful of resulting lines.
 */
function measureArchive(): { coverage: EdhCoverage; filename: string } {
  const manifestPath = join(CLIP_DIR, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`no 3DHP clip archived — run \`archive-3dhp\` first (looked in ${CLIP_DIR})`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { filename: string };
  const gpkg = join(CLIP_DIR, manifest.filename);
  if (!existsSync(gpkg)) {
    throw new Error(
      `clip manifest present but ${manifest.filename} is missing — mirror-3dhp-r2.sh pull`,
    );
  }

  const result = spawnSync(
    'ogrinfo',
    [
      '-q',
      '-sql',
      `SELECT workunitid, COUNT(*) AS n FROM ${THREE_DHP_WATERBODY_LAYER} GROUP BY workunitid`,
      gpkg,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`ogrinfo exited ${result.status}`);

  // `ogrinfo` prints one `field (Type) = value` line per column, grouped per feature. Rebuild the
  // pairs by walking them in order rather than regexing the whole blob, so a null work unit (which
  // prints `(null)`) stays distinguishable from a missing line.
  const ids: (string | null)[] = [];
  let pending: string | null | undefined;
  for (const line of (result.stdout ?? '').split('\n')) {
    const wu = /^\s*workunitid \([^)]*\) = (.*)$/.exec(line);
    if (wu) {
      pending = wu[1] === '(null)' ? null : (wu[1] ?? null);
      continue;
    }
    const count = /^\s*n \([^)]*\) = (\d+)$/.exec(line);
    if (count && pending !== undefined) {
      for (let i = 0; i < Number(count[1]); i++) ids.push(pending);
      pending = undefined;
    }
  }
  return { coverage: summarizeEdhCoverage(ids), filename: manifest.filename };
}

/** Ask the live service the same question — two counts, no geometry, no paging. */
async function measureLive(): Promise<EdhCoverage> {
  const [minLng, minLat, maxLng, maxLat] = NORTHEAST_CLIP;
  const geometry = encodeURIComponent(
    JSON.stringify({
      xmin: minLng,
      ymin: minLat,
      xmax: maxLng,
      ymax: maxLat,
      spatialReference: { wkid: 4326 },
    }),
  );
  const bbox = `geometry=${geometry}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects`;
  const count = async (where: string): Promise<number> => {
    const res = await fetch(
      `${SERVICE}?where=${encodeURIComponent(where)}&${bbox}&returnCountOnly=true&f=json`,
    );
    if (!res.ok) throw new Error(`service returned ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { count?: number };
    if (typeof body.count !== 'number')
      throw new Error(`service returned no count: ${JSON.stringify(body)}`);
    return body.count;
  };
  const total = await count('1=1');
  const elevationDerived = await count("workunitid <> 'NHD'");
  return {
    total,
    elevationDerived,
    nhdFallback: total - elevationDerived,
    unknownProvenance: 0, // the service cannot distinguish blank from NHD without paging every row
    workUnits: {}, // ditto — the archive lane carries the per-work-unit breakdown
    share: total === 0 ? 0 : elevationDerived / total,
  };
}

function describe(label: string, c: EdhCoverage): void {
  const pct = (c.share * 100).toFixed(3);
  log(
    `${label}: ${c.elevationDerived.toLocaleString()} of ${c.total.toLocaleString()} elevation-derived (${pct}%)`,
  );
  if (c.unknownProvenance > 0)
    log(`  ${c.unknownProvenance.toLocaleString()} with no provenance label — counted as neither`);
  const units = Object.entries(c.workUnits).sort((a, b) => b[1] - a[1]);
  for (const [unit, n] of units.slice(0, 8)) log(`  work unit ${unit}: ${n.toLocaleString()}`);
}

/**
 * One measurement writes **one row carrying both lanes**, and that is a correction rather than a
 * preference.
 *
 * The first version took `--live` as a mode and wrote whichever lane it was asked for. Both runs on
 * the same day landed on the same `metricSnapshots` date, and the second silently replaced the first —
 * idempotency working exactly as designed, on two things that were never the same measurement.
 *
 * They are also more useful together than apart: **the gap between them is the annual cadence's cost**,
 * and it is currently the most informative thing on the chart (0.000% archived against 0.445%
 * published). `scalar` is the archive's share — the number our corpus actually reflects — and `meta`
 * carries both, so the chart can draw the lag as its own line.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const skipLive = args.includes('--no-live');
  const dryRun = args.includes('--dry-run');
  const date =
    args.find((a) => a.startsWith('--date='))?.split('=')[1] ??
    new Date().toISOString().slice(0, 10);
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.split('=')[1];

  const logger = new RunLogger({
    kind: 'raw_archive',
    label: '3dhp EDH coverage',
    campaignId,
    target: resolveDeployment(),
    call: convexRun,
    notes: [
      'Expected to read zero for our states for some years. A series that starts at zero is only legible if somebody recorded the zeroes.',
    ],
  });
  logger.start();

  try {
    const { coverage: archive, filename } = measureArchive();
    describe(`archive (${CURRENT_3DHP_RELEASE.fiscalYear})`, archive);

    // The service lane is a leading indicator, not the record. If it is unreachable the archive
    // measurement is still worth filing — degrading to "we could not ask" beats losing the year.
    let live: EdhCoverage | undefined;
    if (!skipLive) {
      try {
        live = await measureLive();
        describe('live service', live);
      } catch (err) {
        log(`live service unreachable (${(err as Error).message}) — filing the archive lane alone`);
      }
    }

    logger.count('waterbodies', archive.total);
    logger.count('elevationDerived', archive.elevationDerived);
    if (live) logger.count('elevationDerivedLive', live.elevationDerived);

    if (dryRun) {
      log('--dry-run: nothing written');
      logger.succeed();
      return;
    }

    convexRun('analytics:recordCatalogueSnapshot', {
      metric: METRIC,
      date,
      scalar: archive.share,
      meta: {
        release: CURRENT_3DHP_RELEASE.fiscalYear,
        archive: {
          total: archive.total,
          elevationDerived: archive.elevationDerived,
          nhdFallback: archive.nhdFallback,
          unknownProvenance: archive.unknownProvenance,
          workUnits: archive.workUnits,
          share: archive.share,
          ...(filename ? { file: filename } : {}),
        },
        ...(live
          ? {
              live: {
                total: live.total,
                elevationDerived: live.elevationDerived,
                share: live.share,
              },
            }
          : {}),
      },
    });
    log(`recorded ${METRIC} for ${date}`);
    logger.succeed();
  } catch (err) {
    logger.fail({
      stage: 'measure',
      key: CURRENT_3DHP_RELEASE.fiscalYear,
      reason: err instanceof Error ? err.message : String(err),
    });
    logger.failed(err);
    throw err;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[3dhp] measure failed: ${(error as Error).message}\n`);
  process.exit(1);
});
