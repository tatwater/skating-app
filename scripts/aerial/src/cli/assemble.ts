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

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { NaipManifest } from '@skating/core';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import {
  type AssembleDeps,
  type AssembleProgress,
  AssembleRefusal,
  type AssemblyRecord,
  assemble,
  assemblyKeys,
  planAssembly,
} from '../assemble/assemble';
import {
  assembleScope,
  assemblyCounts,
  followAssembly,
  oneAtATime,
  readObject,
  spawnExitMessage,
  stallWatch,
} from '../assemble/orchestrate';
import { gdalRenderer } from '../assemble/overviews';
import { fileStore, fileUploads, httpStore, type ObjectStore } from '../assemble/stores';
import { type RcloneTarget, rcatSink, rcloneRun, serveHttp } from '../assemble/upload';
import { buildManifestKey } from '../keys';
import { checkRunTarget, RunTargetRefusal } from '../runTarget';
import { parseStageArgs, StageArgsError } from '../stages';

const HERE = dirname(fileURLToPath(import.meta.url));

function need(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
}

async function readManifest(
  store: ObjectStore,
  campaign: string,
  pilot?: string,
): Promise<NaipManifest> {
  const bytes = await store.get(buildManifestKey(campaign, pilot));
  if (bytes === null)
    throw new Error(`no manifest at ${buildManifestKey(campaign, pilot)}: run the select stage`);
  return JSON.parse(new TextDecoder().decode(bytes)) as NaipManifest;
}

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
  const write = oneAtATime((event: AssembleProgress) =>
    putJson(keys.progress, { at: new Date().toISOString(), event }).catch((e) => {
      process.stderr.write(
        `[assemble] a progress write failed (the assembly carries on): ${(e as Error).message}\n`,
      );
    }),
  );
  const progress = (event: AssembleProgress): void => {
    watch.touch();
    void write(event);
  };
  try {
    const store = httpStore(server.baseUrl);
    const manifest = await readManifest(store, campaign, pilot);
    const record = await assemble(manifest, {
      store,
      upload: (key, o) => rcatSink(target, key, o),
      renderer: gdalRenderer(),
      memory: peakMemory(),
      progress,
    });
    process.stdout.write(`${JSON.stringify(assemblyCounts(record))}\n`);
  } catch (e) {
    await putJson(errorKey, {
      at: new Date().toISOString(),
      refused: e instanceof AssembleRefusal,
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
  campaign: string,
  pilot: string | undefined,
  dryRun: boolean,
): Promise<void> {
  const target: RcloneTarget = { remote: process.env.R2_REMOTE || 'r2', bucket: need('R2_BUCKET') };
  if (dryRun) {
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
    return;
  }
  const deployment = resolveDeployment();
  checkRunTarget(pilot ?? null, deployment);
  const logger = new RunLogger({
    kind: 'aerial_assemble',
    label: `assemble ${campaign}${pilot ? ` (pilot ${pilot})` : ''}`,
    campaignId: campaign,
    target: deployment,
    scope: assembleScope(pilot ?? null),
    call: convexRun,
  });
  const keys = assemblyKeys(campaign, pilot);
  const errorKey = keys.progress.replace(/progress\.json$/, 'error.json');
  // `null` when the object isn't there; a throw when the bucket can't be reached, which the
  // follower never counts as the Machine's silence (`readObject`).
  const cat = <T>(key: string): Promise<T | null> =>
    readObject<T>(() => rcloneRun(target, ['cat', `${target.remote}:${target.bucket}/${key}`]));

  // **A re-run never starts a second assembly.** A record means an earlier run finished (it is the
  // assembler's last write): the stage takes it, whatever that run's row says (a laptop that lost
  // its stream marked it failed). A running assembler is attached to by `spawn.sh`, never doubled.
  const finished = await cat<AssemblyRecord>(keys.record);
  logger.start();
  if (finished !== null) {
    for (const [name, value] of Object.entries(assemblyCounts(finished))) logger.count(name, value);
    logger.succeed([
      `already assembled (${finished.finishedAt}): archive ${finished.archive.key}`,
      `index ${finished.cellIndex.key}`,
    ]);
    process.stdout.write(`already assembled: ${keys.record} names ${finished.archive.key}\n`);
    return;
  }
  // An earlier attempt's error object, so its message is never read as this run's.
  const stale = (await cat<{ at?: string }>(errorKey).catch(() => null))?.at ?? null;
  const machine = spawn(
    'bash',
    [
      join(HERE, '..', '..', 'spawn.sh'),
      'assemble',
      campaign,
      ...(pilot ? ['--pilot', pilot] : []),
    ],
    {
      stdio: 'inherit',
    },
  );
  let exit: number | null | undefined;
  machine.on('close', (code) => {
    exit = code;
  });
  try {
    const record = await followAssembly({
      readProgress: () => cat(keys.progress),
      readRecord: () => cat(keys.record),
      machineDone: async () => {
        if (exit === undefined) return false;
        if (exit === 0) return true;
        throw new Error(spawnExitMessage(exit));
      },
      logger,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    });
    for (const [name, value] of Object.entries(assemblyCounts(record))) logger.count(name, value);
    logger.succeed([`archive ${record.archive.key}`, `index ${record.cellIndex.key}`]);
  } catch (e) {
    // Stop the wait (never the Machine: `spawn.sh` only watches it).
    if (exit === undefined) machine.kill('SIGTERM');
    const err = await cat<{ at?: string; message?: string }>(errorKey).catch(() => null);
    const own = err?.message && err.at !== stale ? new Error(err.message) : null;
    logger.failed(own ?? e);
    throw own ?? e;
  }
}

async function main(): Promise<void> {
  const args = parseStageArgs(process.argv.slice(2), 'assemble');
  const pilot = args.pilot ?? undefined;
  if (process.env.AERIAL_LOCAL_BUCKET) return locally(args.campaign, pilot, args.dryRun);
  if (process.env.FLY_MACHINE_ID) return onMachine(args.campaign, pilot);
  return fromLaptop(args.campaign, pilot, args.dryRun);
}

main().catch((e) => {
  const refused =
    e instanceof StageArgsError || e instanceof AssembleRefusal || e instanceof RunTargetRefusal;
  process.stderr.write(`${refused ? 'refused' : 'failed'}: ${(e as Error).message}\n`);
  process.exit(1);
});
