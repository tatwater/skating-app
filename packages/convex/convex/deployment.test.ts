import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import { DEV_DEPLOYMENT, isDevDeployment, isProdDeployment } from './lib/deployment';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/**
 * **A run row's `isProd` is the one exact deployment check** (`lib/deployment`, B01-5). Each of the
 * three run-row writers labels a look-alike host as prod — a name that merely contains dev's used to
 * pass a substring test — and labels dev's own URL as dev, exactly as before.
 */

const DEV_URL = `https://${DEV_DEPLOYMENT}.convex.cloud`;
const LOOK_ALIKE = `https://${DEV_DEPLOYMENT}0.convex.cloud`;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function runRowIsProd(
  url: string,
  run: (t: ReturnType<typeof convexTest>) => Promise<unknown>,
): Promise<boolean> {
  vi.stubEnv('CONVEX_CLOUD_URL', url);
  const t = convexTest(schema, modules);
  await run(t);
  const rows = await t.run((ctx) => ctx.db.query('importRuns').collect());
  expect(rows).toHaveLength(1);
  return (rows[0] as { isProd: boolean }).isProd;
}

const CALLERS: [string, (t: ReturnType<typeof convexTest>) => Promise<unknown>][] = [
  [
    'standing.runStandingRollover',
    (t) => t.action(internal.standing.runStandingRollover, { season: 2029 }),
  ],
  ['regionStats.recompute', (t) => t.action(internal.regionStats.recompute, {})],
  [
    'waterBodies.sweepAllBodySummaries',
    (t) => t.action(internal.waterBodies.sweepAllBodySummaries, {}),
  ],
];

describe('every run row labels its deployment by the exact check', () => {
  for (const [name, run] of CALLERS) {
    test(`${name}: a look-alike host is prod; dev's own URL is not`, async () => {
      expect(await runRowIsProd(LOOK_ALIKE, run)).toBe(true);
      expect(await runRowIsProd(DEV_URL, run)).toBe(false);
    });
  }

  test('the check itself fails toward prod', () => {
    expect(isDevDeployment(DEV_URL)).toBe(true);
    expect(isProdDeployment(DEV_URL)).toBe(false);
    for (const url of [
      LOOK_ALIKE,
      `https://x${DEV_DEPLOYMENT}.convex.cloud`,
      `https://${DEV_DEPLOYMENT}.convex.cloud.evil.example`,
      `http://${DEV_DEPLOYMENT}.convex.cloud`,
      `https://${DEV_DEPLOYMENT}.convex.cloud:8443`,
      `https://evil.example/${DEV_DEPLOYMENT}.convex.cloud`,
      '',
      'not a url',
    ]) {
      expect(isProdDeployment(url)).toBe(true);
    }
  });
});
