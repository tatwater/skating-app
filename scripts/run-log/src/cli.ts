/**
 * Write an `importRuns` row from outside TypeScript — a bash script, or a backfill (A06c §6.2).
 *
 * The `RunLogger` class assumes a process that opens a row, works, and closes it. Two things don't
 * fit that shape and both matter:
 *
 *  - **The R2 mirrors are bash.** `scripts/lib/mirror-r2.sh` is shared by the OSM and bathymetry
 *    archives and is the step that makes a raw archive durable. Giving it a Convex client would
 *    mean rewriting it in TypeScript for no other reason.
 *  - **Runs that already happened.** The archives were populated on 2026-07-31, months of provenance
 *    before this table existed, and their manifests record everything a row needs. A history that
 *    starts empty because the feature is new is a history that answers "when did we last populate
 *    this" with silence, which is the same answer it gave before.
 *
 * Both file a receipt for a finished run, rather than observing a process as it runs.
 *
 *   pnpm --filter @skating/run-log record '<json>'
 *   echo '<json>' | pnpm --filter @skating/run-log record
 *
 * The JSON is `{ kind, label, status, startedAt?, finishedAt?, campaignId?, counts?, stages?,
 * failures?, failuresTotal?, coverage?, error?, notes? }`. `startedAt`/`finishedAt` are epoch ms and
 * default to now — pass them when recording something that happened in the past, or the row will
 * claim a historical fetch happened this afternoon.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { convexRun } from './convexRun';
import { resolveDeployment } from './deployment';
import type { RunReceipt } from './runReceipt';
import { writeRunReceipt } from './runReceipt';

export function recordFromCommandLine(args: string[]): number {
  const inline = args.find((arg) => !arg.startsWith('--'));
  const raw = inline ?? readStdin();
  if (!raw.trim()) {
    process.stderr.write(
      "usage: pnpm --filter @skating/run-log record '<json>'   (or pipe the JSON on stdin)\n",
    );
    return 1;
  }

  let payload: RunReceipt;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`[run-log] not valid JSON: ${(error as Error).message}\n`);
    return 1;
  }

  const target = resolveDeployment();
  // Keep input errors outside the best-effort boundary for receipt writes.
  const { kind, label } = payload;
  try {
    const runId = writeRunReceipt(payload, target, convexRun);
    process.stderr.write(`[run-log] recorded ${kind} "${label}" (${runId})\n`);
  } catch (error) {
    // Same rule as the class: bookkeeping never breaks the thing it books. A mirror push that
    // succeeded must not report failure because its receipt could not be filed.
    process.stderr.write(
      `[run-log] could not record the run (the work itself is unaffected): ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
  return 0;
}

/** fd 0. Returns '' rather than throwing when nothing is piped in. */
function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

if (import.meta.main) process.exitCode = recordFromCommandLine(process.argv.slice(2));
