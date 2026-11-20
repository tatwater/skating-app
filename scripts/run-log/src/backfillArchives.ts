/**
 * Reconstruct `importRuns` rows for the raw archives that were populated before this table existed.
 *
 *   pnpm --filter @skating/run-log backfill-archives [--dry-run] [--prod]
 *
 * **Why this is honest rather than fabrication.** Nothing here is invented: every field comes out of
 * a manifest the fetcher already wrote at the time — `fetchedAt`, the resolved source URL, per-file
 * sizes and sha256s, the service's own record count. The run rows were never written because there
 * was nowhere to write them; the provenance itself has been on disk since 2026-07-31. What the
 * backfill cannot know, it does not claim: there is no duration (a manifest records when a fetch
 * *finished*, not when it started), so `startedAt` and `finishedAt` are the same instant and the
 * page shows no elapsed time.
 *
 * Skips receipts already present in the recent run history by `(kind, label, startedAt)`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { convexRun } from './convexRun';
import { resolveDeployment } from './deployment';
import type { ExtractManifest } from './provenance';
import { extractStage } from './provenance';
import { writeRunReceipt } from './runReceipt';
import type { RunCount, RunStage } from './types';

interface Archive {
  label: string;
  directory: string;
  kind: 'osm' | 'bathymetry';
}

/** The two `.raw/` archives that mirror to private R2 buckets. */
const ARCHIVES: readonly Archive[] = [
  {
    label: 'OSM extracts',
    directory: new URL('../../etl/.raw/', import.meta.url).pathname,
    kind: 'osm',
  },
  {
    label: 'lake bathymetry sources',
    directory: new URL('../../bathymetry/.raw/', import.meta.url).pathname,
    kind: 'bathymetry',
  },
];

/** `scripts/bathymetry/src/fetch.ts`'s manifest — a different shape from the OSM one. */
interface BathymetryManifest {
  fetchedAt?: string;
  source?: { url?: string; kind?: string; format?: string };
  files?: { name: string; bytes: number; sha256: string }[];
  recordCount?: number;
  http?: { lastModified?: string };
  service?: { fields?: { name: string; type: string }[] };
}

interface ArchiveRunKey {
  kind: string;
  label: string;
  startedAt: number;
}

interface ArchiveRun extends ArchiveRunKey {
  kind: 'raw_archive';
  stages: RunStage[];
  counts: RunCount[];
  notes: string[];
}

const RECONSTRUCTED_NOTE =
  'Reconstructed from the archive manifest — this run predates the run-history table, so there is no duration.';

function archiveRunKey(run: ArchiveRunKey): string {
  return `${run.kind}|${run.label}|${run.startedAt}`;
}

export function backfillArchives(args: string[], archives = ARCHIVES): number {
  const dryRun = args.includes('--dry-run');
  const allowNonDev = args.includes('--prod');

  const target = resolveDeployment();
  process.stderr.write(`[backfill] target deployment: ${target.label}\n`);
  if (!target.isDev && !allowNonDev) {
    process.stderr.write('[backfill] refusing: not a dev deployment. Re-run with --prod.\n');
    return 1;
  }

  const existing = dryRun ? [] : convexRun<ArchiveRunKey[]>('importRuns:listForBackfill', {});
  const seen = new Set(existing.map(archiveRunKey));

  let receiptCount = 0;
  let alreadyPresentCount = 0;

  for (const archive of archives) {
    for (const run of readArchiveRuns(archive)) {
      const dedupeKey = archiveRunKey(run);
      if (seen.has(dedupeKey)) {
        alreadyPresentCount++;
        continue;
      }

      if (dryRun) {
        process.stderr.write(
          `[backfill] would record ${run.kind} "${run.label}" @ ${new Date(run.startedAt).toISOString()}\n`,
        );
        receiptCount++;
        continue;
      }

      // Unlike the receipt CLI, a failed write is a failure of the backfill itself. Don't catch
      // it or mark the row as seen until all three calls, including the restamp, succeed.
      writeRunReceipt(run, target, convexRun);
      seen.add(dedupeKey);
      receiptCount++;
      process.stderr.write(`[backfill] recorded ${run.kind} "${run.label}"\n`);
    }
  }

  process.stderr.write(
    `[backfill] ${receiptCount} run(s) ${dryRun ? 'would be recorded' : 'recorded'}, ${alreadyPresentCount} already present\n`,
  );
  return 0;
}

