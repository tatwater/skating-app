import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  checkRunTarget,
  type DeploymentTarget,
  isLocalTarget,
  RunTargetRefusal,
} from './runTarget';

/** A target as `resolveDeployment` labels it. */
const target = (label: string): DeploymentTarget => ({
  label,
  isDev: label.startsWith('dev:'),
  isProd: label.startsWith('prod:'),
});

const LOCAL = ['local:local-skating', 'anonymous:anonymous-skating'];
const SHARED = [
  'dev:quick-fox-123',
  'prod:steady-owl-1',
  'unknown',
  'CONVEX_DEPLOY_KEY (target unknown)',
];

describe('where a stage’s run rows may go', () => {
  test('a pilot: a local or anonymous backend only — never dev, prod or an unknown target', () => {
    for (const label of LOCAL)
      expect(() => checkRunTarget('champlain', target(label))).not.toThrow();
    expect(() => checkRunTarget('champlain', target('dev:x'))).toThrow('targets dev');
    expect(() => checkRunTarget('champlain', target('prod:x'))).toThrow('targets prod');
    expect(() => checkRunTarget('champlain', target('unknown'))).toThrow('targets "unknown"');
  });

  test('a build: dev only — never prod, a local backend or an unknown target', () => {
    expect(() => checkRunTarget(null, target('dev:quick-fox-123'))).not.toThrow();
    expect(() => checkRunTarget(null, target('prod:steady-owl-1'))).toThrow(/dev only.*prod/);
    expect(() => checkRunTarget(null, target('unknown'))).toThrow(/dev only/);
    expect(() => checkRunTarget(null, target('local:local-skating'))).toThrow(/dev only/);
  });

  test('every refusal is a RunTargetRefusal (the CLIs print it as refused)', () => {
    expect(() => checkRunTarget(null, target('prod:x'))).toThrow(RunTargetRefusal);
    expect(() => checkRunTarget('p', target('dev:x'))).toThrow(RunTargetRefusal);
  });

  test('a label is local only by its prefix, not by a word inside it', () => {
    expect(LOCAL.every((l) => isLocalTarget(target(l)))).toBe(true);
    expect(SHARED.some((l) => isLocalTarget(target(l)))).toBe(false);
    expect(isLocalTarget(target('dev:local-looking'))).toBe(false);
  });

  test('no target is accepted for both a pilot and a build (a property)', () => {
    const labels = fc.oneof(
      fc.constantFrom(...LOCAL, ...SHARED),
      fc
        .tuple(fc.constantFrom('dev:', 'prod:', 'local:', 'anonymous:', ''), fc.string())
        .map(([p, s]) => p + s),
    );
    fc.assert(
      fc.property(labels, (label) => {
        const ok = (pilot: string | null) => {
          try {
            checkRunTarget(pilot, target(label));
            return true;
          } catch {
            return false;
          }
        };
        return !(ok('p') && ok(null));
      }),
    );
  });
});
