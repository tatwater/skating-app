import { describe, expect, test } from 'vitest';
import { main } from './tilesRunArgs';

function run(argv: string[], label = 'dev:quick-fox-123') {
  const out: string[] = [];
  const err: string[] = [];
  const status = main(argv, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    target: () => ({ label, isDev: label.startsWith('dev:'), isProd: label.startsWith('prod:') }),
  });
  return { status, out, err };
}

describe('run-aerial.sh’s refusals', () => {
  test('all runs the four stages in order; one stage runs alone', () => {
    expect(run(['naip-20261212']).out).toEqual(['select', 'tiles', 'assemble', 'verify']);
    expect(run(['naip-20261212', '--stage', 'tiles']).out).toEqual(['tiles']);
    expect(run(['naip-20261212', '--stage=assemble', '--dry-run']).out).toEqual(['assemble']);
  });

  test('a bad argument is refused with 64 before anything starts', () => {
    for (const argv of [[], ['--stage', 'all'], ['naip-2026'], ['naip-20261212', '--bogus']]) {
      const r = run(argv);
      expect(r.status).toBe(64);
      expect(r.out).toEqual([]);
      expect(r.err[0]).toMatch(/^refused: /);
    }
  });

  test('a pilot against dev (or an unknown target) is refused; against a local backend it runs', () => {
    const argv = ['naip-pilot-20261125', '--pilot', 'champlain-nhma-me-ny', '--cells', 'c.txt'];
    expect(run(argv).err[0]).toMatch(/local deployment only/);
    expect(run(argv, 'unknown').status).toBe(64);
    expect(run(argv, 'local:local-skating').out).toEqual(['select', 'tiles', 'assemble', 'verify']);
  });

  test('nothing writes prod’s rows', () => {
    const r = run(['naip-20261212'], 'prod:steady-owl-1');
    expect(r.status).toBe(64);
    expect(r.err[0]).toMatch(/dev only/);
  });

  test('a build to anything but dev is refused, by the same rule every stage applies', () => {
    for (const label of ['unknown', 'local:local-skating']) {
      const r = run(['naip-20261212'], label);
      expect(r.status).toBe(64);
      expect(r.err[0]).toMatch(/dev only/);
    }
  });

  test('a dry run writes no row, so its target is not checked (as no stage checks it)', () => {
    expect(run(['naip-20261212', '--dry-run'], 'unknown').status).toBe(0);
    const pilot = [
      'naip-pilot-20261125',
      '--pilot',
      'champlain-nhma-me-ny',
      '--cells',
      'c.txt',
      '--dry-run',
    ];
    expect(run(pilot, 'dev:quick-fox-123').out).toEqual(['select', 'tiles', 'assemble', 'verify']);
  });

  test('anything but a refusal is thrown, not swallowed', () => {
    expect(() =>
      main(['naip-20261212'], {
        out: () => {},
        err: () => {},
        target: () => {
          throw new Error('boom');
        },
      }),
    ).toThrow('boom');
  });
});
