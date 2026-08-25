/**
 * Bake the season's reveal masks into one spatially-indexed file (N6e PR 2a, D148).
 *
 *   pnpm --filter @skating/imagery bake-masks [--batch=25] [--season=2026]
 *     [--out=<path>] [--upload] [--bucket=skating-imagery]
 *
 * Reads every corpus body and its access points, buffers each through `revealShape`, and writes a
 * **FlatGeobuf** the granule cutter clips against.
 *
 * ## Why FlatGeobuf and not the GeoJSON everything else here emits
 *
 * The corpus is ~25,000 buffered shapes — call it 150 MB of GeoJSON — and roughly a thousand granule
 * jobs a season each need *the handful of bodies their own granule covers*. GeoJSON gives a reader no
 * way to ask that question: it would download and parse the whole file to find sixty lakes, once per
 * job.
 *
 * FlatGeobuf carries a packed Hilbert R-tree in the file itself, and GDAL knows how to use it over
 * HTTP range requests — so `ogr2ogr -spat ...` against a `/vsicurl/` URL fetches the index and then
 * only the features that intersect. Same artifact, same one upload, and a job reads megabytes instead
 * of hundreds.
 *
 * The alternative considered and dropped was splitting the masks into one file per Sentinel MGRS tile
 * (a granule id carries its tile — `S2C_18TXP_20260215`). That works, and it means maintaining a
 * tiling scheme, a naming convention and a story for bodies that straddle two tiles. The spatial index
 * answers the same question without any of it.
 *
 * ## Season, and why the file is named for one
 *
 * The masks change when the *corpus* changes — a new lake, a moderator's redraw, a put-in — not when
 * the weather does. Naming the artifact for a season (D63's key, `winter-2026-27`) is therefore not a
 * claim that it expires in July; it is so that an archive built last winter can be reproduced against
 * the geometry it was actually cut with, rather than against whatever the corpus looks like today.
 *
 * Thin glue over `revealMasks` and two subprocesses; excluded from coverage, like the sibling CLIs.
 */

import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { archiveSeasonLabel, currentSeason, SENTINEL_MASK_METERS } from '@skating/core';
import { scanCorpusMasks } from './corpus';
import { emptyTally, maskFeatureFor, recordOutcome } from './revealMasks';

// `fileURLToPath`, never `new URL(...).pathname` — the latter hands back a percent-encoded path, so
// a checkout under a directory with a space in it resolves `.scratch` to somewhere that isn't there.
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(HERE, '..', '.scratch');

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}
const has = (name: string) => process.argv.includes(`--${name}`);

