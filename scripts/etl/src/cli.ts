/**
 * ETL transform CLI (glue). Reads osmium `geojsonseq` (one GeoJSON Feature per line) and
 * writes canonical-body NDJSON (one body per line) for the loader, printing a run summary +
 * skipped-feature errors to stderr. All real logic is in `./transform` (tested); this is thin
 * file I/O and is excluded from coverage.
 *
 *   pnpm --filter @skating/etl transform <input.geojsonseq> <output.ndjson> [--depths=depths.ndjson]
 *   cat water.geojsonseq | pnpm --filter @skating/etl transform > bodies.ndjson
 *
 * `--depths` writes the second, much smaller stream: bodies carrying an OSM `depth`/`maxdepth` tag
 * (N6a rung 7), for `pnpm --filter @skating/etl load-depths`. Omit it and depths are simply counted.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { largestRingSize, MAX_RING_VERTICES, transformFeatures } from './transform';
import type { OsmWaterFeature } from './types';

/** RFC 8142 record separator (U+001E) — geojsonseq may prefix each line with it. */
const RECORD_SEPARATOR = String.fromCharCode(0x1e);

function main(): void {
  const args = process.argv.slice(2);
  const depthsPath = args.find((a) => a.startsWith('--depths='))?.slice('--depths='.length);
  const [inputPath, outputPath] = args.filter((a) => !a.startsWith('--'));

  // Default input is stdin (fd 0). Strip any record separator defensively (as a string, not
  // a regex - biome disallows control characters in regexes).
  const raw = readFileSync(inputPath ?? 0, 'utf8');
  const features: OsmWaterFeature[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.replaceAll(RECORD_SEPARATOR, '').trim();
    if (trimmed.length === 0) continue;
    features.push(JSON.parse(trimmed) as OsmWaterFeature);
  }

  const { bodies, depths, summary, errors } = transformFeatures(features);
  const ndjson =
    bodies.length > 0 ? `${bodies.map((body) => JSON.stringify(body)).join('\n')}\n` : '';
  if (outputPath) writeFileSync(outputPath, ndjson);
  else process.stdout.write(ndjson);
  if (depthsPath) {
    writeFileSync(
      depthsPath,
      depths.length > 0 ? `${depths.map((d) => JSON.stringify(d)).join('\n')}\n` : '',
    );
  }

  process.stderr.write(
    `\n[etl] ${summary.imported} imported · ${summary.droppedByType} dropped (non-still-water) · ` +
      `${summary.skipped} skipped (errors) · of ${summary.total} features\n`,
  );
  // Named even at zero: "no inland lake in five states tags its depth" is the expected result and a
  // finding, whereas a silent absence reads the same as never having looked (the N6a review's finding 5).
  process.stderr.write(
    `[etl] ${summary.depthsTagged} bodies carry a usable OSM depth tag (N6a rung 7)` +
      `${depthsPath ? ` → ${depthsPath}` : ' — pass --depths=… to write them'}\n`,
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
