/**
 * Archive NH GRANIT's bathymetry **band polygons** into `.raw/nh-bathy-bands/` (N7-3).
 *
 *   pnpm --filter @skating/lake-depth snapshot-nh-bands [--campaign=<id>] [--refresh]
 *
 * Layer 1 of the same service N6b read layer 0 of. See `nhBands.ts` for what it is and why the lines
 * layer could never have given a mean. Centroids rather than rings, so the archive is a few hundred
 * kilobytes rather than a second copy of the contour geometry.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import {
  NH_BANDS_FIELDS,
  NH_BANDS_PAGE_SIZE,
  NH_BANDS_SERVICE_URL,
  type NhBandRow,
  nhBandsQueryUrl,
  nhLakeDepths,
  parseNhBandFeature,
} from './nhBands';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = resolve(HERE, '../.raw/nh-bathy-bands');
const BANDS = `${ARCHIVE_DIR}/bands.ndjson`;
const MANIFEST = `${ARCHIVE_DIR}/manifest.json`;

/** 7,351 rows at 2,000 a page. A ceiling, so a service that ignores `resultOffset` cannot spin. */
const MAX_PAGES = 40;

const USER_AGENT =
  'skating-corpus/1.0 (open-source outdoor-recreation project; contact desk@teaganatwater.com)';

async function fetchPage(offset: number): Promise<unknown[]> {
  const res = await fetch(nhBandsQueryUrl(offset), { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`NH bands: ${res.status} ${res.statusText} at offset ${offset}`);
  const body = await res.text();
  let parsed: { features?: unknown; error?: { message?: string } };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new Error(
      'NH bands: the service did not return JSON. ArcGIS answers an error with a 200 and a page, ' +
        'so a parse failure here is a refused query rather than a network fault.',
    );
  }
  if (parsed.error) throw new Error(`NH bands: ${parsed.error.message ?? 'service error'}`);
  if (!Array.isArray(parsed.features)) {
    throw new Error('NH bands: the response carried no `features` array, so the shape changed.');
  }
  return parsed.features;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (existsSync(BANDS) && !args.includes('--refresh')) {
    process.stderr.write(`[nh-bands] ${BANDS} already exists — pass --refresh to re-fetch.\n`);
    return;
  }

  const logger = new RunLogger({
    kind: 'lake_depth',
    label: 'NH bathymetry depth bands (archive)',
    campaignId: args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length),
    target: resolveDeployment(),
    call: convexRun,
    stages: [
      {
        name: 'nh-bands · query',
        detail:
          `paged at ${NH_BANDS_PAGE_SIZE}; ${NH_BANDS_FIELDS.length} named fields plus the band ` +
          'centroid, never the rings — N6b already holds this survey’s geometry as contour lines.',
        sourceUrl: `${NH_BANDS_SERVICE_URL}/query`,
      },
      { name: 'archive', detail: '.raw/nh-bathy-bands/bands.ndjson', output: ARCHIVE_DIR },
    ],
  });
  logger.start();

  try {
    const rows: NhBandRow[] = [];
    let featuresRead = 0;
    let unparseable = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const features = await fetchPage(page * NH_BANDS_PAGE_SIZE);
      if (features.length === 0) break;
      featuresRead += features.length;
      for (const feature of features) {
        const row = parseNhBandFeature(feature as never);
        if (row === undefined) unparseable++;
        else rows.push(row);
      }
      if (features.length < NH_BANDS_PAGE_SIZE) break;
    }

    // Summarised at archive time so the manifest states what the archive is worth, rather than
    // leaving the first reader to discover that 636 assessment units are really 600-odd lakes.
    const { lakes, skipped } = nhLakeDepths(rows);

    mkdirSync(ARCHIVE_DIR, { recursive: true });
    writeFileSync(BANDS, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    writeFileSync(
      MANIFEST,
      `${JSON.stringify(
        {
          key: 'nh-bathy-bands',
          label: 'NH GRANIT — lake bathymetry depth bands (polygons)',
          publisher: 'NH Department of Environmental Services · NH Fish and Game (NH GRANIT)',
          sourceUrl: NH_BANDS_SERVICE_URL,
          fields: NH_BANDS_FIELDS,
          fetchedAt: new Date().toISOString(),
          featuresRead,
          bandsArchived: rows.length,
          unparseable,
          lakesWithDepth: lakes.length,
          skipped,
          unit: 'feet (depthmin/depthmax), acres (area)',
          datum: 'depth below surface at survey time',
          note:
            'Layer 1 of EDP_Bathymetry_Lakes; N6b reads layer 0 (contour LINES) for the render. ' +
            'These polygons carry the band AREAS, which is what makes a hypsographic mean depth ' +
            'possible — see nhBands.ts. Centroids only: the rings are the render payload and are ' +
            'already archived as lines. The layer also includes Maine-filed assessment units for ' +
            'border lakes (Great East Lake, Horn Pond); they are kept, since the join is spatial.',
        },
        null,
        2,
      )}\n`,
    );

    process.stderr.write(
      `[nh-bands] ${featuresRead} features read · ${rows.length} bands archived · ` +
        `${lakes.length} lakes with a depth · skipped ${JSON.stringify(skipped)}\n`,
    );
    logger.count('featuresRead', featuresRead);
    logger.count('bandsArchived', rows.length);
    logger.count('unparseable', unparseable);
    logger.count('lakesWithDepth', lakes.length);
    for (const [reason, n] of Object.entries(skipped)) {
      if (n > 0) logger.count(`skipped.${reason}`, n);
    }
    logger.coverage({
      unit: 'assessment units',
      eligible: lakes.length + Object.values(skipped).reduce((a, b) => a + b, 0),
      covered: lakes.length,
      omissions: Object.entries(skipped)
        .filter(([, n]) => n > 0)
        .map(([reason, count]) => ({ reason, count })),
    });
    logger.succeed([
      `${rows.length} bands over ${lakes.length} lakes archived at ${ARCHIVE_DIR}`,
      'mirror with scripts/lake-depth/mirror-r2.sh push',
    ]);
  } catch (err) {
    logger.failed(err);
    throw err;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[nh-bands] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
