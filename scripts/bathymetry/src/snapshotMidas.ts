/**
 * Archive Maine's MIDAS → NHD crosswalk into `.raw/me-midas-crosswalk/` (N7-3).
 *
 *   pnpm --filter @skating/bathymetry snapshot-midas [--campaign=<id>] [--refresh]
 *
 * An identifier table, not a survey — so it lives beside the sounding archives it exists to key,
 * under the bucket those are already mirrored to. See `midasCrosswalk.ts` for what it unblocks and
 * for the two traps in the published layer.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import {
  crosswalkStats,
  MIDAS_FIELDS,
  MIDAS_PAGE_SIZE,
  MIDAS_SERVICE_URL,
  type MidasRow,
  midasCrosswalk,
  midasQueryUrl,
  parseMidasRow,
} from './midasCrosswalk';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = join(HERE, '..', '.raw', 'me-midas-crosswalk');
const ROWS = join(ARCHIVE_DIR, 'rows.ndjson');
const MANIFEST = join(ARCHIVE_DIR, 'manifest.json');

/** 5,831 rows at 2,000 a page. A ceiling, so a service ignoring `resultOffset` cannot spin. */
const MAX_PAGES = 20;

const USER_AGENT =
  'skating-corpus/1.0 (open-source outdoor-recreation project; contact desk@teaganatwater.com)';

async function fetchPage(offset: number): Promise<{ attributes: Record<string, unknown> }[]> {
  const res = await fetch(midasQueryUrl(offset), { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`MIDAS: ${res.status} ${res.statusText} at offset ${offset}`);
  const body = await res.text();
  let parsed: { features?: unknown; error?: { message?: string } };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new Error(
      'MIDAS: the service did not return JSON. ArcGIS answers an error with a 200 and a page, so a ' +
        'parse failure here is a refused query rather than a network fault.',
    );
  }
  if (parsed.error) throw new Error(`MIDAS: ${parsed.error.message ?? 'service error'}`);
  if (!Array.isArray(parsed.features)) {
    throw new Error('MIDAS: the response carried no `features` array, so the shape changed.');
  }
  return parsed.features as { attributes: Record<string, unknown> }[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (existsSync(ROWS) && !args.includes('--refresh')) {
    process.stderr.write(`[midas] ${ROWS} already exists — pass --refresh to re-fetch.\n`);
    return;
  }

  const logger = new RunLogger({
    kind: 'raw_archive',
    label: 'Maine MIDAS → NHD crosswalk (archive)',
    campaignId: args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length),
    target: resolveDeployment(),
    call: convexRun,
    stages: [
      {
        name: 'midas · query',
        detail:
          `paged at ${MIDAS_PAGE_SIZE}; ${MIDAS_FIELDS.length} named fields. ` +
          'PERMID is deliberately NOT among them — it is a copy of ACRES.',
        sourceUrl: `${MIDAS_SERVICE_URL}/query`,
      },
      { name: 'archive', detail: '.raw/me-midas-crosswalk/rows.ndjson', output: ARCHIVE_DIR },
    ],
  });
  logger.start();

  try {
    const rows: MidasRow[] = [];
    let featuresRead = 0;
    let unparseable = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const features = await fetchPage(page * MIDAS_PAGE_SIZE);
      if (features.length === 0) break;
      featuresRead += features.length;
      for (const feature of features) {
        const row = parseMidasRow(feature.attributes ?? {});
        if (row === undefined) unparseable++;
        else rows.push(row);
      }
      if (features.length < MIDAS_PAGE_SIZE) break;
    }

    const stats = crosswalkStats(midasCrosswalk(rows));
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    writeFileSync(ROWS, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    writeFileSync(
      MANIFEST,
      `${JSON.stringify(
        {
          key: 'me-midas-crosswalk',
          label: 'Maine DEP — MIDAS Waterbodies (MIDAS ↔ NHD Permanent_Identifier)',
          publisher: 'Maine Department of Environmental Protection',
          sourceUrl: MIDAS_SERVICE_URL,
          fields: MIDAS_FIELDS,
          fetchedAt: new Date().toISOString(),
          featuresRead,
          rowsArchived: rows.length,
          unparseable,
          ...stats,
          note:
            'An identifier table, not a survey — it carries no depth. `PERMANENT_` is the NHD ' +
            'Permanent_Identifier; `PERMID` is a COPY OF ACRES wearing an identifier name and is ' +
            'not fetched. One MIDAS number can hold several NHD bodies (9861 = Long Pond + ' +
            'Lewiston Pond), so consumers must read `crosswalkFor`’s `confident` flag rather than ' +
            'taking the first row.',
        },
        null,
        2,
      )}\n`,
    );

    process.stderr.write(
      `[midas] ${featuresRead} features · ${rows.length} rows archived · ` +
        `${stats.midasNumbers} MIDAS numbers, ${stats.withPermanentId} with an NHD id, ` +
        `${stats.ambiguous} ambiguous, ${stats.nameConflicts} name conflicts\n`,
    );
    logger.count('featuresRead', featuresRead);
    logger.count('rowsArchived', rows.length);
    logger.count('midasNumbers', stats.midasNumbers);
    logger.count('withPermanentId', stats.withPermanentId);
    logger.count('withoutPermanentId', stats.withoutPermanentId);
    logger.count('ambiguous', stats.ambiguous);
    logger.count('nameConflicts', stats.nameConflicts);
    logger.coverage({
      unit: 'MIDAS numbers',
      eligible: stats.midasNumbers,
      covered: stats.withPermanentId,
      omissions: [
        { reason: 'no NHD Permanent_Identifier published', count: stats.withoutPermanentId },
      ],
    });
    logger.succeed([
      `${rows.length} crosswalk rows at ${ARCHIVE_DIR}`,
      'mirror with scripts/bathymetry/mirror-r2.sh push',
    ]);
  } catch (err) {
    logger.failed(err);
    throw err;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[midas] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
