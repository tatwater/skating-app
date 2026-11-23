/**
 * **CI's own rules, held** (B01-5f review R12): the nightly full run is the backstop for a push to
 * main that skipped as already tested, so nothing may cancel it — not a merge landing while it runs.
 * Read from `.github/workflows/ci.yml`: the concurrency group and `cancel-in-progress`, evaluated for
 * each event the workflow runs on (GitHub's `==` and `||` over `github.event_name` and `github.ref`).
 *
 * And its shape since the tests were split into parallel jobs (2026-11-23): every job honors the
 * already-tested skip, one final `CI` check depends on every other job, and the test jobs together
 * run every package's tests — one job runs whatever the others don't name, and a package split by
 * Vitest project is split into a filter and its negation, so a new package or project lands
 * somewhere rather than nowhere.
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

/** Each job's block of text under `jobs:`, by its id. */
function jobs(): Map<string, string> {
  const body = CI.slice(CI.search(/^jobs:\n/m));
  const out = new Map<string, string>();
  const ids = [...body.matchAll(/^ {2}([\w-]+):\n/gm)];
  ids.forEach((m, i) => {
    out.set(m[1] as string, body.slice(m.index, ids[i + 1]?.index ?? body.length));
  });
  return out;
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
const SKIP_IF = "if: ${{ !cancelled() && needs.already-tested.outputs.skip != 'true' }}";
const FINAL = 'ci';

test('every job honors the already-tested skip, the same way', () => {
  const all = jobs();
  // A floor: the split parsed (a regex that matched nothing would pass anything).
  expect(all.size).toBeGreaterThanOrEqual(7);
  for (const [id, text] of all) {
    if (id === 'already-tested' || id === FINAL) continue;
    expect(text, id).toMatch(/^ {4}needs: already-tested$/m);
    expect(text, id).toContain(SKIP_IF);
  }
});

test('one final check passes only when every other job has, and depends on all of them', () => {
  const all = jobs();
  const final = all.get(FINAL) ?? '';
  expect(final).toMatch(/^ {4}name: CI$/m);
  expect(final).toMatch(/^ {4}if: \$\{\{ always\(\) \}\}$/m);
  // The block list under `needs:`, one job id a line.
  const needs = [
    ...(/^ {4}needs:\n((?: {6}- [\w-]+\n)+)/m.exec(final)?.[1]?.matchAll(/- ([\w-]+)/g) ?? []),
  ].map((m) => m[1]);
  expect(needs.length).toBeGreaterThan(0);
  expect(needs.sort()).toEqual([...all.keys()].filter((id) => id !== FINAL).sort());
});

/** Every `turbo run test` the workflow runs: its package filters and the args passed to vitest. */
function testRuns(): { job: string; filters: string[]; args: string }[] {
  return [...jobs()].flatMap(([job, text]) =>
    [...text.matchAll(/turbo run test((?: --filter=\S+)*)(?: -- (.+))?$/gm)].map((m) => ({
      job,
      filters: [...(m[1] ?? '').matchAll(/--filter='?([^'\s]+)'?/g)].map((f) => f[1] as string),
      args: (m[2] ?? '').trim(),
    })),
  );
}

test('the test jobs together run every package’s tests — pnpm test, split, with nothing left out', () => {
  const runs = testRuns();
  expect(runs.length).toBeGreaterThanOrEqual(4);
  // The packages a job names on its own, and the one job that runs everything but those.
  const named = new Set(runs.flatMap((r) => r.filters.filter((f) => !f.startsWith('!'))));
  const rest = runs.filter(
    (r) => r.filters.length > 0 && r.filters.every((f) => f.startsWith('!')),
  );
  expect(rest, 'exactly one job runs every package not named elsewhere').toHaveLength(1);
  expect(new Set(rest[0]?.filters.map((f) => f.slice(1)))).toEqual(named);
  // No run is unfiltered (that would be the whole suite again) or mixes the two shapes.
  for (const r of runs) {
    expect(r.filters.length, r.job).toBeGreaterThan(0);
  }
  // A package split across jobs by Vitest project is split exactly in two: a filter and its negation.
  for (const pkg of named) {
    const projects = runs
      .filter((r) => r.filters.includes(pkg))
      .map((r) => /^--project='?([^'\s]+)'?$/.exec(r.args)?.[1] ?? '');
    if (projects.length === 1) {
      expect(projects, pkg).toEqual(['']);
      continue;
    }
    expect(projects, pkg).toHaveLength(2);
    const [positive, negative] = [...projects].sort(
      (a, b) => Number(a.startsWith('!')) - Number(b.startsWith('!')),
    );
    expect(negative, pkg).toBe(`!${positive}`);
  }
});

test('Chromium is installed only where the stories run', () => {
  const installs = [...jobs()].filter(([, text]) => text.includes('playwright install'));
  expect(installs.map(([id]) => id)).toEqual(['test-web-stories']);
  expect(installs[0]?.[1]).toContain('--project=storybook');
});

test('the web unit projects run again in three zones: 1 AM local, and both ends of the date line', () => {
  const zones = jobs().get('web-time-zones') ?? '';
  expect(zones).toMatch(/^ {8}zone: \["1 AM local", Etc\/GMT-14, Etc\/GMT\+11\]$/m);
  expect(zones).toContain('if [ "$ZONE" = "1 AM local" ]; then');
  expect(zones).toContain(
    `TZ="$ZONE" pnpm --filter @skating/web exec vitest run --project 'unit*'`,
  );
});

test('a push or a pull request still cancels its own superseded run', () => {
  expect(at('push')).toMatchObject({ cancel: true });
  expect(at('push').group).toBe(at('push').group);
  expect(at('pull_request', 'refs/pull/7/merge')).toMatchObject({ cancel: true });
  expect(at('pull_request', 'refs/pull/7/merge').group).not.toBe(
    at('pull_request', 'refs/pull/8/merge').group,
  );
});
