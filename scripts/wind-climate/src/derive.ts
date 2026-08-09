/**
 * **Archive → roses and strong-wind hours, offline** — the cheap half of the wind lane (N7-3).
 *
 *   pnpm --filter @skating/wind-climate derive [--min-mps=8.94] [--campaign=<id>] [--prod]
 *
 * Reads `.raw/` and writes to Convex. **Makes no network requests to WTK at all**, and fails loudly
 * when a cell it needs is missing rather than quietly fetching it — a derive that silently hits the
 * network is how an archive stops being the source of truth.
 *
 * That is the property the whole rebuild exists for: after the one 7.7-hour snapshot, changing the
 * strong-wind threshold, adding a statistic, or rebuilding from scratch costs minutes and zero
 * requests. `--min-mps` is the demonstration — pass a different bar and every count changes with no
 * request made.
 *
 * ## What it writes, and the one asymmetry worth knowing
 *
 * A rose is suppressed below `MIN_ROSE_HOURS` because it renders as a percentage and a percentage of
 * a thin sample is indistinguishable from a percentage of a thick one. Strong-hour **counts** carry
 * their own denominator, so a thin sample there is a small number honestly reported. A cell can
 * therefore contribute strong-wind hours and no rose. See `climateFromAccumulator`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { STRONG_WIND_MIN_MPS, WIND_ARCHIVE_MIN_FETCH_M } from '@skating/core';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import { responsePath } from './archive';
import { accumulateCsv, climateFromAccumulator, emptyAccumulator, gridKey, WTK_YEARS } from './wtk';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = resolve(HERE, '../.raw');

interface Target {
  waterBodyId: string;
  lat: number;
  lng: number;
}

/** Rows per mutation. Each carries two 16-element arrays and two scalars. */
const WRITE_BATCH_SIZE = 100;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowNonDev = args.includes('--prod');
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);
  const importFloorOnly = args.includes('--import-floor');
  const minMps =
    Number(args.find((a) => a.startsWith('--min-mps='))?.slice('--min-mps='.length)) ||
    STRONG_WIND_MIN_MPS;

  const target = resolveDeployment();
  process.stderr.write(`[derive] target deployment: ${target.label}\n`);
  if (!target.isDev && !allowNonDev) {
    process.stderr.write(
      '[derive] refusing: target is not a dev deployment. Confirm, then re-run with --prod.\n',
    );
    process.exit(1);
  }
  if (!existsSync(RAW_DIR)) {
    process.stderr.write(
      `[derive] no archive at ${RAW_DIR}.\n` +
        '[derive] Run `snapshot` (7.7 h) or `mirror-r2.sh pull` (minutes). This command deliberately\n' +
        '[derive] cannot fetch: a derive that quietly hits the network is how an archive stops being\n' +
        '[derive] the source of truth.\n',
    );
    process.exit(1);
  }

  // ── Which bodies want a rose, folded onto the same grid the archive is keyed by ────────────
  const cells = new Map<string, Target[]>();
  let scanned = 0;
  let belowFloor = 0;
  let cursor: string | undefined;
  let isDone = false;
  while (!isDone) {
    const page = convexRun<{
      targets: Target[];
      scanned: number;
      belowFloor?: number;
      cursor: string;
      isDone: boolean;
    }>('waterBodies:listNeedingWindRose', {
      ...(cursor ? { cursor } : {}),
      // Everything, not just the unstamped: a re-derive at a different threshold has to reach the
      // bodies that already carry a rose, or `--min-mps` would only ever affect new ones.
      refresh: true,
      // **The same constant `snapshot` fetched against**, never a flag — see
      // `WIND_ARCHIVE_MIN_FETCH_M`. This command refuses when a cell is missing, so scoping wider
      // than the fetch did is not a smaller result, it is a failed run.
      minFetchM: WIND_ARCHIVE_MIN_FETCH_M,
      ...(importFloorOnly ? { importFloorOnly: true } : {}),
    });
    cursor = page.cursor;
    isDone = page.isDone;
    scanned += page.scanned;
    belowFloor += page.belowFloor ?? 0;
    for (const t of page.targets) {
      const key = gridKey(t);
      const bucket = cells.get(key);
      if (bucket) bucket.push(t);
      else cells.set(key, [t]);
    }
  }
  const bodies = [...cells.values()].reduce((n, list) => n + list.length, 0);

  const archived = new Set(
    existsSync(RAW_DIR)
      ? readdirSync(RAW_DIR, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      : [],
  );
  const missing = [...cells.keys()].filter((key) => !archived.has(key));
  process.stderr.write(
    `[derive] ${bodies} bodies in ${cells.size} cells · ${archived.size} cells archived · ` +
      `${missing.length} cells missing · threshold ${minMps} m/s\n`,
  );
  if (missing.length > 0) {
    // **Loud, and it names them.** A derive that skipped missing cells would report a coverage
    // figure over the cells it happened to have, which is the misleading denominator this campaign
    // has corrected three times already.
    process.stderr.write(
      `[derive] REFUSING: ${missing.length} cell(s) the corpus needs are not in the archive. ` +
        `e.g. ${missing.slice(0, 5).join(', ')}\n` +
        '[derive] Run `snapshot` to fetch only the difference — it is incremental.\n',
    );
    process.exit(1);
  }

  const logger = new RunLogger({
    kind: 'wind_climate',
    label: `winter wind roses + sustained wind (derive @ ${minMps} m/s)`,
    campaignId,
    target,
    call: convexRun,
    stages: [
      {
        name: 'archive · read',
        detail:
          `${archived.size} cells x ${WTK_YEARS.length} winters from .raw/ — NO network requests. ` +
          'Re-deriving at a different threshold costs minutes; the fetch cost 7.7 hours, once.',
        output: RAW_DIR,
      },
      {
        name: 'write',
        detail:
          'waterBodies:importWindRoses — a 16-sector rose summing to 1, plus per-sector strong-wind ' +
          'HOURS (absolute) and the sample they came from.',
        output: target.label,
      },
    ],
  });
  logger.start();

  const updates: {
    waterBodyId: string;
    rose?: number[];
    strongWindHours: number[];
    sampledWindHours: number;
    strongWindMinMps: number;
  }[] = [];
  let tooThin = 0;
  let cellsRead = 0;
  let yearsMissing = 0;

  for (const [key, list] of cells) {
    const acc = emptyAccumulator(minMps);
    for (const year of WTK_YEARS) {
      const path = join(RAW_DIR, responsePath(key, year));
      if (!existsSync(path)) {
        // A cell present but a year absent: a partial fetch. Counted rather than fatal — the other
        // winters still describe the cell, and `sampledWindHours` records the smaller sample
        // honestly, which is exactly what that field is for.
        yearsMissing++;
        continue;
      }
      accumulateCsv(gunzipSync(readFileSync(path)).toString('utf8'), acc);
    }
    const climate = climateFromAccumulator(acc);
    if (climate.rose === null) tooThin += list.length;
    for (const t of list) {
      updates.push({
        waterBodyId: t.waterBodyId,
        ...(climate.rose ? { rose: climate.rose } : {}),
        strongWindHours: climate.strongWindHours,
        sampledWindHours: climate.sampledWindHours,
        strongWindMinMps: climate.strongWindMinMps,
      });
    }
    cellsRead++;
    if (cellsRead % 100 === 0) {
      process.stderr.write(`[derive] ${cellsRead}/${cells.size} cells read\n`);
    }
  }

  const totals = { updated: 0, malformed: 0, missing: 0 };
  for (let i = 0; i < updates.length; i += WRITE_BATCH_SIZE) {
    const result = convexRun<typeof totals>('waterBodies:importWindRoses', {
      roses: updates.slice(i, i + WRITE_BATCH_SIZE),
    });
    totals.updated += result.updated;
    totals.malformed += result.malformed;
    totals.missing += result.missing;
    logger.count('updated', totals.updated);
    logger.flush();
  }

  const rate = bodies > 0 ? ((totals.updated / bodies) * 100).toFixed(1) : '0.0';
  process.stderr.write(
    `[derive] complete: ${totals.updated}/${bodies} qualifying bodies stamped (${rate}%)\n` +
      `[derive] of those: ${tooThin} in cells too thin to render a rose (they still carry ` +
      `strong-wind hours) · ${totals.malformed} rejected server-side · ${totals.missing} rows gone\n`,
  );
  logger.count('scanned', scanned);
  logger.count('belowFloor', belowFloor);
  logger.count('qualified', bodies);
  logger.count('cellsRead', cellsRead);
  logger.count('yearsMissing', yearsMissing);
  logger.count('tooThinForARose', tooThin);
  logger.count('malformed', totals.malformed);
  logger.count('missing', totals.missing);
  logger.coverage({
    unit: 'qualifying bodies',
    eligible: bodies,
    covered: totals.updated,
    omissions: [
      { reason: 'rose suppressed: cell too thin to render as a percentage', count: tooThin },
      { reason: 'rejected server-side as malformed', count: totals.malformed },
      { reason: 'row vanished mid-pass', count: totals.missing },
    ].filter((o) => o.count > 0),
  });
  logger.succeed([
    `${totals.updated} bodies stamped at ${minMps} m/s, from the archive, with no requests made`,
    ...(yearsMissing > 0
      ? [`${yearsMissing} cell-year(s) absent from the archive — re-run snapshot to complete them`]
      : []),
  ]);
}

main().catch((err: unknown) => {
  process.stderr.write(`[derive] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
