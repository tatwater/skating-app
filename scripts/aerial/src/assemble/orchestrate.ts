/**
 * **The run row around a Machine's assembly** (B05 §2.6): the assembler runs on a Fly Machine, which
 * holds R2 credentials but no Convex key (Governor fork G-5), so the laptop keeps the `aerial_assemble`
 * row: it opens the row, starts the Machine (T's `spawn.sh assemble`), and follows the progress
 * object the Machine writes beside the shards — a heartbeat per zoom written — until the assembly
 * record lands or the Machine stops without one. Where the row may go is `runTarget.ts`' rule.
 */

import { NAIP_STATES } from '@skating/core';
import type { AssembleProgress, AssemblyRecord } from './assemble';

/**
 * **One write at a time, in order** — for the progress object the Machine rewrites under one key.
 * The assembler's index readers run concurrently and two can report at once (25 of 28, then 28),
 * and two `rclone rcat`s to the same key race: each checks the object it wrote and finds the other's
 * ("corrupted on transfer", the pilot's assembler, 2026-11-26). Each call waits for the one before
 * it; a failed write fails every later one, as an unserialized failure would have.
 */
export function oneAtATime<A>(write: (arg: A) => Promise<void>): (arg: A) => Promise<void> {
  let last: Promise<void> = Promise.resolve();
  return (arg) => {
    last = last.then(() => write(arg));
    return last;
  };
}

/**
 * The assembler's run scope (and verify's): the archive, the seven states, and the whole region —
 * except a pilot's, which builds a few dozen cells and must not read as a complete build (its rows
 * did, until the pilot, 2026-11-26).
 */
export function assembleScope(pilot: string | null): {
  pass: 'archive';
  states: (typeof NAIP_STATES)[number][];
  complete: boolean;
} {
  return { pass: 'archive', states: [...NAIP_STATES], complete: pilot === null };
}

/** The record as named counts for the run row (numbers only: rows carry counts, never lists). */
export function assemblyCounts(record: AssemblyRecord): Record<string, number> {
  return {
    archiveBytes: record.archive.bytes,
    indexBytes: record.cellIndex.bytes,
    indexGzipBytes: record.cellIndex.gzipBytes,
    manifestBytes: record.manifest.bytes,
    tilesAddressed: record.header.addressed,
    tileEntries: record.header.entries,
    tileContents: record.header.contents,
    leafDirectories: record.header.leaves,
    workTiles: record.workTiles.total,
    workTilesCut: record.workTiles.cut,
    workTilesCopied: record.workTiles.copied,
    workTilesEmpty: record.workTiles.empty,
    tilesCopied: record.copiedTiles,
    overviewTiles: record.overviews.length,
    cellsDated: record.cells.dated,
    flights: record.cells.flights,
    peakRssMb: Math.round(record.memory.peakRssBytes / 2 ** 20),
    ...Object.fromEntries(
      Object.entries(record.timings).map(([k, ms]) => [`${k}Seconds`, Math.round(ms / 1000)]),
    ),
    ...Object.fromEntries(Object.entries(record.perZoom).map(([z, n]) => [`zoom${z}Tiles`, n])),
  };
}

/** The progress object the Machine writes, `<build prefix>assembly-progress.json`. */
export interface ProgressObject {
  at: string;
  event: AssembleProgress;
}

/** The slice of `RunLogger` the follower drives. */
export interface Heartbeat {
  count(name: string, value: number): void;
  flush(): void;
}

/** Translate one progress event into the row's counts. */
export function beat(logger: Heartbeat, event: AssembleProgress): void {
  switch (event.step) {
    case 'indexes':
      logger.count('workTilesRead', event.done);
      logger.count('workTiles', event.total);
      break;
    case 'overviews':
      logger.count('overviewTiles', event.tiles);
      break;
    case 'layout':
      logger.count('tilesAddressed', event.tiles);
      logger.count('archiveBytes', event.bytes);
      break;
    case 'zoom':
      logger.count('zoomWriting', event.zoom);
      logger.count('bytesWritten', event.dataBytes);
      break;
    case 'published':
      logger.count('archiveBytes', event.archiveBytes);
      break;
  }
  logger.flush();
}

/** How often the laptop reads the progress object. */
export const FOLLOW_INTERVAL_MS = 30_000;

/**
 * **The laptop's quiet limit**: this long of reading the bucket with no new progress event, while
 * `spawn.sh` still sees the Machine up, is an assembly that has stopped moving. Sized against the
 * Machine's beat (`HEARTBEAT_MS`, five minutes inside a zoom; the longest step between events, the
 * overviews, is about a minute at region scale) and above the Machine's own watchdog
 * ({@link MACHINE_STALL_MS}), so a stuck Machine normally stops itself first and says why.
 */
export const FOLLOW_QUIET_MS = 30 * 60_000;

/**
 * A gap between two polls longer than this is the laptop asleep (or a call that hung), never quiet
 * the Machine kept: the quiet clock counts only time the laptop was awake and reading.
 */
export const FOLLOW_GAP_MS = 4 * FOLLOW_INTERVAL_MS;

/** Reads of the record, an interval apart, once the Machine has gone and the bucket won't answer. */
export const LATE_READS = 10;

/**
 * **The Machine's own watchdog**: an assembler that has emitted no progress event for this long
 * writes its error object and exits, so a stuck read or upload frees its Machine (and the cap's
 * slot) instead of idling until someone looks — and a re-run never attaches to a corpse.
 */
