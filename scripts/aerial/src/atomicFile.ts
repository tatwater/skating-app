/**
 * **A file written whole or not at all** (PR #188's ninth review). The package's scratch holds files
 * no campaign owns — the kept thumbnails (`.scratch/thumbs/`) and the score caches
 * (`.scratch/scores.json`, `.scratch/foliage-scores.json`) — that two campaigns' stages, under two
 * different locks, read and write at once; and the kept catalog walk, which a crash mid-write would
 * leave torn. A plain `writeFileSync` truncates and then writes, so a reader in between sees part of
 * a file. Here the bytes go to a private file beside the target (same directory, so the same
 * filesystem) and are renamed over it: a reader sees the old file or the new one, never a mix.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Writes `data` to `path` atomically (its directory created on demand). */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const part = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.part`);
  try {
    writeFileSync(part, data);
    renameSync(part, path);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
}
