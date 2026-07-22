/**
 * ETL transform CLI (glue). Reads osmium `geojsonseq` (one GeoJSON Feature per line) and
 * writes canonical-body NDJSON (one body per line) for the loader, printing a run summary +
 * skipped-feature errors to stderr. All real logic is in `./transform` (tested); this is thin
 * file I/O and is excluded from coverage.
 *
 *   pnpm --filter @skating/etl transform <input.geojsonseq> <output.ndjson>
 *   cat water.geojsonseq | pnpm --filter @skating/etl transform > bodies.ndjson
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { largestRingSize, MAX_RING_VERTICES, transformFeatures } from './transform';
import type { OsmWaterFeature } from './types';

/** RFC 8142 record separator (U+001E) — geojsonseq may prefix each line with it. */
const RECORD_SEPARATOR = String.fromCharCode(0x1e);

function main(): void {
  const [inputPath, outputPath] = process.argv.slice(2);

  // Default input is stdin (fd 0). Strip any record separator defensively (as a string, not
  // a regex - biome disallows control characters in regexes).
  const raw = readFileSync(inputPath ?? 0, 'utf8');
  const features: OsmWaterFeature[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.replaceAll(RECORD_SEPARATOR, '').trim();
    if (trimmed.length === 0) continue;
    features.push(JSON.parse(trimmed) as OsmWaterFeature);
  }

  const { bodies, summary, errors } = transformFeatures(features);
  const ndjson =
    bodies.length > 0 ? `${bodies.map((body) => JSON.stringify(body)).join('\n')}\n` : '';
  if (outputPath) writeFileSync(outputPath, ndjson);
  else process.stdout.write(ndjson);

  process.stderr.write(
    `\n[etl] ${summary.imported} imported · ${summary.droppedByType} dropped (non-still-water) · ` +
      `${summary.skipped} skipped (errors) · of ${summary.total} features\n`,
  );
  for (const err of errors)
    process.stderr.write(`[etl] skipped ${err.externalId}: ${err.message}\n`);

  // Surface the densest geometry so any adaptive coarsening (rings near the 8192 array cap)
  // is visible rather than silent — normally this is Lake Champlain.
  const densest = bodies.reduce<(typeof bodies)[number] | null>(
    (max, body) =>
      max && largestRingSize(max.polygon) >= largestRingSize(body.polygon) ? max : body,
    null,
  );
  if (densest) {
    process.stderr.write(
      `[etl] densest ring: ${densest.externalId} "${densest.name}" — ${largestRingSize(densest.polygon)} vertices (cap ${MAX_RING_VERTICES})\n`,
    );
  }
}

main();
