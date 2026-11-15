/**
 * The People backfills' after-merge procedure is one thing (B01 §5.7). The registry
 * (`PEOPLE_BACKFILLS` in `convex/lib/peopleRows.ts`) lists the backfills in run order; every one takes
 * the same arguments (`BACKFILL_ARGS`), records each pass in `peopleBackfills` through that module, and
 * starts the next when it ends; `lib/peopleRows.readPreparation` is the only reading of that table, so
 * the operator's check (`peopleJobs.preparation`) and every read's `pending` can't disagree. The
 * procedure's text is `AFTER_MERGE_PROCEDURE` in the same module, which `packages/convex`'s
 * `peopleBackfills.test.ts` performs literally; the phase doc and the roadmap must quote it word for
 * word, and the phase doc's table must name every backfill in order.
 *
 * A lint over the source text, not a proof.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

const REPO = resolve(__dirname, '../../..');
const CONVEX = resolve(REPO, 'packages/convex/convex');
const REGISTRY = join(CONVEX, 'lib/peopleRows.ts');
const JOBS = join(CONVEX, 'peopleJobs.ts');
const PHASE_DOC = resolve(REPO, 'plans/phases/B01-admin-console.md');
const ROADMAP = resolve(REPO, 'plans/07-roadmap.md');
/** The first line of the phase doc's backfill table. */
const TABLE_HEADER = '| Job | Started by | Reads that say `pending` until it is ready |';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '_generated' ? [] : sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

/** The source with comments blanked (strings kept), so a name in prose is not a use. */
function withoutComments(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g,
    (m, quote: string | undefined) => (quote ? m : m.replace(/[^\n]/g, ' ')),
  );
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

const registrySource = withoutComments(readFileSync(REGISTRY, 'utf8'));

/** `PEOPLE_BACKFILLS`' entries, in order. */
const entries = (() => {
  const body = /export const PEOPLE_BACKFILLS = \[([\s\S]*?)\] as const/.exec(registrySource)?.[1];
  return [...(body ?? '').matchAll(/\{\s*backfill: '(\w+)',\s*job: 'peopleJobs:(\w+)'\s*\}/g)].map(
    (m) => ({ backfill: m[1] as string, job: m[2] as string }),
  );
})();

/** `AFTER_MERGE_PROCEDURE`, as the string it evaluates to. */
const procedure = (() => {
  const body = /export const AFTER_MERGE_PROCEDURE = \[([\s\S]*?)\]\.join\(' '\)/.exec(
    registrySource,
  )?.[1];
  const parts = [...(body ?? '').matchAll(/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/g)].map((m) =>
    (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1'),
  );
  return parts.join(' ');
})();

test('the registry and the procedure parse', () => {
  expect(entries.map((e) => e.backfill)).toEqual(['rows', 'flagSubjects', 'undoChains']);
  expect(procedure).toMatch(/^\(1\) `convex dev --once`\. \(2\) /);
  expect(procedure).toContain(`\`convex run peopleJobs:${entries[0]?.job} '{}'\``);
});

test('the backfills’ state is read and written only by the registry module', () => {
  const elsewhere = sources(CONVEX)
    .filter((p) => p !== REGISTRY && !p.endsWith('schema.ts'))
    .filter((p) =>
      /['"`]peopleBackfills['"`]|['"`]ready:/.test(withoutComments(readFileSync(p, 'utf8'))),
    )
    .map((p) => relative(CONVEX, p));
  expect(elsewhere).toEqual([]);
});

test('each backfill takes the shared arguments, records its end, and starts the next; the last starts none', () => {
  const jobs = withoutComments(readFileSync(JOBS, 'utf8'));
  const handler = (name: string) => {
    const start = jobs.indexOf(`export const ${name} = internalMutation(`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    const end = jobs.indexOf('\nexport const ', start + 1);
    return jobs.slice(start, end === -1 ? undefined : end);
  };
  entries.forEach((entry, i) => {
    const body = handler(entry.job);
    expect(body, entry.job).toContain('args: BACKFILL_ARGS,');
    expect(body, entry.job).toContain(`backfillFailedSoFar(ctx, '${entry.backfill}', args)`);
    expect(body, entry.job).toMatch(
      new RegExp(`saveBackfill\\(ctx, '${entry.backfill}', args, \\{ running: false,`),
    );
    const next = entries[i + 1];
    const starts = [
      ...body.matchAll(/runAfter\(\s*0,\s*internal\.peopleJobs\.(\w+),\s*\{\s*\}\s*\)/g),
    ].map((m) => m[1]);
    expect(starts, entry.job).toEqual(next === undefined ? [] : [next.job]);
  });
  // The operator's check is the one reading.
  expect(jobs).toMatch(
    /export const preparation = internalQuery\(\{\s*args: \{\},\s*handler: \(ctx\) => readPreparation\(ctx\),/,
  );
});

test('the phase doc and the roadmap quote the procedure word for word', () => {
  for (const doc of [PHASE_DOC, ROADMAP]) {
    const quoted = squash(readFileSync(doc, 'utf8')).includes(squash(procedure));
    expect(quoted, `${relative(REPO, doc)} quotes AFTER_MERGE_PROCEDURE`).toBe(true);
  }
});

test('the phase doc’s backfill table names every job, in order', () => {
  const doc = readFileSync(PHASE_DOC, 'utf8');
  const header = doc.indexOf(TABLE_HEADER);
  expect(header, 'the backfill table').toBeGreaterThanOrEqual(0);
  const table = doc.slice(header, doc.indexOf('\n\n', header));
  const rows = [...table.matchAll(/^\| `peopleJobs:(\w+)`/gm)].map((m) => m[1]);
  expect(rows).toEqual(entries.map((e) => e.job));
});
