/**
 * Lake-depth loader (glue). Chunks depth NDJSON into the internal `waterBodies.matchAndImportDepths`
 * mutation via the Convex CLI, which is where the geometric join happens (the N1 cell index lives
 * there). Loads the **dev** deployment by default; refuses a non-dev target unless `--prod` is passed.
 * Thin subprocess + file I/O — excluded from coverage; all real work is in the tested transform and the
 * tested mutation.
 *
 *   pnpm --filter @skating/lake-depth load <depths.ndjson> [--prod]
 *
 * Re-running is safe and converges: the D68 ladder is enforced inside the mutation, so a resumed or
 * repeated run never downgrades a value and never overwrites an operator's.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

/**
 * Batch size, chosen against the **read** cap rather than the byte budget that binds the other loaders.
 * Each lake costs a cell scan plus a handful of body reads, so a 4096-read mutation budget divided by a
 * pessimistic ~100 reads per dense lookup leaves room for ~40. 25 keeps headroom for the densest corner
 * of the corpus (eastern Maine returns 513 bodies in one viewport), and the records themselves are tiny
 * — a point and two numbers — so bytes never bind here.
 */
const MAX_BATCH_COUNT = 25;

interface MatchResult {
  updated: number;
  unmatched: number;
  areaRejected: number;
  skipped: number;
  /** Matches the area gate could not run on, because one side reported no area. */
  noAreaGate: number;
  /** Measurements a moderator owns — a reading or an explicit rejection. Never overwritten (D68). */
  operatorHeld: number;
  /** Lakes where a mean exceeded a max, so the ladder had to drop one of the two. */
  inverted: number;
  /** Lakes where both we and HydroLAKES had a shoreline, so D85's cross-check could run. */
  shorelineCompared: number;
  /** …of those, how many disagreed by more than 2x — a broken-join signal, not an accuracy bar. */
  shorelineDisagreed: number;
  rejects: { key: string; reason: string }[];
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

function runImport(lakes: unknown[]): MatchResult {
  const args = JSON.stringify({ lakes });
  const stdout = execFileSync(
    'pnpm',
    [
      '--filter',
      '@skating/convex',
      'exec',
      'convex',
      'run',
      'waterBodies:matchAndImportDepths',
      args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 },
  );
  const trimmed = stdout.trim();
  const candidate = trimmed.startsWith('{') ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
  const parsed: unknown = candidate ? JSON.parse(candidate) : undefined;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { updated?: unknown }).updated !== 'number'
  ) {
    throw new Error(`convex run returned an unexpected response: ${trimmed || '(empty)'}`);
  }
  return parsed as MatchResult;
}

/** Best-effort read of the target deployment, mirroring the other two loaders' resolution order. */
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

function main(): void {
  const args = process.argv.slice(2);
  const allowNonDev = args.includes('--prod');
  const inputPath = args.find((arg) => !arg.startsWith('--'));
  if (!inputPath) {
    process.stderr.write(
      'usage: pnpm --filter @skating/lake-depth load <depths.ndjson> [--prod]\n',
    );
    process.exit(1);
  }

  const target = resolveDeployment();
  process.stderr.write(`[lake-depth] target deployment: ${target.label}\n`);
  if (!target.isDev && !allowNonDev) {
    process.stderr.write(
      '[lake-depth] refusing: target is not a dev deployment. Confirm, then re-run with --prod.\n',
    );
    process.exit(1);
  }

  const lakes = readFileSync(inputPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
  const batches = chunk(lakes, MAX_BATCH_COUNT);
  process.stderr.write(
    `[lake-depth] matching ${lakes.length} source lakes in ${batches.length} batch(es)…\n`,
  );

  const totals = {
    updated: 0,
    unmatched: 0,
    areaRejected: 0,
    skipped: 0,
    noAreaGate: 0,
    operatorHeld: 0,
    inverted: 0,
    shorelineCompared: 0,
    shorelineDisagreed: 0,
  };
  const rejects: { key: string; reason: string }[] = [];
  let applied = 0;
  try {
    for (const [index, batch] of batches.entries()) {
      const result = runImport(batch);
      totals.updated += result.updated;
      totals.unmatched += result.unmatched;
      totals.areaRejected += result.areaRejected;
      totals.skipped += result.skipped;
      totals.noAreaGate += result.noAreaGate ?? 0;
      totals.operatorHeld += result.operatorHeld ?? 0;
      totals.inverted += result.inverted ?? 0;
      totals.shorelineCompared += result.shorelineCompared ?? 0;
      totals.shorelineDisagreed += result.shorelineDisagreed ?? 0;
      rejects.push(...(result.rejects ?? []));
      applied++;
      if ((index + 1) % 20 === 0 || index + 1 === batches.length) {
        process.stderr.write(`[lake-depth] batch ${index + 1}/${batches.length} done\n`);
      }
    }
  } catch (err) {
    process.stderr.write(
      `[lake-depth] FAILED on batch ${applied + 1}/${batches.length}; ${applied} batch(es) applied. ` +
        'Re-running is safe (the ladder is enforced server-side, so nothing downgrades).\n',
    );
    throw err;
  }

  // The match rate is the number worth reading, so it goes first and it is a rate, not a count. A join
  // that stamped 60% of its input reads exactly like one that stamped all of it if you only print totals.
  const rate = lakes.length > 0 ? ((totals.updated / lakes.length) * 100).toFixed(1) : '0.0';
  process.stderr.write(
    `[lake-depth] load complete: ${totals.updated}/${lakes.length} stamped (${rate}%) · ` +
      `${totals.skipped} already had a better source · ${totals.unmatched} matched no body · ` +
      `${totals.areaRejected} rejected on area\n`,
  );
  // The two numbers that describe how much of the run went un-checked or was deliberately withheld.
  // Both are expected to be non-zero; both are wrong if they are *large*, and neither is visible from
  // the match rate alone — which is the shape of every silent-cap bug this repo has already hit once.
  process.stderr.write(
    `[lake-depth] of those: ${totals.noAreaGate} matched with no area gate (one side reported no area) · ` +
      `${totals.operatorHeld} held by a moderator's override · ` +
      `${totals.inverted} contradictory mean/max pairs resolved\n`,
  );
  // D85's free cross-check. Printed even at zero, because "HydroLAKES and we agreed everywhere" and
  // "the comparison never ran" are different results that look identical if you only print failures.
  process.stderr.write(
    `[lake-depth] shoreline cross-check (D85): ${totals.shorelineCompared} lakes comparable · ` +
      `${totals.shorelineDisagreed} disagreed by >2× (ours is stored either way)\n`,
  );
  const SHOWN = 30;
  for (const r of rejects.slice(0, SHOWN)) {
    process.stderr.write(`[lake-depth] no match ${r.key}: ${r.reason}\n`);
  }
  if (rejects.length > SHOWN) {
    process.stderr.write(
      `[lake-depth] …and ${rejects.length - SHOWN} more rejections (not shown)\n`,
    );
  }
}

main();
