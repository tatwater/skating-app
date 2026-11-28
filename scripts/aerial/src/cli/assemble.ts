/**
 * `pnpm --filter @skating/aerial assemble <campaign> [--pilot <name>] [--dry-run]` — the assemble
 * stage (B05 §2.3–§2.4). A shell over `assemble/`; three places it can run:
 *
 * - **On a Fly Machine** (`FLY_MACHINE_ID` is set; the image's `assemble-aerial` entrypoint): reads
 *   the bucket through `rclone serve http` on localhost, streams the archive up with `rclone rcat`,
 *   writes its progress and, last, its record beside the shards. Needs `R2_BUCKET` and the rclone
 *   config the entrypoint writes from the app's staged secrets (`RCLONE_CONFIG`, remote `r2`).
 * - **On the laptop** (the stage `run-aerial.sh` runs): opens the `aerial_assemble` row, starts the
 *   Machine through `spawn.sh assemble` (T's) and follows its progress into the row's heartbeat.
 *   `--dry-run` instead plans the build on the laptop — every input read and checked, the overviews,
 *   the layout — and uploads nothing and writes no row. Needs `R2_REMOTE` (default `r2`) and
 *   `R2_BUCKET`, from `scripts/aerial/.env.local`.
 * - **Against a local directory** (`AERIAL_LOCAL_BUCKET=<dir>`): the bucket is that directory, for
 *   the local proofs. No rclone, no Fly, no row.
 *
 * Every value is read by name; nothing here prints one.
 */

import process from 'node:process';
import {
  type AssembleDeps,
  type AssembleProgress,
  assemble,
  assemblyKeys,
  planAssembly,
  readBuildManifest,
} from '../assemble/assemble';
import {
  assemblyCounts,
  oneAtATime,
  PROGRESS_WRITE_MS,
  stallWatch,
  withDeadline,
} from '../assemble/orchestrate';
import { gdalRenderer } from '../assemble/overviews';
import { fileStore, fileUploads, httpStore } from '../assemble/stores';
import { type RcloneTarget, rcatSink, serveHttp } from '../assemble/upload';
import { needEnv } from '../preflight';
import { outcomeWord, StageRefusal } from '../refusals';
import { runAssembleStage } from '../stage/assembleStage';
import { parseStageArgs } from '../stages';
import { realWorld } from './world';

function need(name: string): string {
  return needEnv({ env: (n) => process.env[n] }, name);
}

const readManifest = readBuildManifest;

function peakMemory(): () => { rss: number; heap: number } {
  let heap = 0;
  const timer = setInterval(() => {
    heap = Math.max(heap, process.memoryUsage().heapUsed);
  }, 1000);
  timer.unref();
  return () => ({
    rss: process.resourceUsage().maxRSS * 1024,
    heap: Math.max(heap, process.memoryUsage().heapUsed),
  });
}

