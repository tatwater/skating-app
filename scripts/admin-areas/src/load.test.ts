import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { convexRun } from '@skating/run-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAdminAreas } from './load';

vi.mock('@skating/run-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@skating/run-log')>()),
  convexRun: vi.fn(),
}));

const call = vi.mocked(convexRun);
let fixtureDirectory: string;

function writeAreas(count: number, malformedFirstRow = false): string {
  const inputPath = join(fixtureDirectory, 'areas.ndjson');
  const lines = Array.from({ length: count }, (_, index) =>
    index === 0 && malformedFirstRow ? '{' : JSON.stringify({ externalId: `relation/${index}` }),
  );
  writeFileSync(inputPath, `\n${lines.join('\n')}\n\n`);
  return inputPath;
}

function simulateImports(importAreas: () => unknown) {
  call.mockImplementation((functionName) => {
    if (functionName === 'adminAreas:importCanonical') return importAreas();
    if (functionName === 'importRuns:start') return 'fixture-run';
  });
}

function writesTo(functionName: string) {
  return call.mock.calls.filter(([name]) => name === functionName).map(([, args]) => args);
}

beforeEach(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), 'admin-areas-load-'));
  vi.stubEnv('CONVEX_DEPLOYMENT', 'dev:fixture');
  vi.stubEnv('CONVEX_DEPLOY_KEY', undefined);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  call.mockReset();
});

afterEach(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('load admin areas', () => {
  it('requires a known state and refuses non-dev before reading input or writing', () => {
    expect(loadAdminAreas(['missing-file'])).toBe(1);
    expect(loadAdminAreas(['missing-file', '--state=zz'])).toBe(1);
    vi.stubEnv('CONVEX_DEPLOYMENT', 'prod:fixture');
    expect(loadAdminAreas(['missing-file', '--state=vt'])).toBe(1);
    expect(call).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('unknown --state=ZZ'),
    );
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('not a dev deployment'),
    );
  });

  it('stamps the normalized state on every row and can load without a receipt', () => {
    simulateImports(() => ({ inserted: 2, updated: 0 }));
    const inputPath = writeAreas(2);
    expect(loadAdminAreas([inputPath, '--state=vt', '--no-run-log'])).toBe(0);
    expect(call.mock.calls).toEqual([
      [
        'adminAreas:importCanonical',
        {
          areas: [
            { externalId: 'relation/0', state: 'VT' },
            { externalId: 'relation/1', state: 'VT' },
          ],
        },
      ],
    ]);
  });

  it('reports a malformed batch and still imports the later batch', () => {
    simulateImports(() => ({ inserted: 1, updated: 0 }));
    expect(loadAdminAreas([writeAreas(151, true), '--state=VT', '--campaign=fixture'])).toBe(1);
    expect(writesTo('importRuns:start')).toEqual([
      expect.objectContaining({
        kind: 'admin_areas',
        label: 'VT admin areas',
        campaignId: 'fixture',
      }),
    ]);
    expect(writesTo('adminAreas:importCanonical')).toEqual([
      { areas: [{ externalId: 'relation/150', state: 'VT' }] },
    ]);
    expect(writesTo('importRuns:finish')).toEqual([
      expect.objectContaining({
        status: 'failed',
        coverage: {
          unit: 'admin areas',
          eligible: 151,
          covered: 1,
          omissions: [{ reason: 'in a batch that failed and was skipped', count: 150 }],
        },
      }),
    ]);
  });

  it('stops on the fifth consecutive failed batch and leaves unattempted rows unexplained', () => {
    simulateImports(() => {
      throw 'fixture deployment unavailable';
    });
    expect(() => loadAdminAreas([writeAreas(751), '--state=VT'])).toThrow(
      'fixture deployment unavailable',
    );
    expect(writesTo('adminAreas:importCanonical')).toHaveLength(5);
    expect(writesTo('importRuns:finish')).toEqual([
      expect.objectContaining({
        status: 'failed',
        failuresTotal: 5,
        coverage: expect.objectContaining({
          eligible: 751,
          covered: 0,
          omissions: [{ reason: 'in a batch that failed and was skipped', count: 750 }],
        }),
      }),
    ]);
  });

  it.each([null, 0, { updated: 1 }, { inserted: 1 }])(
    'does not count an unexpected mutation response as applied: %j',
    (response) => {
      simulateImports(() => response);
      expect(loadAdminAreas([writeAreas(1), '--state=VT'])).toBe(1);
      expect(writesTo('importRuns:finish')).toEqual([
        expect.objectContaining({
          status: 'failed',
          failures: [
            expect.objectContaining({ reason: expect.stringContaining('unexpected response') }),
          ],
        }),
      ]);
    },
  );

  it('flushes running totals after 25 batches and closes a replay as succeeded', () => {
    simulateImports(() => ({ inserted: 0, updated: 150 }));
    expect(loadAdminAreas([writeAreas(3_750), '--state=VT'])).toBe(0);
    expect(writesTo('importRuns:progress')).toEqual([
      expect.objectContaining({
        counts: [
          { name: 'inserted', value: 0 },
          { name: 'updated', value: 3_750 },
          { name: 'batchesApplied', value: 25 },
        ],
      }),
    ]);
    expect(writesTo('importRuns:finish')).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        coverage: { unit: 'admin areas', eligible: 3_750, covered: 3_750, omissions: [] },
      }),
    ]);
  });
});
