import { describe, expect, test } from 'vitest';
import { nodeVersionRefusal, parseArgs, USAGE } from './args';

const DEV = { label: 'dev:agile-bee-397', isDev: true };

describe('parseArgs', () => {
  test('a bare run is the dry run, and needs no operator', () => {
    expect(parseArgs([], {}, DEV)).toEqual({ ok: true, mode: 'dry', operator: undefined });
  });

  test('--apply refuses without CONVEX_RUN_AS, or with a blank one', () => {
    for (const env of [{}, { CONVEX_RUN_AS: '  ' }]) {
      const out = parseArgs(['--apply'], env, DEV);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.message).toMatch(/CONVEX_RUN_AS/);
    }
  });

  test('--apply files as the operator named, trimmed', () => {
    expect(parseArgs(['--apply'], { CONVEX_RUN_AS: ' user_op\n' }, DEV)).toEqual({
      ok: true,
      mode: 'apply',
      operator: 'user_op',
    });
  });

  test('--clear is dry; with --apply it removes, and needs no operator', () => {
    expect(parseArgs(['--clear'], {}, DEV)).toMatchObject({ ok: true, mode: 'clear-dry' });
    expect(parseArgs(['--clear', '--apply'], {}, DEV)).toMatchObject({ ok: true, mode: 'clear' });
  });

  test('every mode refuses a target that is not dev — prod, a deploy key, or unknown', () => {
    for (const label of [
      'prod:diligent-guanaco-965',
      'CONVEX_DEPLOY_KEY (target unknown)',
      'unknown',
    ]) {
      for (const argv of [[], ['--apply'], ['--clear'], ['--clear', '--apply']]) {
        const out = parseArgs(argv, { CONVEX_RUN_AS: 'user_op' }, { label, isDev: false });
        expect(out).toEqual({ ok: false, message: expect.stringContaining(label) });
      }
    }
  });

  test('an unknown argument is refused with the usage', () => {
    expect(parseArgs(['--prod'], {}, DEV)).toEqual({
      ok: false,
      message: expect.stringContaining(USAGE),
    });
  });
});

describe('nodeVersionRefusal', () => {
  test('the repo’s major runs; another major is refused plainly', () => {
    expect(nodeVersionRefusal('26.13.1\n', 'v26.0.0')).toBeNull();
    expect(nodeVersionRefusal('26.13.1', 'v24.19.0')).toMatch(/needs Node 26 .* runs v24\.19\.0/);
  });
  test('an empty pin asks nothing', () => {
    expect(nodeVersionRefusal('  ', 'v24.19.0')).toBeNull();
  });
});
