import { describe, expect, it, vi } from 'vitest';
import { convexRun } from './convexRun';
import { runTeed } from './tee';

vi.mock('./tee', () => ({ runTeed: vi.fn() }));
const teed = vi.mocked(runTeed);

describe('convexRun', () => {
  it('runs the function as a person, through the tee, and parses what it returned', () => {
    teed.mockReturnValueOnce({ status: 0, stdout: '{ "ok": true }\n', stderr: 'a log line\n' });
    expect(
      convexRun('inboxSeed:state', { a: 1 }, { runAs: { as: 'user_1', via: 'seed-inbox' } }),
    ).toEqual({ ok: true });
    expect(teed).toHaveBeenLastCalledWith('pnpm', [
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
  });

  it("a failed call throws the server's sentence, never pnpm's line", () => {
    teed.mockReturnValueOnce({
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
    });
    expect(() => convexRun('bounties:createChecked', {})).toThrow(
      "Could not find function for 'bounties:createChecked'.",
    );
  });

  it('a call that never started throws why', () => {
    teed.mockReturnValueOnce({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('spawn ENOENT'),
    });
    expect(() => convexRun('x:y', {})).toThrow('spawn ENOENT');
  });
});
