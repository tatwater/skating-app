import { describe, expect, test } from 'vitest';
import { main } from './tilesRunArgs';

function run(argv: string[], label = 'dev:quick-fox-123', isProd = false) {
  const out: string[] = [];
  const err: string[] = [];
  const status = main(argv, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    target: () => ({ label, isProd }),
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
    const r = run(['naip-20261212'], 'prod:steady-owl-1', true);
    expect(r.status).toBe(64);
    expect(r.err[0]).toMatch(/dev only/);
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
