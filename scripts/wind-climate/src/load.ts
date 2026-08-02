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

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
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

function resolveDeployment(): { label: string; isDev: boolean } {
  if (process.env.CONVEX_DEPLOY_KEY)
    return { label: 'CONVEX_DEPLOY_KEY (target unknown)', isDev: false };
  const deployment =
    process.env.CONVEX_DEPLOYMENT ??
    readEnvFile(new URL('../../../packages/convex/.env.local', import.meta.url)).CONVEX_DEPLOYMENT;
  if (!deployment) return { label: 'unknown', isDev: false };
  return { label: deployment, isDev: deployment.startsWith('dev:') };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowNonDev = args.includes('--prod');
  const refresh = args.includes('--refresh');
  const dryRun = args.includes('--dry-run');
  const limit = Number(args.find((a) => a.startsWith('--limit='))?.slice('--limit='.length));

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
  let cursor: string | undefined;
  let isDone = false;
  while (!isDone) {
    const page = convexRun<{
      targets: Target[];
      scanned: number;
      cursor: string;
      isDone: boolean;
    }>('waterBodies:listNeedingWindRose', {
      ...(cursor ? { cursor } : {}),
      ...(refresh ? { refresh: true } : {}),
    });
    cursor = page.cursor;
    isDone = page.isDone;
    scanned += page.scanned;
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
    `[wind] ${scanned} bodies scanned · ${bodies} qualify · ${cells.size} distinct 2 km cells\n` +
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

  // ── 2. One rose per cell, then fan it back out to every body in that cell ──────────────────
  const roses: Array<{ waterBodyId: string; rose: number[] }> = [];
  let cellsDone = 0;
  let tooThin = 0;
  for (const [key, list] of cells) {
    const point = pointForGridKey(key);
    const counts = emptyCounts();
    let hours = 0;
    for (const year of WTK_YEARS) {
      const csv = await fetchCellYear(point, year, apiKey as string, email as string);
      hours += accumulateCsv(csv, counts);
      await sleep(WTK_REQUEST_DELAY_MS);
    }
    const rose = roseFromCounts(counts, hours);
    if (rose) for (const t of list) roses.push({ waterBodyId: t.waterBodyId, rose });
    else tooThin += list.length;

    cellsDone++;
    if (cellsDone % 25 === 0 || cellsDone === cells.size) {
      process.stderr.write(
        `[wind] cell ${cellsDone}/${cells.size} (${roses.length} roses ready)\n`,
      );
    }
    if (Number.isFinite(limit) && cellsDone >= limit) {
      process.stderr.write(`[wind] stopping early at --limit=${limit} cells\n`);
      break;
    }
  }

  // ── 3. Write ───────────────────────────────────────────────────────────────────────────────
  const totals = { updated: 0, malformed: 0, missing: 0 };
  for (let i = 0; i < roses.length; i += WRITE_BATCH_SIZE) {
    const result = convexRun<typeof totals>('waterBodies:importWindRoses', {
      roses: roses.slice(i, i + WRITE_BATCH_SIZE),
    });
    totals.updated += result.updated;
    totals.malformed += result.malformed;
    totals.missing += result.missing;
  }

  const rate = bodies > 0 ? ((totals.updated / bodies) * 100).toFixed(1) : '0.0';
  process.stderr.write(
    `[wind] complete: ${totals.updated}/${bodies} qualifying bodies stamped (${rate}%)\n` +
      `[wind] of those: ${tooThin} cells had too few winter hours to render as a percentage · ` +
      `${totals.malformed} roses rejected server-side · ${totals.missing} rows vanished mid-pass\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[wind] FAILED: ${err instanceof Error ? err.message : String(err)}\n` +
      '[wind] Re-running is safe and resumes: bodies already stamped are skipped server-side.\n',
  );
  process.exit(1);
});
