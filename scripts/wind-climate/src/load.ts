/**
 * Winter wind-rose loader (glue) — N6c A4b.
 *
 * Walks the corpus through `waterBodies.listNeedingWindRose`, dedupes the qualifying bodies onto
 * the WIND Toolkit's native 2 km grid, fetches `WTK_YEARS` winters per cell, and writes one rose
 * per body through `waterBodies.importWindRoses`. Dev by default; refuses a non-dev target without
 * `--prod`, like the other loaders.
 *
 *   pnpm --filter @skating/wind-climate load [--prod] [--refresh] [--dry-run] [--limit=N]
 *
 * **`--dry-run` costs no requests and is the right first move**: it reports how many bodies
 * qualify, how many distinct cells they collapse to, and therefore exactly how many requests and
 * how long the real run will take against a 10,000/day, 1/second budget. That arithmetic is the
 * whole reason the dedupe exists, so it should be visible before anyone commits to it.
 *
 * Resumable: the server-side query skips bodies that already carry a rose, so an interrupted run
 * continues rather than restarting, and re-running is a cheap no-op.
 *
 * All real logic is in `./wtk` (tested) and the two Convex functions (tested); this is subprocess,
 * network and loop, and is excluded from coverage.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import {
  accumulateCsv,
  emptyCounts,
  fetchCellYear,
  gridKey,
  pointForGridKey,
  roseFromCounts,
  sleep,
  WTK_REQUEST_DELAY_MS,
  WTK_YEARS,
} from './wtk';

const WRITE_BATCH_SIZE = 200;

interface Target {
  waterBodyId: string;
  lat: number;
  lng: number;
}

/**
 * How many cells may fail back-to-back before the run gives up.
 *
 * A ~1,900-cell pass is ~2.5 hours of 1-request-per-second politeness, and one cell the WIND
 * Toolkit declines is not a reason to throw the other 1,899 away — the write is resumable, so a
 * skipped cell costs a re-run of that cell alone. A *streak* is a revoked key, a rate-limit wall or
 * a moved endpoint, and continuing would spend hours discovering it slowly.
 */
const MAX_CONSECUTIVE_CELL_FAILURES = 10;

