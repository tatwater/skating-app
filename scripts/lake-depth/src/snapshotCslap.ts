/**
 * Archive NYSDEC's CSLAP lakes into `.raw/cslap/` (N7-3).
 *
 *   pnpm --filter @skating/lake-depth snapshot-cslap [--campaign=<id>] [--refresh]
 *
 * ## Why this is a snapshot and not a live read
 *
 * The same reason every other lane here has a `.raw/`: **`derive` must not need the network.** A
 * transform that quietly re-fetches is a transform whose output cannot be reproduced, and the wind
 * lane's 7.7-hour regret is the standing argument. This one costs a single request, which makes the
 * archive look like ceremony — it is not. The layer is *live and edited*: `Last_Year_Sampled` moved
 * to 2024 while the hosting item's own snippet still says 2023. An archive is what lets a depth in
 * the corpus be traced to the rows that produced it rather than to whatever the service says today.
 *
 * Contrast `snapshotAlsc.ts`, which is paced at 1 req/s over ~1,470 requests against a small
 * organisation's shared host. This is one query against an Esri-hosted government service; there is
 * nothing to be polite about beyond identifying ourselves.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import {
  CSLAP_FIELDS,
  CSLAP_PAGE_SIZE,
  CSLAP_SERVICE_URL,
  type CslapLake,
  type CslapRefusal,
  cslapFeatures,
  cslapQueryUrl,
  parseCslapRow,
} from './cslap';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = resolve(HERE, '../.raw/cslap');
const LAKES = `${ARCHIVE_DIR}/lakes.ndjson`;
const MANIFEST = `${ARCHIVE_DIR}/manifest.json`;

/** Pages before we conclude the service is looping rather than paging. 294 rows / 1,000 per page. */
const MAX_PAGES = 50;

const USER_AGENT =
  'skating-corpus/1.0 (open-source outdoor-recreation project; contact desk@teaganatwater.com)';

async function fetchPage(offset: number): Promise<{ attributes: Record<string, unknown> }[]> {
  const res = await fetch(cslapQueryUrl(offset), { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    throw new Error(`CSLAP: ${res.status} ${res.statusText} at offset ${offset}`);
  }
  return cslapFeatures(await res.text());
}

function writeArchive(
  lakes: readonly CslapLake[],
  refusals: Record<string, number>,
  rowsRead: number,
): void {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  writeFileSync(LAKES, `${lakes.map((l) => JSON.stringify(l)).join('\n')}\n`);
  writeFileSync(
    MANIFEST,
    `${JSON.stringify(
      {
        key: 'cslap',
        label: 'NY Citizens Statewide Lake Assessment Program — lake mean depth',
        publisher:
          'New York State Department of Environmental Conservation + New York State Federation of Lake Associations',
        sourceUrl: CSLAP_SERVICE_URL,
        fields: CSLAP_FIELDS,
        fetchedAt: new Date().toISOString(),
        rowsRead,
        lakesArchived: lakes.length,
        withMeanDepth: lakes.length,
        refusals,
        licence:
          'NO PUBLISHED TERMS. The hosting ArcGIS item (e3332be9630a4bd9978f0bdc8a67a3cd, owned by ' +
          'a dec.ny.gov account) has an EMPTY licenseInfo and an EMPTY accessInformation, and the ' +
          'service carries no copyrightText; sharing is public. Checked 2026-08-09. Same finding as ' +
          'ALSC and the same response: attribution, carried in DEPTH_SOURCE_TERMS.cslap.',
        note:
          'Mean depth only — the programme publishes no maximum. Coordinates are read from the ' +
          'WGS84 Latitude/Longitude attributes rather than unprojected from the Web Mercator ' +
          'geometry. Elevation is published here as a STRING and is ignored: ours is 1 m 3DEP.',
      },
      null,
      2,
    )}\n`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  if (existsSync(LAKES) && !refresh) {
    process.stderr.write(
      `[cslap] ${LAKES} already exists — pass --refresh to re-fetch.\n` +
        '[cslap] An archive that does not change under the transform being iterated on is the point.\n',
    );
    return;
  }

  const logger = new RunLogger({
    kind: 'lake_depth',
    label: 'CSLAP lake mean depth (archive)',
    campaignId: args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length),
    target: resolveDeployment(),
    call: convexRun,
    stages: [
      {
        name: 'cslap · query',
        detail: `paged at ${CSLAP_PAGE_SIZE}; ${CSLAP_FIELDS.length} named fields, never *`,
        sourceUrl: `${CSLAP_SERVICE_URL}/query`,
      },
      { name: 'archive', detail: '.raw/cslap/lakes.ndjson', output: ARCHIVE_DIR },
    ],
  });
  logger.start();

  try {
    const lakes: CslapLake[] = [];
    const refusals: Record<string, number> = {};
    const seen = new Set<string>();
    let rowsRead = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const features = await fetchPage(page * CSLAP_PAGE_SIZE);
      if (features.length === 0) break;
      rowsRead += features.length;
      for (const feature of features) {
        const outcome = parseCslapRow(feature.attributes ?? {});
        if (!outcome.ok) {
          const reason: CslapRefusal = outcome.reason;
          refusals[reason] = (refusals[reason] ?? 0) + 1;
          continue;
        }
        // A lake number twice would mean the service is re-serving a page rather than advancing,
        // which `resultOffset` makes possible if `orderByFields` is ignored. Counted, not silent.
        if (seen.has(outcome.lake.cslapNumber)) {
          refusals.duplicate = (refusals.duplicate ?? 0) + 1;
          continue;
        }
        seen.add(outcome.lake.cslapNumber);
        lakes.push(outcome.lake);
      }
      if (features.length < CSLAP_PAGE_SIZE) break;
    }

    writeArchive(lakes, refusals, rowsRead);
    process.stderr.write(
      `[cslap] ${rowsRead} rows read · ${lakes.length} lakes archived with a mean depth · ` +
        `refused ${JSON.stringify(refusals)}\n`,
    );

    logger.count('rowsRead', rowsRead);
    logger.count('archived', lakes.length);
    logger.count('withMeanDepth', lakes.length);
    for (const [reason, n] of Object.entries(refusals)) logger.count(`refused.${reason}`, n);
    logger.coverage({
      unit: 'lakes',
      eligible: rowsRead,
      covered: lakes.length,
      omissions: Object.entries(refusals).map(([reason, count]) => ({ reason, count })),
    });
    logger.succeed([
      `${lakes.length} CSLAP lakes archived at ${ARCHIVE_DIR}`,
      'mirror with scripts/lake-depth/mirror-r2.sh push',
    ]);
  } catch (err) {
    logger.failed(err);
    throw err;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[cslap] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
