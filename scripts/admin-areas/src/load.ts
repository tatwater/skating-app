/**
 * Admin-areas loader (glue). Chunks admin-area NDJSON into the internal
 * `adminAreas.importCanonical` mutation via the Convex CLI (`pnpm exec convex run`), stamping the
 * required `--state=XX` (2-letter code) onto every row — each per-state extract is one state, so the
 * transform leaves `state` off and the loader injects it here. Loads the **dev** deployment by
 * default; refuses a non-dev target unless `--prod` is passed. Thin subprocess + file I/O — excluded
 * from coverage; all real work is in the tested transform.
 *
 *   pnpm --filter @skating/admin-areas load <areas.ndjson> --state=VT [--prod]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { isKnownStateCode, KNOWN_STATE_CODES } from '@skating/core';

/**
 * Batches bounded like the water ETL: Convex caps a mutation at 4096 document reads, so cap by
 * count (since N1 a row costs one `by_area` lookup plus ≤ 4 cell writes — flat, not growing with
 * the index — so this cap has plenty of headroom); `convex run` also takes args only as an inline
 * JSON string (ARG_MAX), so cap by bytes — a state/county boundary can be large (~hundreds of KB
 * simplified), so the byte budget is what actually binds here.
 */
const MAX_BATCH_COUNT = 150;
const MAX_BATCH_BYTES = 512 * 1024;

/** Group NDJSON lines into batches under both the count and byte budgets. */
function chunk(lines: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line) + 1;
    const full = current.length >= MAX_BATCH_COUNT || size + lineBytes > MAX_BATCH_BYTES;
    if (current.length > 0 && full) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += lineBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function runImport(areas: unknown[]): { inserted: number; updated: number } {
  const args = JSON.stringify({ areas });
  const stdout = execFileSync(
    'pnpm',
    ['--filter', '@skating/convex', 'exec', 'convex', 'run', 'adminAreas:importCanonical', args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 },
  );
  const trimmed = stdout.trim();
  const candidate = trimmed.startsWith('{') ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
  const parsed: unknown = candidate ? JSON.parse(candidate) : undefined;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { inserted?: unknown }).inserted !== 'number' ||
    typeof (parsed as { updated?: unknown }).updated !== 'number'
  ) {
    throw new Error(`convex run returned an unexpected response: ${trimmed || '(empty)'}`);
  }
  return parsed as { inserted: number; updated: number };
}

/** Best-effort read of the target deployment, mirroring the water ETL loader's resolution order. */
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
  // `--state=XX` is REQUIRED — it's the denormalized `state` code stamped onto every row.
  const state = args
    .find((arg) => arg.startsWith('--state='))
    ?.slice('--state='.length)
    .toUpperCase();
  const inputPath = args.find((arg) => !arg.startsWith('--'));
  if (!inputPath || !state) {
    process.stderr.write(
      'usage: pnpm --filter @skating/admin-areas load <areas.ndjson> --state=XX [--prod]\n',
    );
    process.exit(1);
  }
  if (!isKnownStateCode(state)) {
    process.stderr.write(
      `[admin-areas] refusing: unknown --state=${state}. Expected one of: ${KNOWN_STATE_CODES.join(', ')}.\n`,
    );
    process.exit(1);
  }

  const target = resolveDeployment();
  process.stderr.write(`[admin-areas] target deployment: ${target.label}\n`);
  if (!target.isDev && !allowNonDev) {
    process.stderr.write(
      '[admin-areas] refusing: target is not a dev deployment. Confirm, then re-run with --prod.\n',
    );
    process.exit(1);
  }

  const lines = readFileSync(inputPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const batches = chunk(lines);
  process.stderr.write(
    `[admin-areas] loading ${lines.length} areas in ${batches.length} batch(es) (state: ${state})…\n`,
  );

  let inserted = 0;
  let updated = 0;
  let applied = 0;
  try {
    for (const [index, batch] of batches.entries()) {
      // Stamp the state onto every row before sending (transform leaves it off).
      const areas = batch.map((line) => ({ ...JSON.parse(line), state }));
      const result = runImport(areas);
      inserted += result.inserted;
      updated += result.updated;
      applied++;
      process.stderr.write(`[admin-areas] batch ${index + 1}/${batches.length} done\n`);
    }
  } catch (err) {
    process.stderr.write(
      `[admin-areas] FAILED on batch ${applied + 1}/${batches.length}; ${applied} batch(es) applied ` +
        `(${inserted} inserted · ${updated} updated). Re-running is safe (idempotent upsert).\n`,
    );
    throw err;
  }
  process.stderr.write(`[admin-areas] load complete: ${inserted} inserted · ${updated} updated\n`);
}

main();
