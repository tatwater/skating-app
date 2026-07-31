/**
 * OSM depth-tag loader (glue). Chunks the transform's `--depths` NDJSON into the internal
 * `waterBodies.importDepths` mutation, which keys on `source` + `externalId` — no geometric match
 * needed, because these depths came off the very features our bodies were built from.
 *
 * The counterpart loader for the *global* sources lives in `scripts/lake-depth`, and it has to do a
 * spatial join because HydroLAKES and LAGOS-US know nothing about OSM ids. This one is the easy case,
 * which is why it is a separate 60-line script rather than a flag on that one.
 *
 *   pnpm --filter @skating/etl load-depths <depths.ndjson> [--prod]
 *
 * Re-running is safe: the D68 ladder lives inside the mutation, `osm_tag` is its bottom rung, so a
 * re-run can only fill a measurement nothing better has claimed.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

/** Tiny records (an id and two numbers), and each costs one indexed lookup — bytes never bind. */
const MAX_BATCH_COUNT = 200;

function main(): void {
  const args = process.argv.slice(2);
  const allowNonDev = args.includes('--prod');
  const inputPath = args.find((arg) => !arg.startsWith('--'));
  if (!inputPath) {
    process.stderr.write(
      'usage: pnpm --filter @skating/etl load-depths <depths.ndjson> [--prod]\n',
    );
    process.exit(1);
  }

  const deployment = process.env.CONVEX_DEPLOYMENT ?? '';
  const isDev = deployment.startsWith('dev:');
  process.stderr.write(`[etl] target deployment: ${deployment || 'unknown (from .env.local)'}\n`);
  if (!isDev && !allowNonDev && process.env.CONVEX_DEPLOYMENT !== undefined) {
    process.stderr.write(
      '[etl] refusing: target is not a dev deployment. Confirm, then re-run with --prod.\n',
    );
    process.exit(1);
  }

  const depths = readFileSync(inputPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
  if (depths.length === 0) {
    process.stderr.write('[etl] nothing to load: no OSM depth tags in this export.\n');
    return;
  }

  const totals = { updated: 0, unmatched: 0, skipped: 0, operatorHeld: 0, inverted: 0 };
  for (let i = 0; i < depths.length; i += MAX_BATCH_COUNT) {
    const stdout = execFileSync(
      'pnpm',
      [
        '--filter',
        '@skating/convex',
        'exec',
        'convex',
        'run',
        'waterBodies:importDepths',
        JSON.stringify({ depths: depths.slice(i, i + MAX_BATCH_COUNT) }),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024 },
    );
    const match = stdout.trim().match(/\{[\s\S]*\}/)?.[0];
    const result = match ? (JSON.parse(match) as Partial<typeof totals>) : undefined;
    if (!result || typeof result.updated !== 'number') {
      throw new Error(`convex run returned an unexpected response: ${stdout.trim() || '(empty)'}`);
    }
    totals.updated += result.updated ?? 0;
    totals.unmatched += result.unmatched ?? 0;
    totals.skipped += result.skipped ?? 0;
    totals.operatorHeld += result.operatorHeld ?? 0;
    totals.inverted += result.inverted ?? 0;
  }

  process.stderr.write(
    `[etl] depth tags loaded: ${totals.updated}/${depths.length} stamped · ` +
      `${totals.skipped} already had a better source · ${totals.unmatched} matched no body · ` +
      `${totals.operatorHeld} held by a moderator's override · ` +
      `${totals.inverted} contradictory mean/max pairs resolved\n`,
  );
}

main();
