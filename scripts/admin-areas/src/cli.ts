/**
 * Admin-areas transform CLI (glue). Reads osmium `geojsonseq` (one GeoJSON Feature per line) and
 * writes admin-area NDJSON (one record per line) for the loader, printing a run summary +
 * skipped-feature errors to stderr. All real logic is in `./transform` (tested); this is thin file
 * I/O and is excluded from coverage.
 *
 *   pnpm --filter @skating/admin-areas transform <input.geojsonseq> <output.ndjson>
 *   cat boundaries.geojsonseq | pnpm --filter @skating/admin-areas transform > areas.ndjson
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { largestRingSize, MAX_RING_VERTICES, transformFeatures } from './transform';
import type { OsmBoundaryFeature } from './types';

/** RFC 8142 record separator (U+001E) — geojsonseq may prefix each line with it. */
const RECORD_SEPARATOR = String.fromCharCode(0x1e);

function main(): void {
  const [inputPath, outputPath] = process.argv.slice(2);

  const raw = readFileSync(inputPath ?? 0, 'utf8');
  const features: OsmBoundaryFeature[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.replaceAll(RECORD_SEPARATOR, '').trim();
    if (trimmed.length === 0) continue;
    features.push(JSON.parse(trimmed) as OsmBoundaryFeature);
  }

  const { areas, summary, errors } = transformFeatures(features);
  const ndjson = areas.length > 0 ? `${areas.map((a) => JSON.stringify(a)).join('\n')}\n` : '';
  if (outputPath) writeFileSync(outputPath, ndjson);
  else process.stdout.write(ndjson);

  const byLevel = areas.reduce<Record<string, number>>((acc, a) => {
    acc[a.level] = (acc[a.level] ?? 0) + 1;
    return acc;
  }, {});
  process.stderr.write(
    `\n[admin-areas] ${summary.imported} imported ` +
      `(${byLevel.state ?? 0} state · ${byLevel.county ?? 0} county · ${byLevel.town ?? 0} town) · ` +
      `${summary.droppedByType} dropped (other admin_level) · ${summary.skipped} skipped (errors) · ` +
      `of ${summary.total} features\n`,
  );
  for (const err of errors)
    process.stderr.write(`[admin-areas] skipped ${err.externalId}: ${err.message}\n`);

  // Surface the densest boundary so any adaptive coarsening (near the array cap) is visible.
  const densest = areas.reduce<(typeof areas)[number] | null>(
    (max, a) => (max && largestRingSize(max.polygon) >= largestRingSize(a.polygon) ? max : a),
    null,
  );
  if (densest) {
    process.stderr.write(
      `[admin-areas] densest ring: ${densest.externalId} "${densest.name}" — ` +
        `${largestRingSize(densest.polygon)} vertices (cap ${MAX_RING_VERTICES})\n`,
    );
  }
}

main();
