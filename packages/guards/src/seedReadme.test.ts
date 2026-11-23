/**
 * **The seed's README says what a full apply leaves, as the plan test does** — it went stale once
 * (90 steps, 23 open, 12 decided, after the plan had grown to 123, 27 and 14). The figures live in one
 * place, the plan test's full apply (`packages/convex/convex/inboxSeed.test.ts`); this holds the
 * README's paragraph to them: the step count, the open and decided totals, and each lane's open.
 *
 * In `@skating/guards`: it reads two packages' files, which no Turbo input glob of either package's own
 * test task would hash for this check (D236).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const REPO = resolve(__dirname, '../../..');
const README = readFileSync(resolve(REPO, 'scripts/seed-inbox/README.md'), 'utf8');
const PLAN_TEST = readFileSync(resolve(REPO, 'packages/convex/convex/inboxSeed.test.ts'), 'utf8');

/** The README's lane names, as the plan test's lane keys. */
const LANES: Record<string, string> = {
  Safety: 'safety',
  'Access reports': 'accessReports',
  Requests: 'requests',
  'Places asked': 'placesAsked',
  'Drawn bodies': 'drawnBodies',
  'Content flags': 'contentFlags',
  Support: 'support',
};

function plan() {
  const steps = /expect\(steps\)\.toHaveLength\((\d+)\)/.exec(PLAN_TEST)?.[1];
  const block = /expect\(await lanesOf\(t\)\)\.toEqual\(\{([\s\S]*?)\n {4}\}\);/.exec(
    PLAN_TEST,
  )?.[1];
  if (steps === undefined || block === undefined) throw new Error('the plan test changed shape');
  const num = (re: RegExp) => Number(re.exec(block)?.[1]);
  const lanes = Object.fromEntries(
    Object.values(LANES).map((key) => [key, num(new RegExp(`${key}: \\{\\s*open: (\\d+)`))]),
  );
  return {
    steps: Number(steps),
    allOpen: num(/allOpen: (\d+)/),
    decided: num(/decided: (\d+)/),
    lanes,
  };
}

function readme() {
  const para = /\*\*What a full apply leaves\*\*([\s\S]*?)\n\n/.exec(README)?.[1];
  if (para === undefined) throw new Error('the README lost its full-apply paragraph');
  const flat = para.replace(/\s+/g, ' ');
  const num = (re: RegExp) => Number(re.exec(flat)?.[1]);
  const lanes = Object.fromEntries(
    Object.entries(LANES).map(([name, key]) => [key, num(new RegExp(`${name} (\\d+)`))]),
  );
  return {
    steps: num(/\((\d+) steps/),
    allOpen: num(/(\d+) open Inbox items/),
    decided: num(/and (\d+) decided/),
    lanes,
  };
}

test('the seed README’s full apply is the plan test’s: steps, open, decided, each lane', () => {
  const p = plan();
  expect(Object.values(p.lanes).every(Number.isFinite)).toBe(true);
  expect(readme()).toEqual(p);
});
