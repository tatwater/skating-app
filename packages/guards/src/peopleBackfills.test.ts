/**
 * The People chained jobs and their after-merge procedure are one thing each (B01 §5.7). The registry
 * (`PEOPLE_BACKFILLS` in `convex/lib/peopleRuns.ts`) lists the backfills in run order. Every chained
 * job — the five backfills, the lapsed-suspension sweep, its daily retry — takes its run's lease
 * first (`takeLease`), so a pass of a superseded run does nothing; every backfill takes the same
 * arguments (`BACKFILL_ARGS`), concludes through `finishBackfill`, and names the next backfill in
 * `BACKFILL_JOB`. `peopleJobRuns` and `peopleJobProgress` are read and written only by
 * `lib/peopleRuns`, whose `readPreparation` is the operator's check (the one reader of a pass's
 * progress) and `readPending` every read's `pending`. Between runs, the writes
 * that create what a backfill fixes do its work themselves: the profile insert refreshes its row, a
 * flag is filed with its subject. The procedure's text is `AFTER_MERGE_PROCEDURE`, which
 * `packages/convex`'s `peopleBackfills.test.ts` performs literally; the phase doc and the roadmap must
 * quote it word for word, and the phase doc's table must name every backfill in order.
 *
 * A lint over the source text, not a proof (`peopleRuns.test.ts` is the property).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

const REPO = resolve(__dirname, '../../..');
const CONVEX = resolve(REPO, 'packages/convex/convex');
const REGISTRY = join(CONVEX, 'lib/peopleRuns.ts');
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
  expect(entries.map((e) => e.backfill)).toEqual([
    'rows',
    'flagSubjects',
    'undoChains',
    'verdicts',
    'withdrawals',
  ]);
  expect(procedure).toMatch(/^\(1\) `convex dev --once`\. \(2\) /);
  expect(procedure).toContain(`\`convex run peopleJobs:${entries[0]?.job} '{}'\``);
});

test('the runs are read and written only by the registry module', () => {
  const elsewhere = sources(CONVEX)
    .filter((p) => p !== REGISTRY && !p.endsWith('schema.ts'))
    .filter((p) =>
      /['"`]peopleJob(?:Runs|Progress)['"`]|['"`]ready:/.test(
        withoutComments(readFileSync(p, 'utf8')),
      ),
    )
    .map((p) => relative(CONVEX, p));
  expect(elsewhere).toEqual([]);
});

/**
 * A pass writes a run's progress (`peopleJobProgress`), never the run row a People read rests on
 * (B01-4j): only the operator's check and the passes may read the progress, so a backfill in flight
 * re-runs no People subscription pass by pass. Every other reader asks `readPending`.
 */
test('only the operator’s check reads a run’s progress; every People read asks `readPending`', () => {
  const callers = sources(CONVEX)
    .filter((p) => p !== REGISTRY)
    .filter((p) => /\b(?:readPreparation|readRun)\(/.test(withoutComments(readFileSync(p, 'utf8'))))
    .map((p) => relative(CONVEX, p));
  expect(callers).toEqual(['peopleJobs.ts']);
  const jobs = withoutComments(readFileSync(JOBS, 'utf8'));
  expect(jobs.match(/\breadPreparation\(/g)).toHaveLength(1);
  expect(jobs).not.toMatch(/\breadRun\(/);
  // In the registry, a pass's save writes only the progress row.
  const save = /export async function savePass\([\s\S]*?\n\}/.exec(registrySource)?.[0] ?? '';
  expect(save).toMatch(/'peopleJobProgress'/);
  expect(save).not.toMatch(/db\.patch\(row\._id/);
  expect(/export async function readPending\([\s\S]*?\n\}/.exec(registrySource)?.[0]).not.toMatch(
    /readRun|progressRow/,
  );
});

test('between runs, the writes that create what a backfill fixes do its work', () => {
  for (const p of sources(CONVEX)) {
    const text = withoutComments(readFileSync(p, 'utf8'));
    for (const m of text.matchAll(/insert\('profiles',/g)) {
      const end = text.indexOf('\nexport const ', m.index);
      const rest = text.slice(m.index, end === -1 ? undefined : end);
      expect(rest, `${relative(CONVEX, p)}: a profile insert refreshes its row`).toMatch(
        /refreshPersonRow\(ctx,/,
      );
    }
    for (const m of text.matchAll(/insert\('contentFlags', \{/g)) {
      const body = text.slice(m.index, text.indexOf('});', m.index));
      expect(body, `${relative(CONVEX, p)}: a flag is filed with its subject`).toContain(
        'subjectUserId:',
      );
    }
  }
});

test('every chained job takes its lease first; each backfill takes the shared arguments, concludes, and names the next', () => {
  const jobs = withoutComments(readFileSync(JOBS, 'utf8'));
  const handler = (name: string) => {
    const start = jobs.indexOf(`export const ${name} = internalMutation(`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    const end = jobs.indexOf('\nexport const ', start + 1);
    return jobs.slice(start, end === -1 ? undefined : end);
  };
  const leaseFirst = (name: string, job: string) => {
    const body = handler(name);
    const lease = body.indexOf(`takeLease(ctx, '${job}', args)`);
    expect(lease, `${name} takes its lease`).toBeGreaterThan(0);
    // Nothing is read or written before the lease but the budget's own setup.
    expect(body.slice(0, lease), name).not.toMatch(/ctx\.db\.|ctx\.runMutation|ctx\.scheduler/);
    expect(body.slice(lease), name).toMatch(/if \(lease === null\) return/);
    return body;
  };
  const map = /const BACKFILL_JOB = \{([\s\S]*?)\} as const;/.exec(jobs)?.[1] ?? '';
  entries.forEach((entry, i) => {
    const body = leaseFirst(entry.job, entry.backfill);
    expect(body, entry.job).toContain('args: BACKFILL_ARGS,');
    expect(body, entry.job).toMatch(/await finishBackfill\(ctx, lease, failed, [^)]+\);/);
    const next = entries[i + 1];
    const row = new RegExp(
      `${entry.backfill}: \\{\\s*self: internal\\.peopleJobs\\.${entry.job},\\s*next: ${
        next === undefined ? 'null' : `internal\\.peopleJobs\\.${next.job}`
      },?\\s*\\}`,
    );
    expect(map, `${entry.job} in BACKFILL_JOB`).toMatch(row);
  });
  leaseFirst('sweepLapsedSuspensions', 'lapseSweep');
  leaseFirst('retryLapsedDaily', 'lapseRetry');
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
