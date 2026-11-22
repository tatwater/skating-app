import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordFromCommandLine } from './cli';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
vi.mock('node:fs', { spy: true });

const execute = vi.mocked(spawnSync);
/** `convex run` exiting cleanly with `stdout`. */
const ran = (stdout: string) => ({ status: 0, stdout, stderr: '' }) as never;
const receipt = { kind: 'r2_mirror', label: 'fixture receipt' };

function calls() {
  return execute.mock.calls.map(([command, args]) => {
    expect(command).toBe('pnpm');
    expect(args?.slice(0, 5)).toEqual(['--filter', '@skating/convex', 'exec', 'convex', 'run']);
    return [args?.[5], JSON.parse(args?.[6] ?? '')];
  });
}

beforeEach(() => {
  vi.stubEnv('CONVEX_DEPLOY_KEY', undefined);
  vi.stubEnv('CONVEX_DEPLOYMENT', 'dev:receipt-fixture');
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  vi.mocked(readFileSync).mockClear();
  execute.mockReset().mockReturnValueOnce(ran('"fixture-row"\n')).mockReturnValue(ran(''));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('record command', () => {
  it('records a live receipt from stdin without restamping or sending absent fields', () => {
    vi.mocked(readFileSync).mockReturnValueOnce(
      JSON.stringify({ ...receipt, error: null, failuresTotal: 0 }),
    );
    expect(recordFromCommandLine([])).toBe(0);
    expect(readFileSync).toHaveBeenCalledWith(0, 'utf8');
    expect(calls()).toEqual([
      [
        'importRuns:start',
        { ...receipt, deployment: 'dev:receipt-fixture', isProd: false, stages: [] },
      ],
      ['importRuns:finish', { runId: 'fixture-row', status: 'succeeded', failuresTotal: 0 }],
    ]);
    expect(process.stderr.write).toHaveBeenCalledWith(
      '[run-log] recorded r2_mirror "fixture receipt" (fixture-row)\n',
    );
  });

  it('records a failed historical receipt with explicit deployment metadata and its original time', () => {
    const startedAt = 1_720_000_000_000;
    const input = JSON.stringify({
      ...receipt,
      deployment: 'other-target-label',
      isProd: false,
      status: 'failed',
      startedAt,
      error: 'fixture failure',
      stages: [{ name: 'mirror' }],
    });
    vi.stubEnv('CONVEX_DEPLOYMENT', 'prod:fixture-only');
    expect(recordFromCommandLine(['--ignored', input])).toBe(0);
    expect(readFileSync).not.toHaveBeenCalled();
    expect(calls()).toEqual([
      [
        'importRuns:start',
        {
          ...receipt,
          deployment: 'other-target-label',
          isProd: false,
          stages: [{ name: 'mirror' }],
        },
      ],
      ['importRuns:finish', { runId: 'fixture-row', status: 'failed', error: 'fixture failure' }],
      ['importRuns:restamp', { runId: 'fixture-row', startedAt, finishedAt: startedAt }],
    ]);
  });

  it('uses the command clock if only a finish timestamp is supplied', () => {
    const startedAt = 1_720_000_000_000;
    const finishedAt = startedAt + 1_000;
    vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    const input = JSON.stringify({ ...receipt, finishedAt });
    expect(recordFromCommandLine([input])).toBe(0);
    expect(calls().at(-1)).toEqual([
      'importRuns:restamp',
      { runId: 'fixture-row', startedAt, finishedAt },
    ]);
  });

  it.each([
    ['   ', /usage:/],
    ['{bad JSON', /not valid JSON/],
  ])('rejects invalid input %j before attempting any write', (input, diagnostic) => {
    expect(recordFromCommandLine([input])).toBe(1);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringMatching(diagnostic));
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports usage if the stdin descriptor cannot be read', () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error('stdin unavailable');
    });
    expect(recordFromCommandLine([])).toBe(1);
    expect(readFileSync).toHaveBeenCalledWith(0, 'utf8');
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringMatching(/usage:/));
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([new Error('finish unavailable'), 'finish unavailable'])(
    'warns without failing the command when the receipt write fails: %s',
    (failure) => {
      execute.mockImplementationOnce(() => {
        throw failure;
      });
      const input = JSON.stringify({ ...receipt, startedAt: 1_720_000_000_000 });
      expect(recordFromCommandLine([input])).toBe(0);
      expect(calls().map(([functionName]) => functionName)).toEqual([
        'importRuns:start',
        'importRuns:finish',
      ]);
      expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith(
        '[run-log] could not record the run (the work itself is unaffected): finish unavailable\n',
      );
    },
  );
});
