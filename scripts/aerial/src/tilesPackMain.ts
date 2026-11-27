/**
 * The worker's TypeScript entry point, run inside the Machine by `cut-aerial.sh` (and by the local
 * warp proof): three subcommands over `tilesPack.ts` and `tiles.ts`, each reading and writing files
 * so the shell never parses or builds JSON beyond picking fields out of the unit.
 *
 * ```text
 * tilesPackMain.ts layers --unit <unit.json> --counts <dir>
 *     the mosaic's sources, bottom to top, one `<cellKey>\t<itemId>\t<rank>\t<window>` a line —
 *     `<window>` empty for a frame drawn over its cell, `minX minY maxX maxY` for one drawn only there
 * tilesPackMain.ts pack --unit <unit.json> --tiles <dir> --counts <dir> --timings <file> --out <dir>
 *                       --image <ref@sha256:…>
 *     <out>/shard.pack, shard.idx.json, shard.done.json
 * tilesPackMain.ts unit --spec <spec.json>
 *     a work unit from explicit outlines (the local proof's windows), on stdout
 * ```
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { tileIdToZxy } from 'pmtiles';
import { type AerialWorkUnit, buildWorkUnit, WORK_UNIT_VERSION } from './tiles';
import {
  buildDone,
  bytesByZoom,
  listTiles,
  mosaicLayers,
  readCellCounts,
  readCellWindows,
  writeShard,
} from './tilesPack';

/** What `main` writes to, injectable for tests. */
export interface MainIo {
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
}

const defaultIo: MainIo = {
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  now: () => new Date(),
};

class UsageError extends Error {}

function flags(argv: readonly string[], allowed: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i] as string;
    const value = argv[i + 1];
    if (!name.startsWith('--') || !allowed.includes(name.slice(2))) {
      throw new UsageError(`unexpected argument ${name}`);
    }
    if (value === undefined || value.startsWith('--'))
      throw new UsageError(`${name} needs a value`);
    map.set(name.slice(2), value);
  }
  for (const name of allowed) if (!map.has(name)) throw new UsageError(`--${name} is required`);
  return map;
}

/** A unit file, checked for the version this code reads. */
export function readUnit(path: string): AerialWorkUnit {
  const unit = JSON.parse(readFileSync(path, 'utf8')) as AerialWorkUnit;
  if (unit.version !== WORK_UNIT_VERSION) {
    throw new Error(
      `work unit version ${String(unit.version)}, this worker reads ${WORK_UNIT_VERSION}`,
    );
  }
  return unit;
}

/** The proof's spec: a unit's fields with each cell's outline given rather than computed. */
interface UnitSpecFile {
  campaign: string;
  pilot: string | null;
  workTile: string;
  window?: string;
  inputHash?: string;
  cells: { key: string; outline: [number, number, number, number]; frames: string[] }[];
}

export function main(argv: readonly string[], io: MainIo = defaultIo): number {
  const [command, ...rest] = argv;
  try {
    if (command === 'layers') {
      const f = flags(rest, ['unit', 'counts']);
      const unit = readUnit(f.get('unit') as string);
      const dir = f.get('counts') as string;
      const counts = readCellCounts(dir, unit);
      for (const l of mosaicLayers(unit, counts, readCellWindows(dir, unit, counts))) {
        io.out(`${l.cell}\t${l.itemId}\t${l.rank}\t${l.window?.join(' ') ?? ''}`);
      }
      return 0;
    }
    if (command === 'pack') {
      const f = flags(rest, ['unit', 'tiles', 'counts', 'timings', 'out', 'image']);
      const image = f.get('image') as string;
      const unit = readUnit(f.get('unit') as string);
      const out = f.get('out') as string;
      const shard = writeShard(unit, listTiles(f.get('tiles') as string), join(out, 'shard.pack'));
      const timings = JSON.parse(readFileSync(f.get('timings') as string, 'utf8')) as Record<
        string,
        number
      >;
      const done = buildDone(unit, shard, {
        image,
        timings,
        cellCounts: readCellCounts(f.get('counts') as string, unit),
        finishedAt: io.now().toISOString(),
      });
      writeFileSync(join(out, 'shard.idx.json'), `${JSON.stringify(shard.index)}\n`);
      writeFileSync(join(out, 'shard.done.json'), `${JSON.stringify(done)}\n`);
      const zooms = bytesByZoom(shard.index, (id) => tileIdToZxy(id)[0]);
      io.out(`packed ${done.tiles} tiles, ${done.bytes} bytes`);
      for (const [z, row] of Object.entries(zooms)) {
        io.out(`  z${z}: ${row.tiles} tiles, ${row.bytes} bytes`);
      }
      return 0;
    }
    if (command === 'unit') {
      const f = flags(rest, ['spec']);
      const spec = JSON.parse(readFileSync(f.get('spec') as string, 'utf8')) as UnitSpecFile;
      const outlines = new Map(spec.cells.map((c) => [c.key, c.outline]));
      const unit = buildWorkUnit(
        {
          campaign: spec.campaign,
          pilot: spec.pilot,
          workTile: spec.workTile,
          ...(spec.window !== undefined && { window: spec.window }),
          // A proof's unit is never reconciled, so any stable name for its inputs will do.
          inputHash:
            spec.inputHash ?? createHash('sha256').update(JSON.stringify(spec.cells)).digest('hex'),
          cells: spec.cells,
        },
        (key) => {
          const [minLng, minLat, maxLng, maxLat] = outlines.get(key) as [
            number,
            number,
            number,
            number,
          ];
          return { minLng, minLat, maxLng, maxLat };
        },
      );
      io.out(JSON.stringify(unit));
      return 0;
    }
    throw new UsageError(`unknown command ${JSON.stringify(command ?? '')}: layers, pack or unit`);
  } catch (e) {
    io.err(`tilesPackMain: ${(e as Error).message}`);
    return e instanceof UsageError ? 64 : 1;
  }
}

// Run as a script (`tsx src/tilesPackMain.ts …`), not when imported by a test.
if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
