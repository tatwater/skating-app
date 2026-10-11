/**
 * The argv and scratch-path plumbing every CLI in this package had its own copy of (A06e PR 2).
 *
 * Four entry points — `bakeMasks`, `selectGranules`, `ingestWindowCli`, `buildIndex` — each carried
 * an identical `flag()`, an identical `has()`, an identical `HERE`/`SCRATCH` pair, and two of them
 * carried near-identical `findLatestMasks()` implementations that differed only in the wording of
 * the error they throw. That is four places for `--masks=` to start meaning something slightly
 * different, on a pipeline whose whole failure mode is two halves quietly disagreeing about which
 * artifact they are looking at.
 *
 * Excluded from coverage with the CLIs it serves: this is argv parsing and a `readdir`, and the
 * decisions live in `granuleSelection`, `revealMasks`, `frameIndex` and `tileSurvey`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// `fileURLToPath`, never `new URL(...).pathname` — the latter hands back a percent-encoded path, so
// a checkout under a directory with a space in it resolves `.scratch` to somewhere that isn't there.
const HERE = dirname(fileURLToPath(import.meta.url));

/** Where every artifact in this package is staged before it is uploaded. Gitignored. */
export const SCRATCH = join(HERE, '..', '.scratch');

/** `--name=value` → `value`, or `undefined` when the flag is absent. */
export function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

/** Is the bare `--name` switch present? */
export function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * The most recent mask bake in `.scratch`, so the common case needs no flags.
 *
 * Sorted by name rather than mtime: the names carry the season (`masks-winter-2026-27.fgb`) and sort
 * correctly, while mtime would prefer whichever file was last *touched* — which after a re-download
 * or a `cp -r` is not the newest season.
 */
export function findLatestMasks(): string {
  if (!existsSync(SCRATCH)) {
    throw new Error('no .scratch — pass --masks=<path.fgb> or run bake-masks first');
  }
  const found = readdirSync(SCRATCH)
    .filter((f) => f.startsWith('masks-') && f.endsWith('.fgb'))
    .sort();
  const latest = found[found.length - 1];
  if (!latest) {
    throw new Error('no mask file in .scratch — pass --masks=<path.fgb> or run bake-masks first');
  }
  return join(SCRATCH, latest);
}

/**
 * The mask file's own extent, via `ogrinfo` — the STAC search box. Shared by `select-granules` and
 * `publish-search-plan` (A06i), so the box a backfill searches and the one the live poll searches
 * are read the same way from the same file.
 */
export function maskExtent(fgbPath: string): [number, number, number, number] {
  const out = execFileSync('ogrinfo', ['-so', '-al', fgbPath], { encoding: 'utf8' });
  const match = /Extent:\s*\(([-\d.]+),\s*([-\d.]+)\)\s*-\s*\(([-\d.]+),\s*([-\d.]+)\)/.exec(out);
  if (!match) throw new Error(`could not read an extent from ${fgbPath}`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}
