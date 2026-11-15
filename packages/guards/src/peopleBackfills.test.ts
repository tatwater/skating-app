/**
 * Every `ready:` flag a People read checks is set by a backfill the operator's one command reaches
 * (B01 §5.7, "After merge"). The flags are declared in `convex/lib/peopleRows.ts` and listed, in run
 * order, in its `PEOPLE_BACKFILLS`; `peopleJobs:backfillRows` starts the chain and each job starts the
 * next. A flag spelled anywhere else, a `READY_*` constant missing from the registry, a job that never
 * marks its flag or never starts the next, or a phase doc whose backfill table leaves one out — each is
 * a read that could say "not ready" forever, which is what this catches.
 *
 * A lint over the source text, not a proof (`peopleBackfills.test.ts` in `packages/convex` runs the
 * chain itself).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

const REPO = resolve(__dirname, '../../..');
const CONVEX = resolve(REPO, 'packages/convex/convex');
const REGISTRY = join(CONVEX, 'lib/peopleRows.ts');
const JOBS = join(CONVEX, 'peopleJobs.ts');
const PHASE_DOC = resolve(REPO, 'plans/phases/B01-admin-console.md');
/** The first line of the phase doc's backfill table. */
const TABLE_HEADER = '| Job | Started by | Sets | Reads that say `pending` until it is set |';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '_generated' ? [] : sources(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

/** The source with comments blanked (strings kept), so a flag named in prose is not a use. */
function withoutComments(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g,
    (m, quote: string | undefined) => (quote ? m : m.replace(/[^\n]/g, ' ')),
  );
}

const registrySource = withoutComments(readFileSync(REGISTRY, 'utf8'));

/** `READY_*` constants the registry module declares, by name, with their flag. */
const declared = new Map(
  [...registrySource.matchAll(/export const (READY_[A-Z_]+) = '(ready:[A-Za-z]+)';/g)].map((m) => [
    m[1] as string,
    m[2] as string,
  ]),
);

/** `PEOPLE_BACKFILLS`' entries, in order. */
const entries = (() => {
  const body = /export const PEOPLE_BACKFILLS = \[([\s\S]*?)\] as const/.exec(registrySource)?.[1];
  return [
    ...(body ?? '').matchAll(
      /\{\s*backfill: '(\w+)',\s*job: 'peopleJobs:(\w+)',\s*flag: (READY_[A-Z_]+)\s*\}/g,
    ),
  ].map((m) => ({ backfill: m[1] as string, job: m[2] as string, flag: m[3] as string }));
})();

test('the registry parses, and lists every READY_* constant once', () => {
  expect(declared.size).toBeGreaterThan(0);
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.map((e) => e.flag).sort()).toEqual([...declared.keys()].sort());
});

test('a ready: flag is spelled only in the registry module', () => {
  const elsewhere = sources(CONVEX)
    .filter((p) => p !== REGISTRY)
    .filter((p) => /['"`]ready:/.test(withoutComments(readFileSync(p, 'utf8'))))
    .map((p) => relative(CONVEX, p));
  expect(elsewhere).toEqual([]);
});

test('every READY_* constant read anywhere is one the registry lists', () => {
  const listed = new Set(entries.map((e) => e.flag));
  const unlisted = sources(CONVEX).flatMap((p) =>
    [...withoutComments(readFileSync(p, 'utf8')).matchAll(/\bREADY_[A-Z_]+\b/g)]
      .map((m) => m[0])
      .filter((name) => !listed.has(name))
      .map((name) => `${relative(CONVEX, p)}: ${name}`),
  );
  expect(unlisted).toEqual([]);
});

test('each job marks its own flag and starts the next; the last starts none', () => {
  const jobs = withoutComments(readFileSync(JOBS, 'utf8'));
  const handler = (name: string) => {
    const start = jobs.indexOf(`export const ${name} = internalMutation(`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    const end = jobs.indexOf('\nexport const ', start + 1);
    return jobs.slice(start, end === -1 ? undefined : end);
  };
  entries.forEach((entry, i) => {
    const body = handler(entry.job);
    expect(body, entry.job).toContain(`markReady(ctx, ${entry.flag})`);
    const next = entries[i + 1];
    const starts = [
      ...body.matchAll(/runAfter\(\s*0,\s*internal\.peopleJobs\.(\w+),\s*\{\s*\}\s*\)/g),
    ]
      .map((m) => m[1])
      .filter((job) => job !== entry.job);
    expect(starts, entry.job).toEqual(next === undefined ? [] : [next.job]);
  });
});

test('the phase doc’s backfill table names every job and its flag, in order', () => {
  const doc = readFileSync(PHASE_DOC, 'utf8');
  const header = doc.indexOf(TABLE_HEADER);
  expect(header, 'the backfill table').toBeGreaterThanOrEqual(0);
  const table = doc.slice(header, doc.indexOf('\n\n', header));
  expect(table.match(/^\| `peopleJobs:/gm)?.length, 'one row per job').toBe(entries.length);
  let at = header;
  for (const entry of entries) {
    const row = doc.indexOf(`| \`peopleJobs:${entry.job}`, at + 1);
    expect(row, entry.job).toBeGreaterThan(at);
    const line = doc.slice(row, doc.indexOf('\n', row));
    expect(line, entry.job).toContain(declared.get(entry.flag) as string);
    at = row;
  }
});
