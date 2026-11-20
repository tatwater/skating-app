import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backfillArchives } from './backfillArchives';
import { convexRun } from './convexRun';

vi.mock('./convexRun', () => ({ convexRun: vi.fn() }));

const call = vi.mocked(convexRun);
const fetchedAt = '2026-07-31T13:00:00.000Z';
const startedAt = Date.parse(fetchedAt);
let fixtureDirectory: string;

function archive(kind: 'osm' | 'bathymetry') {
  const directory = join(fixtureDirectory, kind);
  mkdirSync(directory);
  return { kind, directory, label: `${kind} fixture` };
}

function writeManifest(directory: string, name: string, manifest: object) {
  const sourceDirectory = join(directory, name);
  mkdirSync(sourceDirectory);
  writeFileSync(join(sourceDirectory, 'manifest.json'), JSON.stringify(manifest));
  return sourceDirectory;
}

beforeEach(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), 'run-log-backfill-'));
  vi.stubEnv('CONVEX_DEPLOY_KEY', undefined);
  vi.stubEnv('CONVEX_DEPLOYMENT', 'dev:backfill-fixture');
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  call.mockReset().mockImplementation((functionName) => {
    if (functionName === 'importRuns:listForBackfill') return [];
    if (functionName === 'importRuns:start') return 'fixture-row';
  });
});