function* readArchiveRuns(archive: Archive): Generator<ArchiveRun> {
  if (!existsSync(archive.directory)) {
    process.stderr.write(
      `[backfill] no archive at ${archive.directory} — skipping ${archive.label}\n`,
    );
    return;
  }
  for (const entry of readdirSync(archive.directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(archive.directory, entry.name);
    const manifestPath = join(directory, 'manifest.json');
    if (!existsSync(manifestPath)) {
      process.stderr.write(`[backfill] ${entry.name}: no manifest.json — cannot reconstruct\n`);
      continue;
    }
    const manifestJson = readFileSync(manifestPath, 'utf8');
    const manifest: BathymetryManifest | ExtractManifest = JSON.parse(manifestJson);
    const startedAt = Date.parse(manifest.fetchedAt ?? '');
    if (!Number.isFinite(startedAt)) {
      process.stderr.write(
        `[backfill] ${entry.name}: manifest has no usable fetchedAt — skipping\n`,
      );
      continue;
    }
    yield archive.kind === 'osm'
      ? osmRun(manifest as ExtractManifest, entry.name, directory, startedAt)
      : bathymetryRun(manifest as BathymetryManifest, entry.name, directory, startedAt);
  }
}

/** One archived Geofabrik extract. */
function osmRun(
  manifest: ExtractManifest,
  archiveName: string,
  directory: string,
  startedAt: number,
): ArchiveRun {
  return {
    kind: 'raw_archive',
    label: `${(manifest.state ?? archiveName).toUpperCase()} OSM extract archive`,
    startedAt,
    stages: [extractStage(manifest, join(directory, manifest.filename ?? ''))],
    counts: [
      { name: 'files', value: 1 },
      ...(manifest.bytes ? [{ name: 'bytes', value: manifest.bytes }] : []),
    ],
    notes: [
      RECONSTRUCTED_NOTE,
      manifest.md5Verified
        ? "Publisher's md5 verified at fetch time."
        : "Publisher's md5 was NOT verified at fetch time.",
    ],
  };
}

/** One archived state-agency bathymetry source. */
function bathymetryRun(
  manifest: BathymetryManifest,
  archiveName: string,
  directory: string,
  startedAt: number,
): ArchiveRun {
  const files = manifest.files ?? [];
  const bytes = files.reduce((sum, file) => sum + (file.bytes ?? 0), 0);
  const fileCount = { name: 'files', value: files.length };
  const recordCounts: RunCount[] =
    manifest.recordCount === undefined ? [] : [{ name: 'records', value: manifest.recordCount }];
  const notes = [RECONSTRUCTED_NOTE];
  const mismatch = findArchiveMismatch(directory, files);
  if (mismatch) notes.push(mismatch);

  return {
    kind: 'raw_archive',
    label: `${archiveName} archive`,
    startedAt,
    stages: [
      {
        name: 'fetch',
        detail: bathymetrySourceDetail(manifest),
        sourceUrl: manifest.source?.url,
        output: directory,
        bytes,
        // Only a single-file fetch has a stage-level checksum; multi-page ArcGIS pulls record
        // one per page in the manifest beside the files.
        sha256: files.length === 1 ? files[0]?.sha256 : undefined,
        sourceAt: Date.parse(manifest.http?.lastModified ?? '') || undefined,
        counts: [
          fileCount,
          ...recordCounts,
          ...(manifest.service?.fields
            ? [{ name: 'serviceFields', value: manifest.service.fields.length }]
            : []),
        ],
      },
    ],
    counts: [fileCount, { name: 'bytes', value: bytes }, ...recordCounts],
    notes,
  };
}

function bathymetrySourceDetail(manifest: BathymetryManifest): string {
  if (!manifest.source?.kind) return 'third-party source';
  const format = manifest.source.format ? ` (${manifest.source.format})` : '';
  const publishedAt = manifest.http?.lastModified
    ? ` — published ${manifest.http.lastModified}`
    : '';
  return `${manifest.source.kind} source${format}${publishedAt}`;
}

function findArchiveMismatch(directory: string, files: NonNullable<BathymetryManifest['files']>) {
  // Verify the archive still matches what the manifest says it fetched. A silently truncated or
  // half-synced archive is the failure this reconstruction would otherwise paper over — it would
  // record a clean historical fetch for files that are no longer there.
  let missingFileCount = 0;
  let wrongSizeFileCount = 0;
  for (const file of files) {
    const filePath = join(directory, file.name);
    if (!existsSync(filePath)) missingFileCount++;
    else if (statSync(filePath).size !== file.bytes) wrongSizeFileCount++;
  }
  if (missingFileCount === 0 && wrongSizeFileCount === 0) return undefined;
  return `⚠ The local archive no longer matches this manifest: ${missingFileCount} file(s) missing, ${wrongSizeFileCount} with a different size. Re-fetch or re-pull from R2 before trusting it.`;
}

if (import.meta.main) process.exitCode = backfillArchives(process.argv.slice(2));
