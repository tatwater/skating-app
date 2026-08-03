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
 * Idempotent by `(kind, label, startedAt)` — re-running adds nothing.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { convexRun } from './convexRun';
import { resolveDeployment } from './deployment';
import { extractStage } from './provenance';
import type { RunCount, RunStage } from './types';

/** The two `.raw/` archives that mirror to private R2 buckets. */
const ARCHIVES = [
  {
    label: 'OSM extracts',
    dir: new URL('../../etl/.raw/', import.meta.url),
    bucket: 'skating-raw-lake-osm',
    kind: 'osm' as const,
  },
  {
    label: 'lake bathymetry sources',
    dir: new URL('../../bathymetry/.raw/', import.meta.url),
    bucket: 'skating-raw-lake-bathymetry',
    kind: 'bathymetry' as const,
  },
];

/** `scripts/bathymetry/src/fetch.ts`'s manifest — a different shape from the OSM one. */
interface BathyManifest {
  key?: string;
  fetchedAt?: string;
  source?: { url?: string; kind?: string; format?: string };
  files?: { name: string; bytes: number; sha256: string }[];
  recordCount?: number;
  http?: { lastModified?: string; etag?: string; contentLength?: number };
  service?: { fields?: { name: string; type: string }[] };
}

interface OsmManifest {
  state?: string;
  slug?: string;
  fetchedAt?: string;
  requestedUrl?: string;
  resolvedUrl?: string;
  filename?: string;
  bytes?: number;
  sha256?: string;
  buildDate?: string;
  publishedMd5?: string;
  md5Verified?: boolean;
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const allowNonDev = args.includes('--prod');

  const target = resolveDeployment();
  process.stderr.write(`[backfill] target deployment: ${target.label}\n`);
  if (!target.isDev && !allowNonDev) {
    process.stderr.write('[backfill] refusing: not a dev deployment. Re-run with --prod.\n');
    process.exit(1);
  }

  const existing = dryRun
    ? []
    : convexRun<{ kind: string; label: string; startedAt: number }[]>(
        'importRuns:listForBackfill',
        {},
      );
  const seen = new Set(existing.map((r) => `${r.kind}|${r.label}|${r.startedAt}`));

  let written = 0;
  let skipped = 0;

  for (const archive of ARCHIVES) {
    const root = archive.dir.pathname;
    if (!existsSync(root)) {
      process.stderr.write(`[backfill] no archive at ${root} — skipping ${archive.label}\n`);
      continue;
    }

    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const manifestPath = join(dir, 'manifest.json');
      if (!existsSync(manifestPath)) {
        process.stderr.write(`[backfill] ${entry.name}: no manifest.json — cannot reconstruct\n`);
        continue;
      }

      const run =
        archive.kind === 'osm'
          ? osmRun(manifestPath, entry.name, dir)
          : bathymetryRun(manifestPath, entry.name, dir);
      if (!run) continue;

      const dedupeKey = `${run.kind}|${run.label}|${run.startedAt}`;
      if (seen.has(dedupeKey)) {
        skipped++;
        continue;
      }

      if (dryRun) {
        process.stderr.write(
          `[backfill] would record ${run.kind} "${run.label}" @ ${new Date(run.startedAt).toISOString()}\n`,
        );
        written++;
        continue;
      }

      const runId = convexRun<string>('importRuns:start', {
        kind: run.kind,
        label: run.label,
        deployment: target.label,
        isProd: target.isProd,
        stages: run.stages,
        notes: run.notes,
      });
      convexRun('importRuns:finish', {
        runId,
        status: 'succeeded',
        counts: run.counts,
        notes: run.notes,
      });
      convexRun('importRuns:restamp', {
        runId,
        startedAt: run.startedAt,
        finishedAt: run.startedAt,
      });
      seen.add(dedupeKey);
      written++;
      process.stderr.write(`[backfill] recorded ${run.kind} "${run.label}"\n`);
    }
  }

  process.stderr.write(
    `[backfill] ${written} run(s) ${dryRun ? 'would be recorded' : 'recorded'}, ${skipped} already present\n`,
  );
}