/** Read a `KEY=value` file without pulling in a dotenv dependency, as the other scripts do. */
function readEnvFile(url: URL): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(url, 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match?.[1]) out[match[1]] = (match[2] ?? '').trim();
    }
    return out;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowNonDev = args.includes('--prod');
  const refresh = args.includes('--refresh');
  const dryRun = args.includes('--dry-run');
  const limit = Number(args.find((a) => a.startsWith('--limit='))?.slice('--limit='.length));
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);
  // Same predicate as the elevation pass and the canonical import — `meetsAreaFloor`, applied
  // server-side. A switch rather than a threshold, so this file cannot carry a stale copy of a rule
  // that changes; see `listNeedingElevation` for the drift that motivated it.
  const importFloorOnly = args.includes('--import-floor');

  const env = { ...readEnvFile(new URL('../.env.local', import.meta.url)), ...process.env };
  const apiKey = env.WIND_TOOLKIT_API_KEY;
  const email = env.WIND_TOOLKIT_EMAIL;
  if (!dryRun && (!apiKey || !email)) {
    process.stderr.write(
      '[wind] missing WIND_TOOLKIT_API_KEY / WIND_TOOLKIT_EMAIL.\n' +
        '[wind] cp .env.example .env.local and get a free key at https://developer.nlr.gov/signup/\n',
    );
    process.exit(1);
  }

  const target = resolveDeployment();
  process.stderr.write(`[wind] target deployment: ${target.label}\n`);
  if (!target.isDev && !allowNonDev) {
    process.stderr.write(
      '[wind] refusing: target is not a dev deployment. Confirm, then re-run with --prod.\n',
    );
    process.exit(1);
  }

  // ── 1. Collect every qualifying body, and fold them onto the 2 km grid ─────────────────────
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
      ...(refresh ? { refresh: true } : {}),
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
  const requests = cells.size * WTK_YEARS.length;
  const minutes = Math.ceil((requests * WTK_REQUEST_DELAY_MS) / 60_000);
  process.stderr.write(
    `[wind] ${scanned} bodies scanned · ${belowFloor} below the import floor · ` +
      `${bodies} qualify · ${cells.size} distinct 2 km cells\n` +
      `[wind] ${requests} requests (${WTK_YEARS.length} winters x ${cells.size} cells), ~${minutes} min at 1/s\n`,
  );
  // The dedupe is the whole affordability argument, so it gets stated rather than implied.
  if (bodies > 0) {
    process.stderr.write(
      `[wind] the grid dedupe saves ${bodies * WTK_YEARS.length - requests} requests\n`,
    );
  }
  if (dryRun) {
    process.stderr.write('[wind] --dry-run: no requests made, nothing written.\n');
    return;
  }

  // Run history (N6c F2). Opened before the first request so a pass killed two hours in — the
  // likeliest outcome for the longest loader we have — still leaves a record of how far it got.
  const logger = new RunLogger({
    kind: 'wind_climate',
    label: refresh ? 'winter wind roses (refresh)' : 'winter wind roses',
    campaignId,
    target,
    call: convexRun,
    stages: [
      {
        name: 'qualify',
        detail:
          "bodies whose longest fetch clears the caption's floor, folded onto the WIND Toolkit's native 2 km grid",
        counts: [
          { name: 'scanned', value: scanned },
          { name: 'qualified', value: bodies },
          { name: 'distinctCells', value: cells.size },
          { name: 'requestsSavedByDedupe', value: bodies * WTK_YEARS.length - requests },
        ],
      },
      {
        name: 'fetch',
        detail: `NREL WIND Toolkit — ${WTK_YEARS.length} winters (${WTK_YEARS[0]}–${WTK_YEARS.at(-1)}) per cell, Dec–Mar hours into 16 sectors`,
        sourceUrl: 'https://developer.nlr.gov/api/wind-toolkit/',
      },
    ],
  });
  logger.start();

  // ── 2. One rose per cell, then fan it back out to every body in that cell ──────────────────
  const roses: Array<{ waterBodyId: string; rose: number[] }> = [];
  let cellsDone = 0;
  let tooThin = 0;
  let cellsFailed = 0;
  let bodiesInFailedCells = 0;
  let consecutiveFailures = 0;
  try {
    for (const [key, list] of cells) {
      const point = pointForGridKey(key);
      try {
        const counts = emptyCounts();
        let hours = 0;
        for (const year of WTK_YEARS) {
          const csv = await fetchCellYear(point, year, apiKey as string, email as string);
          hours += accumulateCsv(csv, counts);
          await sleep(WTK_REQUEST_DELAY_MS);
        }
        const rose = roseFromCounts(counts, hours);
        if (rose) for (const t of list) roses.push({ waterBodyId: t.waterBodyId, rose });
        else {
          tooThin += list.length;
          // Not a failure — a cell with too few winter hours stores nothing *on purpose*, because
          // "about 19% of the time" reads identically whether it summarises 300 hours or 14,000.
          // Recorded so the gap is legible rather than looking like a lost cell.
          logger.fail({
            stage: 'fetch',
            key: `cell ${key} (${list.length} bodies)`,
            reason: `too few winter hours (${hours}) to render a rose — stored nothing, by design`,
          });
        }
        consecutiveFailures = 0;
      } catch (err) {
        cellsFailed++;
        bodiesInFailedCells += list.length;
        consecutiveFailures++;
        const message = err instanceof Error ? err.message : String(err);
        logger.fail({
          stage: 'fetch',
          key: `cell ${key} (${list.length} bodies)`,
          reason: message,
        });
        process.stderr.write(
          `[wind] cell ${key} FAILED (${consecutiveFailures} in a row): ${message}\n`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_CELL_FAILURES) {
          throw new Error(
            `${MAX_CONSECUTIVE_CELL_FAILURES} consecutive cell failures — last: ${message}`,
          );
        }
      }

      cellsDone++;
      if (cellsDone % 25 === 0 || cellsDone === cells.size) {
        process.stderr.write(
          `[wind] cell ${cellsDone}/${cells.size} (${roses.length} roses ready)\n`,
        );
        logger.count('cellsDone', cellsDone);
        logger.count('cellsFailed', cellsFailed);
        logger.count('rosesReady', roses.length);
        logger.flush();
      }
      if (Number.isFinite(limit) && cellsDone >= limit) {
        process.stderr.write(`[wind] stopping early at --limit=${limit} cells\n`);
        logger.stage({
          name: 'fetch',
          detail: `stopped early at --limit=${limit} cells — this run did NOT cover the corpus`,
        });
        break;
      }
    }
  } catch (err) {
    // The roses already fetched are still worth writing: the pass is resumable, and throwing them
    // away would mean the next run re-spends the same hours of 1-per-second requests. Write first,
    // *then* close the row, so the run records what it actually managed to land.
    process.stderr.write(
      `[wind] aborting the fetch after ${cellsFailed} cell failure(s); writing the ${roses.length} roses already in hand.\n`,
    );
    writeRoses();
    logger.failed(err);
    throw err;
  }

  // ── 3. Write ───────────────────────────────────────────────────────────────────────────────
  const totals = { updated: 0, malformed: 0, missing: 0 };
  writeRoses();
  const rate = bodies > 0 ? ((totals.updated / bodies) * 100).toFixed(1) : '0.0';
  logger.succeed([
    `coverage: ${totals.updated}/${bodies} qualifying bodies stamped (${rate}%)`,
    `${tooThin} bodies sit in cells with too few winter hours to render a rose — deliberate, not a gap`,
  ]);

  /** Push whatever roses are in hand and record the outcome. Safe to call from either path. */
  function writeRoses(): void {
    for (let i = 0; i < roses.length; i += WRITE_BATCH_SIZE) {
      const result = convexRun<typeof totals>('waterBodies:importWindRoses', {
        roses: roses.slice(i, i + WRITE_BATCH_SIZE),
      });
      totals.updated += result.updated;
      totals.malformed += result.malformed;
      totals.missing += result.missing;
    }

    const pct = bodies > 0 ? ((totals.updated / bodies) * 100).toFixed(1) : '0.0';
    process.stderr.write(
      `[wind] complete: ${totals.updated}/${bodies} qualifying bodies stamped (${pct}%)\n` +
        `[wind] of those: ${tooThin} cells had too few winter hours to render as a percentage · ` +
        `${totals.malformed} roses rejected server-side · ${totals.missing} rows vanished mid-pass\n`,
    );

    logger.count('scanned', scanned);
    logger.count('qualified', bodies);
    logger.count('distinctCells', cells.size);
    logger.count('cellsDone', cellsDone);
    logger.count('cellsFailed', cellsFailed);
    logger.count('updated', totals.updated);
    logger.count('tooThin', tooThin);
    logger.count('malformed', totals.malformed);
    logger.count('missing', totals.missing);
    logger.coverage({
      unit: 'qualifying bodies',
      eligible: bodies,
      covered: totals.updated,
      omissions: [
        // Deliberate, not a gap: a thin cell renders identically to a thick one, so it stores nothing.
        { reason: 'cell had too few winter hours to render a rose (by design)', count: tooThin },
        { reason: 'rose rejected server-side as malformed', count: totals.malformed },
        { reason: 'row vanished mid-pass', count: totals.missing },
        { reason: 'in a cell whose fetch failed', count: bodiesInFailedCells },
      ].filter((o) => o.count > 0),
    });
    logger.stage({
      name: 'write',
      detail: 'waterBodies:importWindRoses — one 16-sector rose per body, summing to 1',
      output: target.label,
      counts: [
        { name: 'updated', value: totals.updated },
        { name: 'malformed', value: totals.malformed },
        { name: 'missing', value: totals.missing },
      ],
    });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[wind] FAILED: ${err instanceof Error ? err.message : String(err)}\n` +
      '[wind] Re-running is safe and resumes: bodies already stamped are skipped server-side.\n',
  );
  process.exit(1);
});