export const MACHINE_STALL_MS = 20 * 60_000;

/**
 * Read a bucket object for the follower: the parsed value, `null` when it isn't there, and a throw
 * when the bucket can't be reached — which the follower never counts as the Machine's silence.
 * `read` is `rclone cat`; rclone says a key isn't there with exit 3 or 4 ("directory not found",
 * "file not found"), or, on some backends, with nothing at all.
 */
export async function readObject<T>(read: () => Promise<string>): Promise<T | null> {
  let text: string;
  try {
    text = await read();
  } catch (e) {
    if (/exited [34]\b|not found/i.test((e as Error).message)) return null;
    throw e;
  }
  if (text.trim() === '') return null;
  return JSON.parse(text) as T;
}

/** What a non-zero exit of `spawn.sh assemble` means for the assembly. */
export function spawnExitMessage(code: number | null): string {
  if (code === 3) {
    return 'spawn.sh stopped waiting for the assembler Machine, which is still up: far past any healthy assembly — read its logs (fly logs --app skating-imagery) and stop it before running the stage again';
  }
  return `spawn.sh exited ${code ?? 'on a signal'} before the assembler Machine finished (see its output above): no assembler may be running`;
}

/**
 * Follow a Machine's assembly: poll `readProgress` every `intervalMs`, beat on each new event, and
 * resolve with the record once `readRecord` finds it. Rejects when `machineDone` reports the Machine
 * stopped with no record (or throws: `spawn.sh` failed), or after `quietMs` of quiet.
 *
 * **Quiet is counted only while the laptop is awake and reading** (PR #188's review). A read that
 * throws — the bucket unreachable: a network blip, the laptop waking — and a gap between polls past
 * `gapMs` — the laptop asleep — add nothing to it, so losing the event stream never fails a live
 * assembly; whether the Machine is still up is `spawn.sh`'s answer (`machineDone`), from Fly's own
 * list, which reads a failed listing as "still up". Only a Machine Fly lists as up, whose progress
 * the laptop can read and which hasn't moved for `quietMs`, is called stuck.
 */
export async function followAssembly(args: {
  readProgress: () => Promise<ProgressObject | null>;
  readRecord: () => Promise<AssemblyRecord | null>;
  machineDone: () => Promise<boolean>;
  logger: Heartbeat;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  intervalMs?: number;
  quietMs?: number;
  gapMs?: number;
}): Promise<AssemblyRecord> {
  const interval = args.intervalMs ?? FOLLOW_INTERVAL_MS;
  const limit = args.quietMs ?? FOLLOW_QUIET_MS;
  const maxGap = args.gapMs ?? FOLLOW_GAP_MS;
  let lastAt = '';
  let quiet = 0;
  let before = args.now();
  for (;;) {
    let reached = true;
    let moved = false;
    try {
      const record = await args.readRecord();
      if (record !== null) return record;
      const progress = await args.readProgress();
      if (progress !== null && progress.at !== lastAt) {
        lastAt = progress.at;
        moved = true;
        beat(args.logger, progress.event);
      }
    } catch {
      reached = false;
    }
    const at = args.now();
    const gap = at - before;
    before = at;
    if (moved) quiet = 0;
    else if (reached && gap <= maxGap) quiet += gap;
    if (await args.machineDone()) {
      // The record is the last write; read once more in case it landed as the Machine stopped —
      // and a bucket that can't be read then says nothing about how the Machine ended.
      for (let tries = 1; ; tries++) {
        try {
          const late = await args.readRecord();
          if (late !== null) return late;
          break;
        } catch {
          if (tries >= LATE_READS) {
            throw new Error(
              'the assembler Machine has gone and the bucket can’t be read to say how it ended: run the stage again once it can (a finished assembly is taken from its record, never run twice)',
            );
          }
          await args.sleep(interval);
        }
      }
      throw new Error(
        'the assembler Machine stopped without an assembly record: it refused or failed (see its logs)',
      );
    }
    if (quiet > limit) {
      throw new Error(
        `no progress from the assembler for ${Math.round(limit / 60_000)} minutes while its Machine is still up: it is stuck — read its logs (fly logs --app skating-imagery), stop it, and run the stage again`,
      );
    }
    await args.sleep(interval);
  }
}

/**
 * The Machine's watchdog ({@link MACHINE_STALL_MS}): `touch` on every progress event; `onStall` runs
 * once when `stallMs` passes with none. Timers injectable for the tests (vitest's fake ones).
 */
export function stallWatch(args: {
  stallMs?: number;
  onStall: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): { touch(): void; stop(): void } {
  const ms = args.stallMs ?? MACHINE_STALL_MS;
  const set = args.setTimer ?? ((fn, wait) => setTimeout(fn, wait));
  const clear = args.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let handle: unknown = null;
  let stopped = false;
  const arm = (): void => {
    if (handle !== null) clear(handle);
    // `stop` clears a pending timer, so one that fires finds the watch live.
    handle = set(() => {
      handle = null;
      stopped = true;
      args.onStall();
    }, ms);
  };
  arm();
  return {
    touch() {
      if (!stopped) arm();
    },
    stop() {
      stopped = true;
      if (handle !== null) clear(handle);
      handle = null;
    },
  };
}
