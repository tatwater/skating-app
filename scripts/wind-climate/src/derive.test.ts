import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';
import { convexRun } from '@skating/run-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { responsePath } from './archive';
import { deriveWindClimate } from './derive';
import { gridKey, MIN_ROSE_HOURS, WTK_YEARS } from './wtk';

vi.mock('@skating/run-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@skating/run-log')>()),
  convexRun: vi.fn(),
}));

const call = vi.mocked(convexRun);
const fixtureBody = { waterBodyId: 'first-body', lat: 44.75, lng: -72.05 };
const cellKey = gridKey(fixtureBody);
let directory: string;

function serveCorpus(
  targets: (typeof fixtureBody)[],
  reply = { updated: targets.length, malformed: 0, missing: 0 },
) {
  call.mockImplementation((name) => {
    if (name === 'waterBodies:listNeedingWindRose') {
      return { targets, scanned: targets.length, cursor: 'last', isDone: true };
    }
    if (name === 'importRuns:start') return 'fixture-run';
    if (name === 'waterBodies:importWindRoses') return reply;
    if (name !== 'importRuns:progress' && name !== 'importRuns:finish') {
      throw new Error(`Unexpected function: ${name}`);
    }
  });
}

function stamps() {
  return call.mock.calls
    .filter(([name]) => name === 'waterBodies:importWindRoses')
    .map(([, args]) => args);
}

function saveYear(year: number, rows: string[]) {
  const filePath = join(directory, responsePath(cellKey, year));
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, gzipSync(`metadata\nheader\n${rows.join('\n')}\n`));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'wind-derive-'));
  call.mockReset();
  vi.stubEnv('CONVEX_DEPLOYMENT', 'dev:fixture');
  vi.stubEnv('CONVEX_DEPLOY_KEY', undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('derive must not fetch'))),
  );
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  const fetchMock = globalThis.fetch;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
  expect(fetchMock).not.toHaveBeenCalled();
});

describe('derive wind climate from the archive', () => {
  it('refuses a missing archive or a non-dev deployment without reading the corpus', () => {
    expect(deriveWindClimate([], join(directory, 'absent'))).toBe(1);
    vi.stubEnv('CONVEX_DEPLOYMENT', 'prod:fixture');
    expect(deriveWindClimate([], directory)).toBe(1);
    expect(call).not.toHaveBeenCalled();
  });

  it('names a missing cell and stops before opening a receipt or writing data', () => {
    serveCorpus([fixtureBody]);
    writeFileSync(join(directory, cellKey), 'This is not a cell directory');
    expect(deriveWindClimate([], directory)).toBe(1);
    expect(call.mock.calls.map(([name]) => name)).toEqual(['waterBodies:listNeedingWindRose']);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining(`e.g. ${cellKey}`));
  });

  it('writes the same climate for both bodies in a thin cell without inventing a rose', () => {
    const secondBody = { ...fixtureBody, waterBodyId: 'second-body' };
    serveCorpus([fixtureBody, secondBody]);
    saveYear(2010, ['2010,1,1,0,30,90,10', '2010,7,1,0,30,180,12']);
    expect(deriveWindClimate(['--min-mps=10', '--import-floor'], directory)).toBe(0);
    expect(call).toHaveBeenCalledWith(
      'waterBodies:listNeedingWindRose',
      expect.objectContaining({ importFloorOnly: true }),
    );
    const expected = {
      strongWindHours: Array.from({ length: 16 }, (_, index) => (index === 4 ? 1 : 0)),
      meanWindMps: Array.from({ length: 16 }, (_, index) => (index === 4 ? 10 : null)),
      sampledWindHours: 1,
      strongWindMinMps: 10,
    };
    expect(stamps()).toEqual([
      {
        roses: [fixtureBody, secondBody].map(({ waterBodyId }) => ({ waterBodyId, ...expected })),
      },
    ]);
    expect(call).toHaveBeenCalledWith(
      'importRuns:finish',
      expect.objectContaining({
        status: 'succeeded',
        notes: expect.arrayContaining([expect.stringContaining('4 cell-year(s) absent')]),
      }),
    );
  });

  it('emits a rose without a speed claim when the complete archive only has directions', () => {
    serveCorpus([fixtureBody]);
    for (const year of WTK_YEARS) {
      const rows = Array.from({ length: MIN_ROSE_HOURS / WTK_YEARS.length }, (_, hour) => {
        const date = new Date(Date.UTC(year, 0, 1, hour));
        return `${year},${date.getUTCMonth() + 1},${date.getUTCDate()},${date.getUTCHours()},30,0,NA`;
      });
      saveYear(year, rows);
    }
    expect(deriveWindClimate([], directory)).toBe(0);
    expect(stamps()).toEqual([
      {
        roses: [
          {
            waterBodyId: fixtureBody.waterBodyId,
            rose: [1, ...Array.from({ length: 15 }, () => 0)],
            strongWindHours: Array.from({ length: 16 }, () => 0),
            sampledWindHours: MIN_ROSE_HOURS,
            strongWindMinMps: expect.any(Number),
          },
        ],
      },
    ]);
  });

  it('files an empty successful run without a write when the corpus has no qualifying bodies', () => {
    serveCorpus([]);
    expect(deriveWindClimate([], directory)).toBe(0);
    expect(stamps()).toEqual([]);
    expect(call).toHaveBeenCalledWith(
      'importRuns:finish',
      expect.objectContaining({
        coverage: { unit: 'qualifying bodies', covered: 0, eligible: 0, omissions: [] },
      }),
    );
  });

  it('preserves the server’s rejection and missing-row tallies', () => {
    serveCorpus([fixtureBody, { ...fixtureBody, waterBodyId: 'missing-body' }], {
      updated: 0,
      malformed: 1,
      missing: 1,
    });
    saveYear(2010, ['2010,1,1,0,30,90,10']);
    expect(deriveWindClimate([], directory)).toBe(0);
    expect(call).toHaveBeenCalledWith(
      'importRuns:finish',
      expect.objectContaining({
        coverage: expect.objectContaining({
          eligible: 2,
          covered: 0,
          omissions: expect.arrayContaining([
            { reason: 'rejected server-side as malformed', count: 1 },
            { reason: 'row vanished mid-pass', count: 1 },
          ]),
        }),
      }),
    );
  });
});
