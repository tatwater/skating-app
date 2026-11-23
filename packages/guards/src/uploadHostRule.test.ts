/**
 * **The seed's upload host rule is the server's "this is dev" rule** (B01's close-out). The dev seed
 * posts photo bytes only to the deployment's own address (`scripts/seed-inbox/src/upload.ts`,
 * `uploadRefusal`), and the server decides it is dev by its own URL (`lib/deployment.ts`,
 * `isDevDeployment`): `https:`, exactly `<name>.convex.cloud`, no port. Two copies of one rule drift,
 * so one table of look-alike addresses runs through both, and each must agree with the table and
 * with the other — the script never uploads to an address the server wouldn't call its own.
 *
 * In `@skating/guards`: it runs two packages' sources, which no Turbo input glob of either package's
 * own test task would hash for this check (D236).
 */

import { describe, expect, test } from 'vitest';
import { UPLOAD_HOST_CASES, uploadRefusal } from '../../../scripts/seed-inbox/src/upload';
import { DEV_DEPLOYMENT, isDevDeployment } from '../../convex/convex/lib/deployment';

/** The server reads its own URL's origin; an upload address carries a path and a query past it. */
const serverSays = (url: string, name: string): boolean => {
  if (name !== DEV_DEPLOYMENT) return false;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return isDevDeployment(url);
  }
  return isDevDeployment(origin);
};

describe('one host rule for the seed and the server', () => {
  const cases = UPLOAD_HOST_CASES(DEV_DEPLOYMENT);

  test('the table has both answers and the look-alikes', () => {
    expect(cases.filter(([, own]) => own).length).toBeGreaterThan(0);
    expect(cases.filter(([, own]) => !own).length).toBeGreaterThan(5);
  });

  test.each(cases)('%s → own: %s, by both rules', (url, own) => {
    expect(uploadRefusal(url, DEV_DEPLOYMENT) === null, 'the seed’s rule').toBe(own);
    expect(serverSays(url, DEV_DEPLOYMENT), 'the server’s rule').toBe(own);
  });

  test('another deployment’s own address is never dev to the server, whatever the seed allows it', () => {
    for (const [url, own] of UPLOAD_HOST_CASES('happy-cat-123')) {
      expect(uploadRefusal(url, 'happy-cat-123') === null).toBe(own);
      expect(isDevDeployment(url)).toBe(false);
    }
  });
});
