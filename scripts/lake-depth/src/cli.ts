/**
 * Lake-depth transform CLI (glue). Reads whichever of the three sources you point it at and writes
 * depth NDJSON for the loader, printing a per-source summary + named skips to stderr. All real logic is
 * in `./transform` (tested); this is thin file I/O and is excluded from coverage.
 *
 *   pnpm --filter @skating/lake-depth transform --out=depths.ndjson \
 *     [--hydrolakes=hydrolakes.geojsonseq] [--globathy=GLOBathy_basic_parameters.csv] \
 *     [--lagos=lagos_depth.csv] [--states=VT,NH,ME,MA,NY]
 *
 * Any subset is valid — the sources are independent (GLOBathy excepted, which needs HydroLAKES for its
 * geometry), so you can load LAGOS-US first and add the modelled rungs later. The D68 ladder is enforced
 * server-side, so load order never changes the result.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { parseGlobathy, parseLagosDepth, transformDepths } from './transform';
import type { HydroLakesFeature } from './types';

/** RFC 8142 record separator (U+001E) — GeoJSONSeq may prefix each line with it. */
const RECORD_SEPARATOR = String.fromCharCode(0x1e);

function flag(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function readGeoJsonSeq(path: string): HydroLakesFeature[] {
  const features: HydroLakesFeature[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.replaceAll(RECORD_SEPARATOR, '').trim();
    if (trimmed.length === 0) continue;
    features.push(JSON.parse(trimmed) as HydroLakesFeature);
  }
  return features;
}

function main(): void {
  const args = process.argv.slice(2);
  const outPath = flag(args, 'out');
  const hydroPath = flag(args, 'hydrolakes');
  const globathyPath = flag(args, 'globathy');
  const lagosPath = flag(args, 'lagos');
  // Two-letter codes, comma-separated. Drops LAGOS rows naming none of them — see `TransformInput`.
  const states = flag(args, 'states')
    ?.split(',')
    .map((st) => st.trim().toUpperCase())
    .filter(Boolean);

  if (!hydroPath && !globathyPath && !lagosPath) {
    process.stderr.write(
      'usage: pnpm --filter @skating/lake-depth transform --out=depths.ndjson ' +
        '[--hydrolakes=…geojsonseq] [--globathy=…csv] [--lagos=…csv]\n',
    );
    process.exit(1);
  }
  if (globathyPath && !hydroPath) {
    // GLOBathy is an attribute table keyed on Hylak_id with no geometry of its own, so on its own every
    // row would be skipped for having nowhere to be matched. Fail loudly instead of reporting 0 emitted.
    process.stderr.write(
      '[lake-depth] refusing: --globathy needs --hydrolakes for its geometry (it is keyed on Hylak_id).\n',
    );
    process.exit(1);
  }

  const { records, summary, errors } = transformDepths({
    hydroLakes: hydroPath ? readGeoJsonSeq(hydroPath) : undefined,
    globathy: globathyPath ? parseGlobathy(readFileSync(globathyPath, 'utf8')) : undefined,
    lagos: lagosPath ? parseLagosDepth(readFileSync(lagosPath, 'utf8')) : undefined,
    states,
  });

  const ndjson = records.length > 0 ? `${records.map((r) => JSON.stringify(r)).join('\n')}\n` : '';
  if (outPath) writeFileSync(outPath, ndjson);
  else process.stdout.write(ndjson);

  const withMean = records.filter((r) => r.meanDepthM !== undefined).length;
  const withMax = records.filter((r) => r.maxDepthM !== undefined).length;
  process.stderr.write(
    `\n[lake-depth] read ${summary.hydroLakesRead} HydroLAKES · ${summary.globathyRead} GLOBathy · ` +
      `${summary.lagosRead} LAGOS-US\n` +
      `[lake-depth] emitted ${summary.emitted} records (${withMean} with a mean · ${withMax} with a max) · ` +
      `${summary.skipped} skipped\n`,
  );
  // Named separately from `skipped`, because it is a scope boundary rather than a failure: these
  // lakes are fine, they are simply somewhere we do not cover.
  if (summary.outOfRegion) {
    process.stderr.write(
      `[lake-depth] ${summary.outOfRegion} LAGOS-US lake(s) dropped for naming no supported state ` +
        `(--states=${states?.join(',')})\n`,
    );
  }
  if (summary.lagosMerged > 0 || summary.lagosContested > 0) {
    // Step 0 of the runbook is "find out whether LAGOS-US even has duplicate rows". This line is the
    // answer, printed by the run that first has the file in hand.
    process.stderr.write(
      `[lake-depth] LAGOS-US: ${summary.lagosMerged} duplicate row(s) merged into their lake · ` +
        `${summary.lagosContested} lake(s) whose records disagree across a shallow threshold (listed below)\n`,
    );
  }
  // Cap the per-lake noise but say how much was withheld — a truncated list that looks complete is the
  // failure mode the register's own no-silent-caps rule exists for.
  const SHOWN = 20;
  for (const err of errors.slice(0, SHOWN)) {
    process.stderr.write(`[lake-depth] skipped ${err.key}: ${err.message}\n`);
  }
  if (errors.length > SHOWN) {
    process.stderr.write(`[lake-depth] …and ${errors.length - SHOWN} more skipped (not shown)\n`);
  }
}

main();
