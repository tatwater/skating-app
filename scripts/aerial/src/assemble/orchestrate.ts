/**
 * **The run row around a Machine's assembly** (B05 §2.6): the assembler runs on a Fly Machine, which
 * holds R2 credentials but no Convex key (Governor fork G-5), so the laptop keeps the `aerial_assemble`
 * row: it opens the row, starts the Machine (T's `spawn.sh assemble`), and follows the progress
 * object the Machine writes beside the shards — a heartbeat per zoom written — until the assembly
 * record lands or the Machine stops without one. Where the row may go is `runTarget.ts`' rule.
 */

import { NAIP_STATES } from '@skating/core';
import type { AssembleProgress, AssemblyRecord } from './assemble';

/** The assembler's run scope: the archive, the seven states, the whole region. */
export const ASSEMBLE_SCOPE = {
  pass: 'archive' as const,
  states: [...NAIP_STATES],
  complete: true,
};

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

/**
 * Follow a Machine's assembly: poll `readProgress` every `intervalMs`, beat on each new event, and
 * resolve with the record once `readRecord` finds it. Rejects when `machineDone` reports the Machine
 * stopped with no record, or after `timeoutMs` without a new event.
 */
export async function followAssembly(args: {
  readProgress: () => Promise<ProgressObject | null>;
  readRecord: () => Promise<AssemblyRecord | null>;
  machineDone: () => Promise<boolean>;
  logger: Heartbeat;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  intervalMs?: number;
  timeoutMs?: number;
}): Promise<AssemblyRecord> {
  const interval = args.intervalMs ?? 30_000;
  const timeout = args.timeoutMs ?? 3_600_000;
  let lastAt = '';
  let lastChange = args.now();
  for (;;) {
    const record = await args.readRecord();
    if (record !== null) return record;
    const progress = await args.readProgress();
    if (progress !== null && progress.at !== lastAt) {
      lastAt = progress.at;
      lastChange = args.now();
      beat(args.logger, progress.event);
    }
    if (await args.machineDone()) {
      // The record is the last write; read once more in case it landed as the Machine stopped.
      const late = await args.readRecord();
      if (late !== null) return late;
      throw new Error(
        'the assembler Machine stopped without an assembly record: it refused or failed (see its logs)',
      );
    }
    if (args.now() - lastChange > timeout) {
      throw new Error(`no progress from the assembler for ${Math.round(timeout / 60_000)} minutes`);
    }
    await args.sleep(interval);
  }
}