function need(binary: string, install: string): void {
  try {
    execFileSync(binary, ['--version'], { stdio: 'ignore' });
  } catch {
    console.error(`[bake-masks] ${binary} not found — ${install}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const batchSize = Number(flag('batch') ?? 25);
  const season = Number(flag('season') ?? currentSeason(Date.now()));
  const label = archiveSeasonLabel(season);

  need('ogr2ogr', 'brew install gdal');

  mkdirSync(SCRATCH, { recursive: true });
  const seqPath = join(SCRATCH, `masks-${label}.geojsonl`);
  const fgbPath = flag('out') ?? join(SCRATCH, `masks-${label}.fgb`);

  console.error(`[bake-masks] season ${label}, batch ${batchSize}`);

  // `--limit` stops after N masks. For smoke-testing the pipeline end to end without a full corpus
  // scan — the artifact it produces covers a fraction of the region and must never be uploaded.
  const limitFlag = flag('limit');
  const limit = limitFlag === undefined ? Infinity : Number(limitFlag);

  // Streamed a line at a time. Buffering 25,000 buffered polygons to build one JSON string is how a
  // bake turns into an out-of-memory crash on the largest corpus we have.
  const fd = openSync(seqPath, 'w');
  let tally = emptyTally();
  try {
    for await (const row of scanCorpusMasks(batchSize, (p) => {
      if (p.pages % 40 === 0) {
        console.error(
          `[bake-masks]   scanned ${p.scanned} (${p.belowFloor} below floor, ${p.unlisted} delisted)…`,
        );
      }
    })) {
      const outcome = maskFeatureFor(row);
      tally = recordOutcome(tally, outcome);
      if (outcome.ok) writeSync(fd, `${JSON.stringify(outcome.feature)}\n`);
      if (tally.masked >= limit) {
        console.error(`[bake-masks] stopping at --limit=${limit} — PARTIAL, do not upload`);
        break;
      }
    }
  } finally {
    closeSync(fd);
  }

  if (tally.masked === 0) {
    // Fail rather than upload an empty mask file. An archive cut against zero masks is not an empty
    // archive — every granule would clip to nothing, and the scrubber would come up blank with no
    // error anywhere to explain it.
    console.error('[bake-masks] FATAL: no masks produced — refusing to write an empty artifact');
    process.exit(1);
  }

  // GeoJSONSeq → FlatGeobuf. The index is built on write, which is the whole reason for the format.
  //
  // ⚠ **Unlink first; `-overwrite` does not work here.** The FlatGeobuf driver has no `DeleteLayer`,
  // so ogr2ogr fails with "DeleteLayer() not supported by this dataset" the moment the target exists
  // — which means a *first* run succeeds and every run after it dies. Found the expensive way: a full
  // 25,000-body scan ran for forty minutes and then threw this away at the final command.
  rmSync(fgbPath, { force: true });
  execFileSync('ogr2ogr', ['-f', 'FlatGeobuf', fgbPath, seqPath, '-nln', 'reveal_masks'], {
    stdio: 'inherit',
  });

  // The sidecar the container reads, and the reason it exists.
  //
  // `cut-granule` needs `SENTINEL_MASK_METERS.feather` to size its distance transform, and that
  // constant lives in `@skating/core` — TypeScript, which the GDAL image is not. Hardcoding 240 in
  // the shell would be a second copy of a tuned number, and the failure of the two drifting apart is
  // invisible: the archive would simply feather over a different distance than the web client does,
  // on lakes nobody is looking at side by side.
  //
  // Shipping it *with the masks* means the container can never read a feather that disagrees with
  // the geometry it was baked against. The two travel as one artifact or not at all.
  const sidecar = {
    season: label,
    solidMeters: SENTINEL_MASK_METERS.solid,
    featherMeters: SENTINEL_MASK_METERS.feather,
    bodies: tally.masked,
    omitted: tally.omitted,
  };
  // ⚠ **Append rather than substitute when `--out` has no `.fgb` suffix.** A bare `.replace()` is a
  // no-op on `--out=/tmp/masks`, which makes `sidecarPath === fgbPath` — and the `writeFileSync`
  // below would then overwrite the FlatGeobuf that a forty-minute corpus scan just produced, with a
  // five-line JSON, silently.
  const sidecarPath = fgbPath.endsWith('.fgb')
    ? fgbPath.replace(/\.fgb$/, '.json')
    : `${fgbPath}.json`;
  writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

  console.error('');
  console.error(`[bake-masks] masked   ${tally.masked}`);
  console.error(`[bake-masks] omitted  ${tally.omitted}`, tally.omitted ? tally.byReason : '');
  for (const omission of tally.omissions) {
    console.error(
      `[bake-masks]   - ${omission.name ?? '(unnamed)'} ${omission.waterBodyId} — ${omission.reason}`,
    );
  }
  if (tally.omitted > tally.omissions.length) {
    console.error(`[bake-masks]   … and ${tally.omitted - tally.omissions.length} more`);
  }
  console.error(`[bake-masks] wrote ${fgbPath}`);
  console.error(
    `[bake-masks] wrote ${sidecarPath} (solid ${sidecar.solidMeters} m, feather ${sidecar.featherMeters} m)`,
  );

  if (has('upload')) {
    if (Number.isFinite(limit)) {
      // A partial bake published under the season's real key would be indistinguishable from a good
      // one, and every granule cut against it would silently drop most of the region.
      console.error('[bake-masks] FATAL: refusing to upload a --limit run');
      process.exit(1);
    }
    const bucket = flag('bucket') ?? 'skating-imagery';
    const key = `masks/${label}.fgb`;
    need('rclone', 'brew install rclone');
    // `--s3-no-check-bucket` for the same reason every other upload here passes it: our R2 tokens are
    // bucket-scoped and 403 on the account-level HeadBucket probe rclone runs by default.
    for (const [from, to] of [
      [fgbPath, key],
      [sidecarPath, key.replace(/\.fgb$/, '.json')],
    ]) {
      execFileSync(
        'rclone',
        ['copyto', from as string, `r2:${bucket}/${to}`, '--s3-no-check-bucket', '--progress'],
        { stdio: 'inherit' },
      );
      console.error(`[bake-masks] uploaded r2:${bucket}/${to}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error('[bake-masks] FATAL:', error instanceof Error ? error.message : error);
  process.exit(1);
});