async function onMachine(campaign: string, pilot?: string): Promise<void> {
  // A stop (`fly machine stop`: SIGINT, then SIGTERM) would end Node without its exit handlers, so
  // the archive's `rclone rcat` would see its input end and complete the upload with the bytes so
  // far; as an exit, `rcatSink` kills it first (PR #188's tenth review).
  process.once('SIGINT', () => process.exit(130));
  process.once('SIGTERM', () => process.exit(143));
  const target: RcloneTarget = {
    remote: 'r2',
    bucket: need('R2_BUCKET'),
    config: process.env.RCLONE_CONFIG,
  };
  const server = await serveHttp(target, 8787);
  const keys = assemblyKeys(campaign, pilot);
  const putJson = async (key: string, value: unknown): Promise<void> => {
    const sink = rcatSink(target, key, {
      contentType: 'application/json',
      cacheControl: 'no-store',
    });
    await sink.write(new TextEncoder().encode(JSON.stringify(value)));
    await sink.end();
  };
  const errorKey = keys.progress.replace(/progress\.json$/, 'error.json');
  // A stuck read or upload stops the beat; the watchdog then frees the Machine, saying why, rather
  // than leave it idling under the cap until someone looks (`MACHINE_STALL_MS`).
  const watch = stallWatch({
    onStall: () => {
      const message =
        'the assembler made no progress for 20 minutes: a read or the upload is stuck';
      process.stderr.write(`failed: ${message}\n`);
      const exit = () => process.exit(1);
      setTimeout(exit, 60_000).unref();
      putJson(errorKey, { at: new Date().toISOString(), refused: false, message }).then(exit, exit);
    },
  });
  // Concurrent index readers can report at once; two rcats to one key race (`oneAtATime`). And a
  // heartbeat is bookkeeping: one that fails (a transient R2 error on a tiny `rcat`) is reported
  // and skipped, never the assembly's failure, and the stream never waits on it.
  // A write that hangs is abandoned after `PROGRESS_WRITE_MS`, so it never holds the ones after it.
  const write = oneAtATime((event: AssembleProgress) =>
    withDeadline(
      () => putJson(keys.progress, { at: new Date().toISOString(), event }),
      PROGRESS_WRITE_MS,
    ).catch((e) => {
      process.stderr.write(
        `[assemble] a progress write failed (the assembly carries on): ${(e as Error).message}\n`,
      );
    }),
  );
  // `assemble` hands over progress only once it has decided (a refused assembly writes none); every
  // event, held or not, feeds the watchdog.
  const progress = (event: AssembleProgress): void => {
    watch.touch();
    void write(event);
  };
  const alive = (): void => watch.touch();
  try {
    const store = httpStore(server.baseUrl);
    const manifest = await readManifest(store, campaign, pilot);
    const record = await assemble(manifest, {
      store,
      upload: (key, o) => rcatSink(target, key, o),
      renderer: gdalRenderer(),
      memory: peakMemory(),
      progress,
      alive,
    });
    process.stdout.write(`${JSON.stringify(assemblyCounts(record))}\n`);
  } catch (e) {
    await putJson(errorKey, {
      at: new Date().toISOString(),
      refused: e instanceof StageRefusal,
      message: (e as Error).message,
    }).catch(() => {});
    throw e;
  } finally {
    watch.stop();
    server.stop();
  }
}

async function locally(
  campaign: string,
  pilot: string | undefined,
  dryRun: boolean,
): Promise<void> {
  const root = need('AERIAL_LOCAL_BUCKET');
  const store = fileStore(root);
  const manifest = await readManifest(store, campaign, pilot);
  const deps: AssembleDeps = {
    store,
    upload: fileUploads(root),
    renderer: gdalRenderer(),
    memory: peakMemory(),
    progress: (e) => {
      process.stderr.write(`[assemble] ${JSON.stringify(e)}\n`);
    },
  };
  const out = dryRun
    ? await planAssembly(manifest, deps)
    : assemblyCounts(await assemble(manifest, deps));
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

async function fromLaptop(
  argv: readonly string[],
  campaign: string,
  pilot: string | undefined,
  dryRun: boolean,
): Promise<void> {
  if (!dryRun) return runAssembleStage(argv, realWorld());
  const target: RcloneTarget = { remote: process.env.R2_REMOTE || 'r2', bucket: need('R2_BUCKET') };
  const server = await serveHttp(target, 8788);
  try {
    const store = httpStore(server.baseUrl);
    const summary = await planAssembly(await readManifest(store, campaign, pilot), {
      store,
      renderer: gdalRenderer(),
    });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    server.stop();
  }
}

async function main(): Promise<void> {
  const args = parseStageArgs(process.argv.slice(2), 'assemble');
  const pilot = args.pilot ?? undefined;
  if (process.env.AERIAL_LOCAL_BUCKET) return locally(args.campaign, pilot, args.dryRun);
  if (process.env.FLY_MACHINE_ID) {
    await onMachine(args.campaign, pilot);
    // The record is written (`assemble` awaited it): a progress write still in flight — abandoned
    // past its deadline, its `rcat` not yet given up — must not hold the Machine up, billing.
    process.exit(0);
  }
  return fromLaptop(process.argv.slice(2), args.campaign, pilot, args.dryRun);
}

main().catch((e) => {
  process.stderr.write(`${outcomeWord(e)}: ${(e as Error).message}\n`);
  process.exit(1);
});