afterEach(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('archive backfill command', () => {
  it('dry-runs without any Convex calls and warns about entries it cannot reconstruct', () => {
    const osm = archive('osm');
    const absentArchive = join(fixtureDirectory, 'absent');
    writeFileSync(join(osm.directory, 'README.txt'), 'not an archive entry');
    mkdirSync(join(osm.directory, 'no-manifest'));
    writeManifest(osm.directory, 'no-date', {});
    writeManifest(osm.directory, 'vermont', { fetchedAt });

    expect(
      backfillArchives(
        ['--dry-run'],
        [osm, { directory: absentArchive, kind: 'bathymetry', label: 'absent archive' }],
      ),
    ).toBe(0);
    expect(call).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledWith(
      '[backfill] no-manifest: no manifest.json — cannot reconstruct\n',
    );
    expect(process.stderr.write).toHaveBeenCalledWith(
      '[backfill] no-date: manifest has no usable fetchedAt — skipping\n',
    );
    expect(process.stderr.write).toHaveBeenCalledWith(
      `[backfill] would record raw_archive "VERMONT OSM extract archive" @ ${fetchedAt}\n`,
    );
    expect(process.stderr.write).toHaveBeenCalledWith(
      `[backfill] no archive at ${absentArchive} — skipping absent archive\n`,
    );
    expect(process.stderr.write).toHaveBeenLastCalledWith(
      '[backfill] 1 run(s) would be recorded, 0 already present\n',
    );
  });

  it('refuses a deployment key with an unknown destination unless explicitly opted in', () => {
    vi.stubEnv('CONVEX_DEPLOY_KEY', 'fixture-only');
    expect(backfillArchives(['--dry-run'], [])).toBe(1);
    expect(process.stderr.write).toHaveBeenCalledWith(
      '[backfill] refusing: not a dev deployment. Re-run with --prod.\n',
    );
    expect(backfillArchives(['--dry-run', '--prod'], [])).toBe(0);
    expect(call).not.toHaveBeenCalled();
  });

  it('skips earlier receipts and duplicates in the same invocation, without changing filed times', () => {
    const osm = archive('osm');
    const duplicateArchive = { ...osm, directory: join(fixtureDirectory, 'duplicate-osm') };
    mkdirSync(duplicateArchive.directory);
    const manifest = {
      state: 'vt',
      slug: 'vermont',
      fetchedAt,
      resolvedUrl: 'https://example.invalid/vermont.osm.pbf',
      filename: 'vermont.osm.pbf',
      bytes: 4,
      md5Verified: true,
    };
    const source = writeManifest(osm.directory, 'a-vermont', manifest);
    writeManifest(duplicateArchive.directory, 'b-vermont', manifest);
    writeManifest(osm.directory, 'nh', { fetchedAt });
    call.mockReturnValueOnce([{ kind: 'raw_archive', label: 'NH OSM extract archive', startedAt }]);

    expect(backfillArchives([], [osm, duplicateArchive])).toBe(0);
    expect(call.mock.calls).toEqual([
      ['importRuns:listForBackfill', {}],
      [
        'importRuns:start',
        {
          kind: 'raw_archive',
          label: 'VT OSM extract archive',
          deployment: 'dev:backfill-fixture',
          isProd: false,
          stages: [
            expect.objectContaining({
              name: 'extract',
              sourceUrl: manifest.resolvedUrl,
              output: join(source, manifest.filename),
              checksumVerified: true,
            }),
          ],
          notes: [
            expect.stringContaining('no duration'),
            "Publisher's md5 verified at fetch time.",
          ],
        },
      ],
      [
        'importRuns:finish',
        {
          runId: 'fixture-row',
          status: 'succeeded',
          counts: [
            { name: 'files', value: 1 },
            { name: 'bytes', value: 4 },
          ],
          notes: [
            expect.stringContaining('no duration'),
            "Publisher's md5 verified at fetch time.",
          ],
        },
      ],
      ['importRuns:restamp', { runId: 'fixture-row', startedAt, finishedAt: startedAt }],
    ]);
    expect(process.stderr.write).toHaveBeenLastCalledWith(
      '[backfill] 1 run(s) recorded, 2 already present\n',
    );
  });

  it('preserves single-file bathymetry provenance and verified-on-disk size without inventing duration', () => {
    const bathymetry = archive('bathymetry');
    const lastModified = 'Wed, 01 Jul 2026 10:00:00 GMT';
    const directory = writeManifest(bathymetry.directory, 'survey', {
      fetchedAt,
      source: { kind: 'static', format: 'zip', url: 'https://example.invalid/survey.zip' },
      http: { lastModified },
      files: [{ name: 'survey.zip', bytes: 3, sha256: 'fixture-sha256' }],
      recordCount: 0,
      service: { fields: [] },
    });
    writeFileSync(join(directory, 'survey.zip'), 'zip');

    backfillArchives([], [bathymetry]);
    expect(call).toHaveBeenCalledWith(
      'importRuns:start',
      expect.objectContaining({
        label: 'survey archive',
        stages: [
          {
            name: 'fetch',
            detail: `static source (zip) — published ${lastModified}`,
            sourceUrl: 'https://example.invalid/survey.zip',
            output: directory,
            bytes: 3,
            sha256: 'fixture-sha256',
            sourceAt: Date.parse(lastModified),
            counts: [
              { name: 'files', value: 1 },
              { name: 'records', value: 0 },
              { name: 'serviceFields', value: 0 },
            ],
          },
        ],
        notes: [expect.stringContaining('no duration')],
      }),
    );
  });

  it('reports missing and truncated files without implying a multi-file checksum', () => {
    const bathymetry = archive('bathymetry');
    const directory = writeManifest(bathymetry.directory, 'survey', {
      fetchedAt,
      source: { kind: 'service' },
      files: [
        { name: 'missing.json', sha256: 'missing-sha256' },
        { name: 'truncated.json', bytes: 7, sha256: 'truncated-sha256' },
      ],
    });
    writeFileSync(join(directory, 'truncated.json'), '{}');

    backfillArchives([], [bathymetry]);
    expect(call).toHaveBeenCalledWith(
      'importRuns:start',
      expect.objectContaining({
        stages: [
          expect.objectContaining({
            detail: 'service source',
            sha256: undefined,
            sourceAt: undefined,
            bytes: 7,
            counts: [{ name: 'files', value: 2 }],
          }),
        ],
        notes: [
          expect.stringContaining('no duration'),
          expect.stringContaining('1 file(s) missing, 1 with a different size'),
        ],
      }),
    );
  });

  it('propagates failure to restamp a receipt instead of reporting it as filed', () => {
    const bathymetry = archive('bathymetry');
    writeManifest(bathymetry.directory, 'survey', { fetchedAt });
    call.mockImplementation((functionName) => {
      if (functionName === 'importRuns:listForBackfill') return [];
      if (functionName === 'importRuns:start') return 'fixture-row';
      if (functionName === 'importRuns:restamp') throw new Error('restamp unavailable');
    });

    expect(() => backfillArchives([], [bathymetry])).toThrow('restamp unavailable');
    expect(process.stderr.write).not.toHaveBeenCalledWith(expect.stringContaining('recorded'));
  });
});
