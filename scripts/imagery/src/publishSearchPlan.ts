/**
 * Publish what the live imagery poll cannot compute for itself (A06i §5, D214).
 *
 *   pnpm --filter @skating/imagery publish-search-plan [--masks=<path.fgb>] [--dry-run]
 *
 * Writes `masks/<season>-search.json` beside the masks it describes: the mask file's extent (the
 * STAC search box) and the MGRS tiles that hold no corpus body (the empty-tile prefilter, 44% of a
 * season's granules). Both come from `ogrinfo` against the FlatGeobuf, which a Convex action cannot
 * run — so they are computed here once per mask bake, and the poll refuses to run against a plan
 * whose `surveyKey` names a different bake.
 *
 * The tile survey is the one `select-granules` caches (`masks-<season>-tiles.geojson`); if it is
 * missing or stale, run `select-granules` over any window first and it surveys every tile it sees.
 * A tile the survey never saw is *kept* by the poll — the generous direction, as everywhere here.
 *
 * Thin glue; excluded from coverage, like the sibling CLIs.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { emptyTilesFromCollection, type TileSurveyCollection, tileSurveyKey } from '@skating/core';

import { findLatestMasks, flag, has, maskExtent, SCRATCH } from './cli';

function main(): void {
  const masks = flag('masks') ?? findLatestMasks();
  const bucket = flag('bucket') ?? process.env.R2_BUCKET ?? 'skating-imagery';
  const sidecar = JSON.parse(readFileSync(masks.replace(/\.fgb$/, '.json'), 'utf8')) as {
    season?: string;
    bodies?: number;
  };
  if (!sidecar.season || typeof sidecar.bodies !== 'number') {
    throw new Error(`${masks}'s sidecar has no season or body count — re-run bake-masks`);
  }
  const surveyKey = tileSurveyKey(sidecar.season, sidecar.bodies);
  const survey = JSON.parse(
    readFileSync(masks.replace(/\.fgb$/, '-tiles.geojson'), 'utf8'),
  ) as TileSurveyCollection;
  const empty = emptyTilesFromCollection(survey, surveyKey);
  if (!empty) {
    throw new Error(
      `the cached tile survey is for ${survey.surveyKey}, not ${surveyKey} — run select-granules over any window to resurvey`,
    );
  }

  const plan = {
    season: sidecar.season,
    surveyKey,
    bbox: maskExtent(masks),
    emptyTiles: [...empty].sort(),
    keptTiles: survey.features
      .filter((f) => f.properties?.kept)
      .map((f) => f.properties.tile)
      .sort(),
    publishedAt: new Date().toISOString(),
  };
  const out = join(SCRATCH, `masks-${sidecar.season}-search.json`);
  writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);
  console.error(
    `[publish-search-plan] ${sidecar.season}: bbox ${plan.bbox.join(', ')} · ${plan.emptyTiles.length} empty / ${plan.keptTiles.length} kept tiles`,
  );
  if (has('dry-run')) {
    console.error(`[publish-search-plan] --dry-run: wrote ${out}, uploaded nothing`);
    return;
  }
  const key = `masks/${sidecar.season}-search.json`;
  execFileSync('rclone', ['copyto', out, `r2:${bucket}/${key}`, '--s3-no-check-bucket'], {
    stdio: 'inherit',
  });
  console.error(`[publish-search-plan] uploaded r2:${bucket}/${key}`);
}

try {
  main();
} catch (error: unknown) {
  console.error('[publish-search-plan] FATAL:', error instanceof Error ? error.message : error);
  process.exit(1);
}