interface Reconstructed {
  kind: string;
  label: string;
  startedAt: number;
  stages: RunStage[];
  counts: RunCount[];
  notes: string[];
}

/** One archived Geofabrik extract. */
function osmRun(manifestPath: string, name: string, dir: string): Reconstructed | undefined {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as OsmManifest;
  const fetchedAt = Date.parse(m.fetchedAt ?? '');
  if (!Number.isFinite(fetchedAt)) {
    process.stderr.write(`[backfill] ${name}: manifest has no usable fetchedAt — skipping\n`);
    return undefined;
  }
  return {
    kind: 'raw_archive',
    label: `${(m.state ?? name).toUpperCase()} OSM extract archive`,
    startedAt: fetchedAt,
    stages: [extractStage(m, join(dir, m.filename ?? ''))],
    counts: [{ name: 'files', value: 1 }, ...(m.bytes ? [{ name: 'bytes', value: m.bytes }] : [])],
    notes: [
      'Reconstructed from the archive manifest — this run predates the run-history table, so there is no duration.',
      m.md5Verified
        ? "Publisher's md5 verified at fetch time."
        : "Publisher's md5 was NOT verified at fetch time.",
    ],
  };
}

/** One archived state-agency bathymetry source. */
function bathymetryRun(manifestPath: string, name: string, dir: string): Reconstructed | undefined {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as BathyManifest;
  const fetchedAt = Date.parse(m.fetchedAt ?? '');
  if (!Number.isFinite(fetchedAt)) {
    process.stderr.write(`[backfill] ${name}: manifest has no usable fetchedAt — skipping\n`);
    return undefined;
  }

  const files = m.files ?? [];
  const bytes = files.reduce((sum, f) => sum + (f.bytes ?? 0), 0);
  // Verify the archive still matches what the manifest says it fetched. A silently truncated or
  // half-synced archive is the failure this reconstruction would otherwise paper over — it would
  // record a clean historical fetch for files that are no longer there.
  const missing = files.filter((f) => !existsSync(join(dir, f.name)));
  const wrongSize = files.filter((f) => {
    const path = join(dir, f.name);
    return existsSync(path) && statSync(path).size !== f.bytes;
  });

  const stages: RunStage[] = [
    {
      name: 'fetch',
      detail: m.source?.kind
        ? `${m.source.kind} source${m.source.format ? ` (${m.source.format})` : ''}${
            m.http?.lastModified ? ` — published ${m.http.lastModified}` : ''
          }`
        : 'third-party source',
      sourceUrl: m.source?.url,
      output: dir,
      bytes,
      // A multi-page ArcGIS pull has one sha256 per page, so the single-file case is the only one
      // where a stage-level checksum means anything; the rest are in the manifest beside the files.
      sha256: files.length === 1 ? files[0]?.sha256 : undefined,
      sourceAt: m.http?.lastModified ? Date.parse(m.http.lastModified) || undefined : undefined,
      counts: [
        { name: 'files', value: files.length },
        ...(m.recordCount !== undefined ? [{ name: 'records', value: m.recordCount }] : []),
        ...(m.service?.fields ? [{ name: 'serviceFields', value: m.service.fields.length }] : []),
      ],
    },
  ];

  const notes = [
    'Reconstructed from the archive manifest — this run predates the run-history table, so there is no duration.',
  ];
  if (missing.length > 0 || wrongSize.length > 0) {
    notes.push(
      `⚠ The local archive no longer matches this manifest: ${missing.length} file(s) missing, ${wrongSize.length} with a different size. Re-fetch or re-pull from R2 before trusting it.`,
    );
  }

  return {
    kind: 'raw_archive',
    label: `${name} archive`,
    startedAt: fetchedAt,
    stages,
    counts: [
      { name: 'files', value: files.length },
      { name: 'bytes', value: bytes },
      ...(m.recordCount !== undefined ? [{ name: 'records', value: m.recordCount }] : []),
    ],
    notes,
  };
}

main();
