/**
 * Build the archive's table of contents from what is actually in the bucket (N6e §C2, D149).
 *
 *   pnpm --filter @skating/imagery build-index [--bucket=skating-imagery] [--dry-run]
 *
 * Writes `index/<season>.json` for every season that has frames, plus `index/latest.json` — the
 * pointer that *is* D149's turnover.
 *
 * ## Built by listing, never by remembering
 *
 * The index is derived from the manifests in R2 rather than from anything this process knew before it
 * started. That is deliberate: a fan-out is 750 independent Machines, some of which will have failed,
 * and an index assembled from the list of granules we *intended* to cut would claim frames that are
 * not there. Listing the bucket cannot make that mistake — if the object is absent, so is the entry.
 *
 * Thin glue over `frameIndex` and rclone; excluded from coverage, like the sibling CLIs.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { latestSeasonWithFrames, type SeasonIndex } from '@skating/core';
import { flag, has, SCRATCH } from './cli';
import { buildSeasonIndex, type FrameManifest } from './frameIndex';

function rclone(args: string[]): string {
  return execFileSync('rclone', [...args, '--s3-no-check-bucket'], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
}

/** Every `.json` under `dir`, as paths relative to it. */
function jsonFilesUnder(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...jsonFilesUnder(join(dir, entry.name), relative));
    else if (entry.name.endsWith('.json')) out.push(relative);
  }
  return out;
}

function main(): void {
  const bucket = flag('bucket') ?? 'skating-imagery';
  const dryRun = has('dry-run');

  // ⚠ **One `rclone copy`, not one `rclone cat` per manifest, and the reason is correctness before
  // it is speed.**
  //
  // Nine seasons is ~6,750 manifests. Spawning a process and opening a TLS connection for each one
  // spends minutes of handshakes on kilobytes of JSON — but the worse half is the failure mode: a
  // per-object `cat` has to be wrapped in a `try`, and that `try` cannot tell a corrupt manifest
  // from a network blip. A blip then drops a frame that is sitting in the bucket right now, and the
  // index — the thing this whole file exists to make trustworthy, the check a fan-out is verified
  // against — quietly claims fewer frames than landed, and exits 0 while doing it.
  //
  // One copy fails loudly and completely, which is the only honest answer for a table of contents.
  // Manifests only: the .pmtiles beside each one is the payload and pulling it would move gigabytes.
  const staged = mkdtempSync(join(tmpdir(), 'imagery-index-'));
  process.on('exit', () => rmSync(staged, { recursive: true, force: true }));
  rclone(['copy', `r2:${bucket}/frames/`, staged, '--include', '*.json', '--transfers', '16']);

  const listing = jsonFilesUnder(staged);
  if (listing.length === 0) {
    console.error('[build-index] no frame manifests in the bucket — nothing to index');
    process.exit(1);
  }
  console.error(`[build-index] ${listing.length} manifest(s) under frames/`);

  const manifests: FrameManifest[] = [];
  const unreadable: string[] = [];
  for (const relative of listing) {
    try {
      manifests.push(JSON.parse(readFileSync(join(staged, relative), 'utf8')) as FrameManifest);
    } catch {
      // Now unambiguously *corrupt*, because the bytes are already on local disk — the transport
      // failed the copy above or it did not fail at all. One bad manifest out of 750 costs its own
      // frame rather than the whole index, and it is reported below so the number cannot hide.
      unreadable.push(relative);
    }
  }

  const seasons = [...new Set(manifests.map((m) => m.season))].sort();
  const indexes: SeasonIndex[] = seasons.map((season) => buildSeasonIndex(season, manifests));
  const latest = latestSeasonWithFrames(indexes);

  mkdirSync(SCRATCH, { recursive: true });
  for (const index of indexes) {
    const path = join(SCRATCH, `index-${index.season}.json`);
    writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`);
    console.error(
      `[build-index] ${index.season}: ${index.frames.length} frame(s)` +
        (index.firstCapturedAt
          ? ` ${index.firstCapturedAt.slice(0, 10)} → ${index.lastCapturedAt?.slice(0, 10)}`
          : ''),
    );
    if (!dryRun) rclone(['copyto', path, `r2:${bucket}/index/${index.season}.json`]);
  }

  if (!latest) {
    console.error('[build-index] no season has frames — refusing to write latest.json');
    process.exit(1);
  }
  const latestPath = join(SCRATCH, 'index-latest.json');
  writeFileSync(latestPath, `${JSON.stringify({ season: latest }, null, 2)}\n`);
  if (!dryRun) rclone(['copyto', latestPath, `r2:${bucket}/index/latest.json`]);

  console.error('');
  console.error(`[build-index] latest → ${latest}`);
  if (unreadable.length > 0) {
    console.error(`[build-index] ⚠ ${unreadable.length} unreadable manifest(s):`);
    for (const u of unreadable.slice(0, 10)) console.error(`[build-index]   - ${u}`);
  }
  if (dryRun) console.error('[build-index] --dry-run: nothing uploaded');
}

try {
  main();
} catch (error: unknown) {
  console.error('[build-index] FATAL:', error instanceof Error ? error.message : error);
  process.exit(1);
}
