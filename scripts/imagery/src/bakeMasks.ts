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
import { join } from 'node:path';
import process from 'node:process';

import { archiveSeasonLabel, currentSeason, SENTINEL_MASK_METERS } from '@skating/core';
import { flag, has, SCRATCH } from './cli';
import { scanCorpusMasks, scanCorpusSubAreas } from './corpus';
import { emptyTally, maskFeatureFor, recordOutcome } from './revealMasks';

/**
 * Swap a `.fgb` suffix for another, or append when there is none.
 *
 * ⚠ **Append rather than substitute, and that is not tidiness.** A bare `.replace()` is a no-op on
 * `--out=/tmp/masks`, which would make the sidecar path equal the FlatGeobuf path — and the
 * `writeFileSync` below would then overwrite the artifact a forty-minute corpus scan just produced
 * with five lines of JSON, silently. The same hazard applies to the water file's path.
 */
function suffixed(fgbPath: string, suffix: string): string {
  return fgbPath.endsWith('.fgb') ? fgbPath.replace(/\.fgb$/, suffix) : `${fgbPath}${suffix}`;
}

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
  // The second artifact, and it is a second *file* rather than a second layer because FlatGeobuf is
  // single-layer by construction. Named by suffixing the reveal's path so `--out` still works.
  const waterSeqPath = join(SCRATCH, `masks-${label}-water.geojsonl`);
  const waterFgbPath = suffixed(fgbPath, '-water.fgb');
  // The third artifact: sub-areas, for the second zone grid. See `listSubAreasForImageryMask` for
  // why a bay cannot share a raster with the lake it sits inside.
  const subAreaSeqPath = join(SCRATCH, `masks-${label}-subareas.geojsonl`);
  const subAreaFgbPath = suffixed(fgbPath, '-subareas.fgb');

  console.error(`[bake-masks] season ${label}, batch ${batchSize}`);

  // `--limit` stops after N masks. For smoke-testing the pipeline end to end without a full corpus
  // scan — the artifact it produces covers a fraction of the region and must never be uploaded.
  const limitFlag = flag('limit');
  const limit = limitFlag === undefined ? Infinity : Number(limitFlag);

  // Streamed a line at a time. Buffering 25,000 buffered polygons to build one JSON string is how a
  // bake turns into an out-of-memory crash on the largest corpus we have.
  //
  // ⚠ **Both files are written from the same outcome, in the same loop.** Two passes over the corpus
  // would be two chances for the artifacts to disagree about which bodies exist, and a body pictured
  // but not measured (or measured but not pictured) is silent in both directions.
  const fd = openSync(seqPath, 'w');
  const waterFd = openSync(waterSeqPath, 'w');
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
      if (outcome.ok) {
        writeSync(fd, `${JSON.stringify(outcome.feature)}\n`);
        writeSync(waterFd, `${JSON.stringify(outcome.waterFeature)}\n`);
      }
      if (tally.masked >= limit) {
        console.error(`[bake-masks] stopping at --limit=${limit} — PARTIAL, do not upload`);
        break;
      }
    }
  } finally {
    closeSync(fd);
    closeSync(waterFd);
  }

  if (tally.masked === 0) {
    // Fail rather than upload an empty mask file. An archive cut against zero masks is not an empty
    // archive — every granule would clip to nothing, and the scrubber would come up blank with no
    // error anywhere to explain it.
    console.error('[bake-masks] FATAL: no masks produced — refusing to write an empty artifact');
    process.exit(1);
  }

  // ## Sub-areas, read after the bodies and written the same way
  //
  // ⚠ **Skipped entirely under `--limit`.** A partial body bake with a COMPLETE sub-area file would
  // pair bays against parents that are not in the artifact, which is a shape of inconsistency no
  // count would reveal — and `--limit` runs are smoke tests that must never be uploaded anyway.
  let subAreaCount = 0;
  if (!Number.isFinite(limit)) {
    const subFd = openSync(subAreaSeqPath, 'w');
    try {
      for await (const row of scanCorpusSubAreas(batchSize)) {
        writeSync(
          subFd,
          `${JSON.stringify({
            type: 'Feature',
            geometry: row.polygon,
            properties: {
              subAreaId: row.subAreaId,
              waterBodyId: row.waterBodyId,
              name: row.name,
            },
          })}\n`,
        );
        subAreaCount++;
      }
    } finally {
      closeSync(subFd);
    }
    console.error(`[bake-masks] sub-areas ${subAreaCount}`);
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
  rmSync(waterFgbPath, { force: true });
  execFileSync('ogr2ogr', ['-f', 'FlatGeobuf', waterFgbPath, waterSeqPath, '-nln', 'water_masks'], {
    stdio: 'inherit',
  });
  if (subAreaCount > 0) {
    rmSync(subAreaFgbPath, { force: true });
    execFileSync(
      'ogr2ogr',
      ['-f', 'FlatGeobuf', subAreaFgbPath, subAreaSeqPath, '-nln', 'sub_area_masks'],
      { stdio: 'inherit' },
    );
  }

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
    // Recorded beside the geometry it describes, so a frame cut months later can say whether the
    // radar correction had the input it needed. See `BakeTally.withElevation`.
    withElevation: tally.withElevation,
    // How many sub-areas ride with this bake. The cutter reads it to decide whether to look for the
    // third file at all, so a corpus with no sub-areas costs nothing rather than 404ing per granule.
    subAreas: subAreaCount,
    // ⚠ **The flag the cutter refuses to run without.** Bakes before 2026-08-25 shipped one file, and
    // `cut-granule.sh` rasterised the reveal shape as its zone grid — which measured a 60 m ring of
    // shore as lake. A cutter that silently fell back to that behaviour against an old bake would
    // reintroduce the bug on exactly the runs nobody was watching, so the sidecar asserts the second
    // artifact exists and the container dies without it. See `revealMasks.ts` for the arithmetic.
    waterMasks: true,
  };
  // ⚠ **Append rather than substitute when `--out` has no `.fgb` suffix.** A bare `.replace()` is a
  // no-op on `--out=/tmp/masks`, which makes `sidecarPath === fgbPath` — and the `writeFileSync`
  // below would then overwrite the FlatGeobuf that a forty-minute corpus scan just produced, with a
  // five-line JSON, silently.
  const sidecarPath = suffixed(fgbPath, '.json');
  writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

  console.error('');
  console.error(`[bake-masks] masked   ${tally.masked}`);
  console.error(
    `[bake-masks] with elevation ${tally.withElevation}` +
      ` (${((100 * tally.withElevation) / tally.masked).toFixed(1)}% — the radar de-shift's input)`,
  );
  console.error(`[bake-masks] omitted  ${tally.omitted}`, tally.omitted ? tally.byReason : '');
  for (const omission of tally.omissions) {
    console.error(
      `[bake-masks]   - ${omission.name ?? '(unnamed)'} ${omission.waterBodyId} — ${omission.reason}`,
    );
  }
  if (tally.omitted > tally.omissions.length) {
    console.error(`[bake-masks]   … and ${tally.omitted - tally.omissions.length} more`);
  }
  console.error(`[bake-masks] wrote ${fgbPath} (reveal — the picture)`);
  console.error(`[bake-masks] wrote ${waterFgbPath} (water — the measurement)`);
  if (subAreaCount > 0) {
    console.error(`[bake-masks] wrote ${subAreaFgbPath} (${subAreaCount} sub-areas)`);
  }
  console.error(
    `[bake-masks] wrote ${sidecarPath} (solid ${sidecar.solidMeters} m, feather ${sidecar.featherMeters} m)`,
  );

  // ⚠ **A bake with almost no elevations is a stale deployment, not a data gap.**
  //
  // The corpus is at 99.5% coverage. On 2026-08-25 a bake produced 0 of 40 because
  // `listForImageryMask` returned `elevationM` in source while the deployed dev function predated it
  // — and nothing downstream would have said so. The cutter would have run, every job would have
  // exited 0, and a nine-season radar archive would have been built with the geocode correction
  // silently disabled, unrecoverable without re-reading every granule.
  //
  // Fatal rather than a warning, because the failure it guards is invisible in every artifact it
  // produces. `pnpm convex-dev --once` is the fix.
  const elevationCoverage = tally.withElevation / tally.masked;
  if (elevationCoverage < 0.5) {
    console.error(
      `[bake-masks] FATAL: only ${tally.withElevation}/${tally.masked} bodies carry elevationM.` +
        ' The corpus is at ~99.5%, so this is almost certainly a dev deployment older than' +
        " listForImageryMask's elevationM field — run `pnpm convex-dev --once` and re-bake.",
    );
    process.exit(1);
  }

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
    // ⚠ **The sidecar goes LAST, and the order is the interlock.** It carries `waterMasks: true`,
    // which is what tells a cutter the water file is there — so publishing it before the file it
    // vouches for opens a window where every job spawned dies on a missing `-water.fgb`.
    for (const [from, to] of [
      [fgbPath, key],
      [waterFgbPath, suffixed(key, '-water.fgb')],
      ...(subAreaCount > 0
        ? ([[subAreaFgbPath, suffixed(key, '-subareas.fgb')]] as [string, string][])
        : []),
      [sidecarPath, suffixed(key, '.json')],
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
