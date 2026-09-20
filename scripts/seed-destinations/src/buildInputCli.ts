/**
 * `pnpm --filter @skating/seed-destinations build-input --mentions=<path> --towns=<path> --out=<path>`
 *
 * Subprocess + file-I/O glue for `buildFromMentions.ts` (the tested transform) — excluded from
 * coverage like `cli.ts` and `standing.ts`, and for the same reason: everything that can be wrong
 * is in the pure functions, which the tests cover.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  buildDestinationsFromMentions,
  parseMentionsCsv,
  type TownCentroid,
} from './buildFromMentions';

function flag(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main() {
  const args = process.argv.slice(2);
  const mentionsPath = flag(args, 'mentions');
  const townsPath = flag(args, 'towns');
  const outPath = flag(args, 'out');
  if (!mentionsPath || !townsPath || !outPath) {
    process.stderr.write('Usage: build-input --mentions=<path> --towns=<path> --out=<path>\n');
    process.exit(1);
  }

  const rows = parseMentionsCsv(readFileSync(mentionsPath, 'utf8'));
  const townCentroids = JSON.parse(readFileSync(townsPath, 'utf8')) as TownCentroid[];
  process.stderr.write(
    `[build-input] ${rows.length} mention rows · ${townCentroids.length} town centroids\n`,
  );

  const { destinations, stats } = buildDestinationsFromMentions(rows, townCentroids);
  writeFileSync(outPath, `${JSON.stringify(destinations, null, 2)}\n`);

  process.stderr.write(
    `[build-input] ${stats.included}/${stats.totalRows} included ` +
      `(${stats.excludedKindOrLandmark} other/landmark, ${stats.excludedUnknownName} unknown-name, ` +
      `${stats.excludedBelowThreshold} below threshold, ${stats.excludedNoState} no resolvable state)\n` +
      `[build-input] tercile thresholds: messages ≤ ${stats.tercileThresholds.t1} → 0.1, ` +
      `≤ ${stats.tercileThresholds.t2} → 0.2, else 0.3 — boosts ${JSON.stringify(stats.boostCounts)}\n` +
      `[build-input] near resolved ${stats.nearResolved}/${stats.included} ` +
      `(rank1=${stats.nearResolvedByRank[1]}, rank2=${stats.nearResolvedByRank[2]}, rank3=${stats.nearResolvedByRank[3]}) · ` +
      `${stats.nearUnresolved} omitted\n` +
      `[build-input] ${stats.subAreaCandidates} sub-area candidates · ${stats.qcRows} outside catalog footprint (QC)\n` +
      `[build-input] wrote ${destinations.length} destinations to ${outPath}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(
      `[build-input] failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
