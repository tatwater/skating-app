/**
 * Write an `importRuns` row from outside TypeScript — a bash script, or a backfill (N6c F2).
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
 * Both write a *finished* run in one call, because neither is observing a process it controls.
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

interface RecordPayload {
  kind: string;
  label: string;
  status?: 'running' | 'succeeded' | 'failed';
  campaignId?: string;
  startedAt?: number;
  finishedAt?: number;
  counts?: { name: string; value: number }[];
  stages?: unknown[];
  failures?: { stage: string; key?: string; reason: string }[];
  failuresTotal?: number;
  coverage?: unknown;
  error?: string;
  notes?: string[];
  /** Override the resolved deployment label — only for recording a run against another target. */
  deployment?: string;
  isProd?: boolean;
}

function main(): void {
  const args = process.argv.slice(2);
  const inline = args.find((a) => !a.startsWith('--'));
  const raw = inline ?? readStdin();
  if (!raw.trim()) {
    process.stderr.write(
      "usage: pnpm --filter @skating/run-log record '<json>'   (or pipe the JSON on stdin)\n",
    );
    process.exit(1);
  }

  let payload: RecordPayload;
  try {
    payload = JSON.parse(raw) as RecordPayload;
  } catch (err) {
    process.stderr.write(`[run-log] not valid JSON: ${(err as Error).message}\n`);
    process.exit(1);
    return;
  }

  const target = resolveDeployment();
  const startedAt = payload.startedAt ?? Date.now();

  // Convex's `v.optional(...)` accepts an ABSENT field, not an explicit `null` — and a shell script
  // building JSON by hand has no way to omit a field conditionally, so it writes `"error": null`.
  // Dropping nulls here rather than making every caller do it is the difference between this CLI
  // being usable from bash and being usable from bash if you are very careful.
  const clean = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
    Object.fromEntries(
      Object.entries(obj).filter(([, v]) => v !== null && v !== undefined),
    ) as Partial<T>;

  try {
    const runId = convexRun<string>(
      'importRuns:start',
      clean({
        kind: payload.kind,
        label: payload.label,
        campaignId: payload.campaignId,
        deployment: payload.deployment ?? target.label,
        isProd: payload.isProd ?? target.isProd,
        stages: payload.stages ?? [],
        notes: payload.notes,
      }),
    );

    convexRun(
      'importRuns:finish',
      clean({
        runId,
        status: payload.status ?? 'succeeded',
        counts: payload.counts,
        failures: payload.failures,
        failuresTotal: payload.failuresTotal,
        coverage: payload.coverage,
        error: payload.error,
        notes: payload.notes,
      }),
    );

    // `start`/`finish` stamp their own timestamps from the server clock, which is right for a live
    // run and wrong for a historical one — so a backfilled row is corrected afterwards rather than
    // being allowed to claim a 2026-07-31 fetch happened just now.
    if (payload.startedAt !== undefined || payload.finishedAt !== undefined) {
      convexRun('importRuns:restamp', {
        runId,
        startedAt,
        finishedAt: payload.finishedAt ?? startedAt,
      });
    }

    process.stderr.write(`[run-log] recorded ${payload.kind} "${payload.label}" (${runId})\n`);
  } catch (err) {
    // Same rule as the class: bookkeeping never breaks the thing it books. A mirror push that
    // succeeded must not report failure because its receipt could not be filed.
    process.stderr.write(
      `[run-log] could not record the run (the work itself is unaffected): ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}

/** fd 0. Returns '' rather than throwing when nothing is piped in. */
function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

main();
