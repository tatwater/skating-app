import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convexRun } from './convexRun';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
const spawn = vi.mocked(spawnSync);

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  spawn.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('convexRun', () => {
  it('runs the function as a person and parses what it returned, showing its logs', () => {
    spawn.mockReturnValueOnce({
      status: 0,
      stdout: '{ "ok": true }\n',
      stderr: 'a log line\n',
    } as never);
    expect(
      convexRun('inboxSeed:state', { a: 1 }, { runAs: { as: 'user_1', via: 'seed-inbox' } }),
    ).toEqual({
      ok: true,
    });
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      '--filter',
      '@skating/convex',
      'exec',
      'convex',
      'run',
      'inboxSeed:state',
      '{"a":1}',
      '--identity',
      '{"subject":"user_1","via":"seed-inbox"}',
    ]);
    expect(process.stderr.write).toHaveBeenCalledWith('a log line\n');
  });

  it("a failed call throws the server's sentence, never pnpm's line", () => {
    spawn.mockReturnValueOnce({
      status: 1,
      stdout: '',
      stderr: [
        '✖ Failed to run function "bounties:createChecked":',
        'Error: [Request ID: 6a1f] Server Error',
        "Could not find function for 'bounties:createChecked'.",
        '',
        'Available functions:',
        '• bounties:create',
        ' ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command failed with exit code 1: convex run …',
      ].join('\n'),
    } as never);
    expect(() => convexRun('bounties:createChecked', {})).toThrow(
      "Could not find function for 'bounties:createChecked'.",
    );
  });

  it('a call that never started throws why; one with no stderr says it failed with no message', () => {
    spawn.mockReturnValueOnce({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('spawn pnpm ENOENT'),
    } as never);
    expect(() => convexRun('x:y', {})).toThrow('spawn pnpm ENOENT');
    spawn.mockReturnValueOnce({ status: 1, stdout: null, stderr: null } as never);
    expect(() => convexRun('x:y', {})).toThrow('convex run failed with no message');
  });
});
