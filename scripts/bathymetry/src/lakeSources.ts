/**
 * Reading every archived source into `ArchivedLake` (N6b).
 *
 * The I/O half of `lakes.ts`, split out for the same reason `cache.ts` is split from `manifest.ts`:
 * file and subprocess glue is not the part that can be wrong in a way that still looks right, and
 * keeping it in the same module as the selection logic would drag a tested file's coverage down to
 * the level of its least testable function. Excluded from coverage; everything it composes is not.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { listRawPages, rawDir, readRawPage } from './cache';
import type { ArchivedLake, Lane } from './lakes';
import {
  groupByLake,
  type NormalizedContour,
  type NormalizedSounding,
  normalizeChamplainSoundings,
  normalizeMaContours,
  normalizeMeSoundings,
  normalizeNhContours,
  normalizeVtSoundingLine,
  vtSoundingColumns,
} from './normalize';

function readArcGisPages<T>(key: string, normalize: (features: never[]) => { records: T[] }): T[] {
  const out: T[] = [];
  for (const page of listRawPages(key)) {
    const parsed = JSON.parse(readRawPage(key, page)) as { features?: never[] };
    out.push(...normalize(parsed.features ?? []).records);
  }
  return out;
}

function toLakes(
  sourceKey: string,
  state: string,
  agency: string,
  lane: Lane,
  groups: Map<string, (NormalizedSounding | NormalizedContour)[]>,
): ArchivedLake[] {
  const out: ArchivedLake[] = [];
  for (const [lakeKey, records] of groups) {
    const first = records[0];
    if (!first) continue;
    out.push({
      sourceKey,
      state,
      agency,
      lane,
      lakeKey,
      lakeName: first.lakeName || lakeKey,
      ...(lane === 'soundings'
        ? { soundings: records as NormalizedSounding[] }
        : { contours: records as NormalizedContour[] }),
    });
  }
  return out;
}

/**
 * Stream Vermont's BioBase archive: 2.4M rows out of a 134 MB CSV inside a zip.
 *
 * Grouped as we go rather than materialised and grouped afterwards, which is the out-of-memory version
 * of this. `unzip -p` streams the member to stdout — Node ships no zip reader, and shelling out to a
 * tool that is already a prerequisite beats a dependency to read one file once.
 */
async function readVtBiobase(): Promise<Map<string, NormalizedSounding[]>> {
  const zipPath = path.join(
    rawDir('vt-anr-biobase-soundings'),
    'BiobaseLakeBathymetry_08122020.zip',
  );
  const groups = new Map<string, NormalizedSounding[]>();
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

/** Every lake in the archive, from every source. */
export async function readAllLakes(): Promise<ArchivedLake[]> {
  const lakes: ArchivedLake[] = [];

  lakes.push(
    ...toLakes(
      'nh-granit-contours',
      'NH',
      'NH GRANIT',
      'contours',
      groupByLake(readArcGisPages('nh-granit-contours', normalizeNhContours as never)),
    ),
  );
  lakes.push(
    ...toLakes(
      'ma-massgis-contours',
      'MA',
      'MassGIS / MassWildlife',
      'contours',
      groupByLake(readArcGisPages('ma-massgis-contours', normalizeMaContours as never)),
    ),
  );
  lakes.push(
    ...toLakes(
      'me-dep-soundings',
      'ME',
      'Maine DEP / IF&W',
      'soundings',
      groupByLake(readArcGisPages('me-dep-soundings', normalizeMeSoundings as never)),
    ),
  );
  // Filed under VT, where its source lives. It covers the entire New York shore too, which is NY's
  // only bathymetry of any kind — see `sources.ts`, and don't "fix" the filing.
  lakes.push(
    ...toLakes(
      'vt-vcgi-champlain-soundings',
      'VT',
      'VCGI / NOAA',
      'soundings',
      groupByLake(
        readArcGisPages('vt-vcgi-champlain-soundings', normalizeChamplainSoundings as never),
      ),
    ),
  );
  lakes.push(
    ...toLakes('vt-anr-biobase-soundings', 'VT', 'VT ANR', 'soundings', await readVtBiobase()),
  );

  return lakes;
}
