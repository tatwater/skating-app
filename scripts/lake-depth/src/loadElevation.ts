/**
 * Elevation loader (glue) — N6c Workstream A1.
 *
 * Walks the corpus through `waterBodies.listNeedingElevation`, looks each page up against the
 * Open-Meteo Elevation API 100 coordinates at a time, and writes the results back through
 * `waterBodies.importElevations`. Loads the **dev** deployment by default; refuses a non-dev target
 * unless `--prod` is passed, matching the other three loaders.
 *
 *   pnpm --filter @skating/lake-depth load-elevation [--prod] [--refresh] [--limit=N]
 *
 * **Resumable by construction, and that is not incidental.** The server-side query skips rows that
 * already carry a reading, so an interrupted run continues where it stopped rather than restarting
 * a 116,070-body pass — and re-running it is a cheap no-op. `--refresh` re-reads rows that already
 * have one (for the day the DEM changes); it is not the normal path. An `operator` elevation is
 * never returned and never overwritten (D68's precedence rule, re-checked at write time because the
 * read and the write are separate transactions).
 *
 * All real logic lives in `./elevation` (tested) and in the two Convex functions (tested); this is
 * subprocess + loop, and is excluded from coverage.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import {
  batchTargets,
  ELEVATION_REQUEST_DELAY_MS,
  type ElevationRecord,
  type ElevationTarget,
  fetchElevationBatch,
  sleep,
} from './elevation';

/** Rows written per mutation. Two small scalars per row, so the read cap binds long before bytes. */
const WRITE_BATCH_SIZE = 200;

function convexRun<T>(fn: string, args: unknown): T {
  const stdout = execFileSync(
    'pnpm',
    ['--filter', '@skating/convex', 'exec', 'convex', 'run', fn, JSON.stringify(args)],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 },
  );
  const trimmed = stdout.trim();
  const candidate = trimmed.startsWith('{') ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) throw new Error(`convex run ${fn} returned nothing parseable: ${trimmed}`);
  return JSON.parse(candidate) as T;
}

/** Best-effort read of the target deployment, mirroring the other loaders' resolution order. */
function resolveDeployment(): { label: string; isDev: boolean } {
  if (process.env.CONVEX_DEPLOY_KEY)
    return { label: 'CONVEX_DEPLOY_KEY (target unknown)', isDev: false };
  let deployment = process.env.CONVEX_DEPLOYMENT;
  if (!deployment) {
    try {
      const envLocal = readFileSync(
        new URL('../../../packages/convex/.env.local', import.meta.url),
        'utf8',
      );
      deployment = envLocal.match(/^CONVEX_DEPLOYMENT=(.+)$/m)?.[1]?.trim();
    } catch {
      // no .env.local reachable — fall through to unknown (treated as non-dev)
    }
  }
  if (!deployment) return { label: 'unknown', isDev: false };
  return { label: deployment, isDev: deployment.startsWith('dev:') };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowNonDev = args.includes('--prod');
  const refresh = args.includes('--refresh');
  const limit = Number(args.find((a) => a.startsWith('--limit='))?.slice('--limit='.length));

  const target = resolveDeployment();
  process.stderr.write(`[elevation] target deployment: ${target.label}\n`);
  if (!target.isDev && !allowNonDev) {
    process.stderr.write(
      '[elevation] refusing: target is not a dev deployment. Confirm, then re-run with --prod.\n',
    );
    process.exit(1);
  }
  if (refresh) {
    process.stderr.write(
      '[elevation] --refresh: re-reading bodies that already carry a DEM elevation.\n',
    );
  }

  const totals = { scanned: 0, looked: 0, updated: 0, operatorHeld: 0, implausible: 0, missing: 0 };
  let cursor: string | undefined;
  let isDone = false;
  let pages = 0;

  while (!isDone) {
    const page = convexRun<{
      targets: ElevationTarget[];
      scanned: number;
      cursor: string;
      isDone: boolean;
    }>('waterBodies:listNeedingElevation', {
      ...(cursor ? { cursor } : {}),
      ...(refresh ? { refresh: true } : {}),
    });
    cursor = page.cursor;
    isDone = page.isDone;
    totals.scanned += page.scanned;
    pages++;

    const records: ElevationRecord[] = [];
    for (const batch of batchTargets(page.targets)) {
      const { records: got, implausible } = await fetchElevationBatch(batch);
      records.push(...got);
      totals.implausible += implausible;
      totals.looked += batch.length;
      await sleep(ELEVATION_REQUEST_DELAY_MS);
    }

    for (let i = 0; i < records.length; i += WRITE_BATCH_SIZE) {
      const result = convexRun<{
        updated: number;
        operatorHeld: number;
        implausible: number;
        missing: number;
      }>('waterBodies:importElevations', { elevations: records.slice(i, i + WRITE_BATCH_SIZE) });
      totals.updated += result.updated;
      totals.operatorHeld += result.operatorHeld;
      totals.implausible += result.implausible;
      totals.missing += result.missing;
    }

    process.stderr.write(
      `[elevation] page ${pages}: scanned ${totals.scanned}, looked up ${totals.looked}, wrote ${totals.updated}\n`,
    );
    if (Number.isFinite(limit) && totals.looked >= limit) {
      process.stderr.write(`[elevation] stopping early at --limit=${limit}\n`);
      break;
    }
  }

  // A coverage RATE, not a count, for the same reason the depth loader prints one: a pass that
  // stamped 60% of what it scanned reads exactly like a complete one if you only print totals.
  const rate = totals.scanned > 0 ? ((totals.updated / totals.scanned) * 100).toFixed(1) : '0.0';
  process.stderr.write(
    `[elevation] complete: ${totals.updated}/${totals.scanned} bodies stamped (${rate}%) over ${pages} page(s)\n`,
  );
  // The numbers that are expected to be non-zero and wrong if LARGE — and none of which is visible
  // from the rate alone, which is the shape of every silent-cap bug this repo has hit before.
  process.stderr.write(
    `[elevation] of those: ${totals.operatorHeld} held by a moderator's override · ` +
      `${totals.implausible} readings outside the plausible window · ` +
      `${totals.missing} rows vanished mid-pass\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[elevation] FAILED: ${err instanceof Error ? err.message : String(err)}\n` +
      '[elevation] Re-running is safe and resumes: rows already stamped are skipped server-side.\n',
  );
  process.exit(1);
});
