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

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';

/** Tiny records (an id and two numbers), and each costs one indexed lookup — bytes never bind. */
const MAX_BATCH_COUNT = 200;

function main(): void {
  const args = process.argv.slice(2);
  const allowNonDev = args.includes('--prod');
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);
  const inputPath = args.find((arg) => !arg.startsWith('--'));
  if (!inputPath) {
    process.stderr.write(
      'usage: pnpm --filter @skating/etl load-depths <depths.ndjson> [--prod] [--campaign=<id>]\n',
    );
    process.exit(1);
  }

  // Was a bare `process.env.CONVEX_DEPLOYMENT` read, which meant the dev guard silently did nothing
  // in the normal case — the deployment lives in `packages/convex/.env.local`, not the environment,
  // so `isDev` was false, the third clause was false, and the refusal never fired.
  const target = resolveDeployment();
  process.stderr.write(`[etl] target deployment: ${target.label}\n`);
  if (!target.isDev && !allowNonDev) {
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

  const logger = new RunLogger({
    kind: 'osm_depths',
    label: 'OSM depth tags (N6a rung 7)',
    campaignId,
    target,
    call: convexRun,
    stages: [
      {
        name: 'load',
        detail:
          'waterBodies:importDepths — the bottom rung of the D68 ladder, so it never displaces a survey',
        input: inputPath,
        output: target.label,
      },
    ],
  });
  logger.start();

  const totals = { updated: 0, unmatched: 0, skipped: 0, operatorHeld: 0, inverted: 0 };
  try {
    for (let i = 0; i < depths.length; i += MAX_BATCH_COUNT) {
      const result = convexRun<Partial<typeof totals>>('waterBodies:importDepths', {
        depths: depths.slice(i, i + MAX_BATCH_COUNT),
      });
      if (!result || typeof result.updated !== 'number') {
        throw new Error(`convex run returned an unexpected response: ${JSON.stringify(result)}`);
      }
      totals.updated += result.updated ?? 0;
      totals.unmatched += result.unmatched ?? 0;
      totals.skipped += result.skipped ?? 0;
      totals.operatorHeld += result.operatorHeld ?? 0;
      totals.inverted += result.inverted ?? 0;
    }
  } catch (err) {
    for (const [name, value] of Object.entries(totals)) logger.count(name, value);
    logger.failed(err);
    throw err;
  }

  process.stderr.write(
    `[etl] depth tags loaded: ${totals.updated}/${depths.length} stamped · ` +
      `${totals.skipped} already had a better source · ${totals.unmatched} matched no body · ` +
      `${totals.operatorHeld} held by a moderator's override · ` +
      `${totals.inverted} contradictory mean/max pairs resolved\n`,
  );

  for (const [name, value] of Object.entries(totals)) logger.count(name, value);
  logger.count('tagsRead', depths.length);
  logger.coverage({
    unit: 'OSM-tagged bodies',
    eligible: depths.length,
    covered: totals.updated,
    omissions: [
      { reason: 'already had a higher-precedence source (D68)', count: totals.skipped },
      { reason: 'matched no body in the corpus', count: totals.unmatched },
      { reason: "held by a moderator's override", count: totals.operatorHeld },
    ].filter((o) => o.count > 0),
  });
  logger.stage({
    name: 'load',
    detail:
      'waterBodies:importDepths — the bottom rung of the D68 ladder, so it never displaces a survey',
    input: inputPath,
    output: target.label,
    counts: Object.entries(totals).map(([name, value]) => ({ name, value })),
  });
  logger.succeed([`${totals.inverted} contradictory mean/max pairs resolved`]);
}

main();
