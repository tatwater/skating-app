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
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import {
  buildSeasonIndex,
  type FrameManifest,
  latestSeasonWithFrames,
  type SeasonIndex,
} from './frameIndex';

const HERE = dirname(new URL(import.meta.url).pathname);
const SCRATCH = join(HERE, '..', '.scratch');

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}
const has = (name: string) => process.argv.includes(`--${name}`);

function rclone(args: string[]): string {
  return execFileSync('rclone', [...args, '--s3-no-check-bucket'], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
}

function main(): void {
  const bucket = flag('bucket') ?? 'skating-imagery';
  const dryRun = has('dry-run');

  // `lsf -R` over the frames prefix. Manifests only — the .pmtiles beside each one is the payload and
  // listing it would double the work for nothing.
  const listing = rclone(['lsf', '-R', `r2:${bucket}/frames/`])
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('.json'));

  if (listing.length === 0) {
    console.error('[build-index] no frame manifests in the bucket — nothing to index');
    process.exit(1);
  }
  console.error(`[build-index] ${listing.length} manifest(s) under frames/`);

  const manifests: FrameManifest[] = [];
  const unreadable: string[] = [];
  for (const relative of listing) {
    try {
      manifests.push(
        JSON.parse(rclone(['cat', `r2:${bucket}/frames/${relative}`])) as FrameManifest,
      );
    } catch {
      // Counted rather than thrown on: one corrupt manifest out of 750 should cost its own frame, not
      // the whole index. It is reported below so the number cannot hide.
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
