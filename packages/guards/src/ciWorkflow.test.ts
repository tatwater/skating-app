/**
 * **CI's own rules, held** (B01-5f review R12): the nightly full run is the backstop for a push to
 * main that skipped as already tested, so nothing may cancel it — not a merge landing while it runs.
 * Read from `.github/workflows/ci.yml`: the concurrency group and `cancel-in-progress`, evaluated for
 * each event the workflow runs on (GitHub's `==` and `||` over `github.event_name` and `github.ref`).
 *
 * A lint over the workflow's text, not a run of GitHub Actions: the expressions are evaluated here
 * as GitHub would for the few operators they use.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const CI = readFileSync(resolve(__dirname, '../../../.github/workflows/ci.yml'), 'utf8');

/** The workflow-level `concurrency:` block's two values, as written. */
function concurrency(): { group: string; cancel: string } {
  const block = /^concurrency:\n((?:[ ]{2}.*\n)+)/m.exec(CI)?.[1] ?? '';
  const value = (key: string) =>
    (new RegExp(`^\\s+${key}:\\s*(.+)$`, 'm').exec(block)?.[1] ?? '').trim();
  return { group: value('group'), cancel: value('cancel-in-progress') };
}

/** A value with its `${{ … }}` expressions evaluated for an event on a ref. */
function evaluate(text: string, event: string, ref: string): string {
  return text.replace(/\$\{\{\s*([\s\S]+?)\s*\}\}/g, (_, expr: string) => {
    const js = expr
      .replace(/github\.event_name/g, JSON.stringify(event))
      .replace(/github\.ref/g, JSON.stringify(ref))
      .replace(/'([^']*)'/g, (_m, s: string) => JSON.stringify(s))
      .replace(/==/g, '===')
      .replace(/!===/g, '!==');
    if (!/^[\s"\w/.\-=!|&()]+$/.test(js))
      throw new Error(`An expression this lint can't read: ${expr}`);
    return String(new Function(`return (${js});`)());
  });
}

const MAIN = 'refs/heads/main';
const at = (event: string, ref = MAIN) => {
  const { group, cancel } = concurrency();
  return { group: evaluate(group, event, ref), cancel: evaluate(cancel, event, ref) === 'true' };
};

test('the workflow runs nightly and by hand, beside pushes and pull requests', () => {
  expect(CI).toMatch(/^\s+schedule:\n\s+- cron: /m);
  expect(CI).toMatch(/^\s+workflow_dispatch:/m);
});

test('the nightly and a manual run are never cancelled, and never share a push’s group', () => {
  for (const event of ['schedule', 'workflow_dispatch']) {
    expect(at(event).cancel, event).toBe(false);
    expect(at(event).group, event).not.toBe(at('push').group);
  }
  expect(at('schedule').group).not.toBe(at('workflow_dispatch').group);
});

test('a push or a pull request still cancels its own superseded run', () => {
  expect(at('push')).toMatchObject({ cancel: true });
  expect(at('push').group).toBe(at('push').group);
  expect(at('pull_request', 'refs/pull/7/merge')).toMatchObject({ cancel: true });
  expect(at('pull_request', 'refs/pull/7/merge').group).not.toBe(
    at('pull_request', 'refs/pull/8/merge').group,
  );
});
