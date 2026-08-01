/**
 * Density-gate sweep (N6b) — run the gate over the real archive at a range of thresholds.
 *
 *   pnpm --filter @skating/bathymetry sweep [--ratios=0.10,0.15,0.20]
 *
 * §Maine says to *"pick the threshold from the real distribution"*, and N6a's lesson was that an
 * evidence gate nobody points at is not a gate. This is the thing to point at: it turns the choice
 * from an argument into a table, and it re-runs for free because the archive is permanent.
 *
 * I/O glue over the tested `density` and `normalize` modules; excluded from coverage.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { listRawPages, rawDir, readRawPage } from './cache';
import { assessDensity, type DensityAssessment, summariseDensity } from './density';
import {
  groupByLake,
  type NormalizedSounding,
  normalizeChamplainSoundings,
  normalizeMeSoundings,
  normalizeVtSoundingLine,
  vtSoundingColumns,
} from './normalize';

function flag(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/** Read every archived page of an ArcGIS sounding source through its normalizer. */
function readArcGisSoundings(
  key: string,
  normalize: (features: GeoJSONFeature[]) => { records: NormalizedSounding[] },
): NormalizedSounding[] {
  const out: NormalizedSounding[] = [];
  for (const page of listRawPages(key)) {
    const parsed = JSON.parse(readRawPage(key, page)) as { features?: GeoJSONFeature[] };
    out.push(...normalize(parsed.features ?? []).records);
  }
  return out;
}

type GeoJSONFeature = Parameters<typeof normalizeMeSoundings>[0][number];

function report(label: string, groups: Map<string, NormalizedSounding[]>, ratios: number[]): void {
  process.stdout.write(
    `\n## ${label} — ${groups.size} lakes, ${[...groups.values()].reduce((n, g) => n + g.length, 0).toLocaleString()} soundings\n\n`,
  );
  process.stdout.write(
    '| gap ≤ | lakes kept | share | dropped: too few | too sparse | degenerate |\n',
  );
  process.stdout.write('| --- | --- | --- | --- | --- | --- |\n');

  const inputs = [...groups.entries()].map(([lakeKey, points]) => ({ lakeKey, points }));
  for (const ratio of ratios) {
    const assessments: DensityAssessment[] = inputs.map((input) =>
      assessDensity(input, { maxGapRatio: ratio }),
    );
    const s = summariseDensity(assessments);
    const share = ((s.kept.length / assessments.length) * 100).toFixed(0);
    process.stdout.write(
      `| ${(ratio * 100).toFixed(0)}% | ${s.kept.length} | ${share}% | ` +
        `${s.byVerdict['too-few-points']} | ${s.byVerdict['too-sparse']} | ${s.byVerdict.degenerate} |\n`,
    );
  }
}

async function readVtSoundings(): Promise<Map<string, NormalizedSounding[]>> {
  // 2.4M rows out of a 134 MB CSV inside a zip. Streamed line by line and grouped as we go, because
  // materialising 2.4M objects to group them afterwards is the out-of-memory version of this.
  const zipPath = path.join(
    rawDir('vt-anr-biobase-soundings'),
    'BiobaseLakeBathymetry_08122020.zip',
  );
  const groups = new Map<string, NormalizedSounding[]>();

  // `unzip -p` streams the member to stdout. Node ships no zip reader, and shelling out to a tool
  // that is already a prerequisite beats adding a dependency to read one file once.
  const child = spawn('unzip', ['-p', zipPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  const rl = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  let columns: ReturnType<typeof vtSoundingColumns> | undefined;
  for await (const line of rl) {
    if (!columns) {
      columns = vtSoundingColumns(line);
      continue;
    }
    if (!line.trim()) continue;
    const record = normalizeVtSoundingLine(line, columns);
    if ('skipReason' in record) continue;
    const existing = groups.get(record.lakeKey);
    if (existing) existing.push(record);
    else groups.set(record.lakeKey, [record]);
  }
  return groups;
}

async function main(): Promise<void> {
  const ratios = (flag(process.argv.slice(2), 'ratios') ?? '0.10,0.15,0.20,0.25')
    .split(',')
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);

  process.stdout.write('# Density-gate sweep\n');
  process.stdout.write(
    '\nA lake is kept when the worst-covered water inside the surveyed hull (p95) is within the\n' +
      "given fraction of the lake's extent from a real sounding.\n",
  );

  report(
    'Maine (DEP + IF&W)',
    groupByLake(readArcGisSoundings('me-dep-soundings', normalizeMeSoundings)),
    ratios,
  );
  report(
    'Lake Champlain (VCGI / NOAA)',
    groupByLake(readArcGisSoundings('vt-vcgi-champlain-soundings', normalizeChamplainSoundings)),
    ratios,
  );
  report('Vermont (ANR BioBase)', await readVtSoundings(), ratios);
}

main().catch((error: unknown) => {
  process.stderr.write(`[bathymetry] sweep failed: ${(error as Error).message}\n`);
  process.exit(1);
});
