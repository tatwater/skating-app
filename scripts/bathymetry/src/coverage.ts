/**
 * Push contour coverage into Convex (N6c-1 / D2) — which bodies the tileset actually draws.
 *
 *   pnpm --filter @skating/bathymetry coverage [--prod] [--dry-run]
 *
 * Reads the **built** contour features (`.scratch/build/contours.geojsonl`) rather than the join
 * cache, and the distinction is the whole point: the join matched 2,437 source lakes, but only
 * **2,022** produced a line anyone can see. A lake whose survey was matched and then gated out is
 * not a lake with contours, and scoring it as one (D2) would claim a state survey we do not draw.
 *
 * Streams the file line by line and extracts `bodyId` — it is ~800 MB, so `readFileSync` would
 * blow the heap and `JSON.parse` per line is wasted work when the field is a fixed string key.
 *
 * **Replaces the set rather than adding to it**, so a re-tile that drops a lake drops its coverage.
 * Run this after every `build-contours` + `tile`, and before the N6c re-score.
 *
 * Subprocess + stream glue; excluded from coverage like the other loaders here.
 */

import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const CONTOURS_FILE = fileURLToPath(
  new URL('../.scratch/build/contours.geojsonl', import.meta.url),
);

/** Rows per mutation. Each is an index probe plus at most one insert, so this sits well inside budget. */
const BATCH = 400;

/** `"bodyId":"way/123"` — a fixed key, so a substring scan beats parsing 800 MB of JSON. */
const KEY = '"bodyId":"';

async function contouredIds(): Promise<string[]> {
  const ids = new Set<string>();
  const rl = createInterface({
    input: createReadStream(CONTOURS_FILE, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of rl) {
    const start = line.indexOf(KEY);
    if (start < 0) continue;
    const from = start + KEY.length;
    const end = line.indexOf('"', from);
    if (end > from) ids.add(line.slice(from, end));
  }
  return [...ids].sort();
}

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
      // unreachable .env.local — treated as non-dev
    }
  }
  if (!deployment) return { label: 'unknown', isDev: false };
  return { label: deployment, isDev: deployment.startsWith('dev:') };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowNonDev = args.includes('--prod');
  const dryRun = args.includes('--dry-run');

  if (!existsSync(CONTOURS_FILE)) {
    process.stderr.write(
      `[coverage] no built contours at ${CONTOURS_FILE}\n` +
        '[coverage] run `pnpm --filter @skating/bathymetry build-contours` first.\n',
    );
    process.exit(1);
  }

  const ids = await contouredIds();
  process.stderr.write(`[coverage] ${ids.length} bodies carry at least one contour line\n`);
  if (dryRun) {
    process.stderr.write('[coverage] --dry-run: nothing written.\n');
    return;
  }

  const target = resolveDeployment();
  process.stderr.write(`[coverage] target deployment: ${target.label}\n`);
  if (!target.isDev && !allowNonDev) {
    process.stderr.write(
      '[coverage] refusing: target is not a dev deployment. Confirm, then re-run with --prod.\n',
    );
    process.exit(1);
  }

  let cleared = 0;
  let inserted = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const out = execFileSync(
      'pnpm',
      [
        '--filter',
        '@skating/convex',
        'exec',
        'convex',
        'run',
        'waterBodies:importContourCoverage',
        JSON.stringify({
          source: 'osm',
          externalIds: ids.slice(i, i + BATCH),
          // Only the first batch clears, which is what makes the whole run a replacement.
          ...(i === 0 ? { clearFirst: true } : {}),
        }),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 },
    );
    const parsed = JSON.parse(out.trim().match(/\{[\s\S]*\}/)?.[0] ?? '{}') as {
      cleared?: number;
      inserted?: number;
    };
    cleared += parsed.cleared ?? 0;
    inserted += parsed.inserted ?? 0;
  }

  process.stderr.write(
    `[coverage] complete: ${inserted} bodies stamped, ${cleared} stale rows cleared\n` +
      '[coverage] re-run the N6c re-score (waterBodies:backfillCells) for this to reach the map.\n',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`[coverage] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
