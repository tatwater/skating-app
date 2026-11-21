/**
 * **Every write that withdraws an item keeps its withdrawal row, and every verdict write keeps its
 * `held`** (B01-4m, D282). The record sheet's Deleted list and count read one index range of
 * `contentWithdrawals` rows (`convex/lib/withdrawals`), so a writer that withdraws an item — or erases
 * one — without its row would make the list and the count miss it, or keep it after it is gone, and a
 * verdict write that skips `held` would show a held item as Deleted.
 *
 * This lint finds, in the convex sources:
 *
 * - every `ctx.db.insert`/`patch`/`replace` whose literal names a field a withdrawal is read from —
 *   `authorDeletedAt` (a Report, Post, comment or hazard), `retractedAt` (an access alert's author
 *   retraction) or `erasedAt` (a comment left as its replies' shell) — and holds its function to the
 *   inventory below, each entry naming the function that keeps the row (`syncWithdrawal(`, or the
 *   eraser's `dropWithdrawal(`) — the writer itself, or for the eraser's shell, `eraseOne`;
 *   the writes of those field names on other tables are listed apart, by function;
 * - every write to `contentWithdrawals` (an insert, or the table named anywhere else) is in
 *   `lib/withdrawals`, its one writer — `contentRecord.ts` and the backfill in `peopleJobs.ts` only
 *   query it;
 * - each verdict writer (`verdictWriters.test.ts`' inventory) moves `held` where it stands a verdict
 *   up or ends one: `refreshWithdrawalHold(` in the functions listed.
 *
 * **What it can't see:** a write whose fields arrive through a variable or a spread. The withdrawals
 * backfill (`peopleJobs:backfillWithdrawals`, which re-derives every row) is the net for those, and
 * `convex/withdrawalRows.test.ts` holds the rows to the items over generated histories.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

const CONVEX = resolve(__dirname, '../../convex/convex');

/**
 * Every function that writes a withdrawal field on a withdrawable item — the inventory — and the
 * function that keeps its row (itself unless named).
 */
const WITHDRAWAL_WRITERS: Record<string, { keeps: string; why: string }> = {
  'moderation.ts:authorRemoveReport': { keeps: 'self', why: 'a Report’s author delete' },
  'moderation.ts:authorRemovePost': {
    keeps: 'self',
    why: 'a Post’s author delete, and each member',
  },
  'comments.ts:remove': { keeps: 'self', why: 'a comment’s author delete' },
  'hazardWithdrawal.ts:withdraw': { keeps: 'self', why: 'a hazard its author withdrew' },
  'accessAlerts.ts:retract': {
    keeps: 'self',
    why: 'an alert retracted (the author’s is a withdrawal; a moderator’s is not)',
  },
  'authorDeletions.ts:stampWithdrawal': { keeps: 'self', why: 'the D248 stamp from the audit log' },
  'authorDeletions.ts:stampMembers': { keeps: 'self', why: 'a deleted Post’s members, stamped' },
  'authorDeletions.ts:commentLastWord': { keeps: 'self', why: 'a comment deletion never audited' },
  'erasure.ts:backfillClocks': { keeps: 'self', why: 'an old author retraction given its time' },
  'erasure.ts:eraseComment': {
    keeps: 'erasure.ts:eraseOne',
    why: 'a comment left as a shell: its row goes with every erasure, in `eraseOne`',
  },
};

/** Writes of those field names to tables the Deleted list doesn't read, by function. */
const OTHER_TABLES: Record<string, string> = {
  'contentFlags.ts:retract': 'a flag’s filer took it back (`contentFlags`)',
  'corpusRequests.ts:retract': 'a request withdrawn (`waterBodyRequests`)',
  'erasure.ts:settleStep': 'a photo stripped (`photos.erasedAt`)',
};

/** Where each verdict writer stands a verdict up or ends one — each must move `held` there. */
const HOLD_KEEPERS = [
  'lib/contentVerdicts.ts:endVerdicts',
  'lib/contentVerdicts.ts:recordVerdict',
  'contentRecord.ts:replayVerdictHistory',
];

const ROW_CALLS = /\b(?:syncWithdrawal|dropWithdrawal)\(/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '_generated' ? [] : sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

function callSpan(text: string, start: number): string {
  let depth = 0;
  for (let i = text.indexOf('(', start); i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

const DECLARATION = /^(?:export )?(?:const|async function|function) (\w+)/gm;

function enclosing(text: string, offset: number): { name: string; body: string } {
  const starts = [...text.matchAll(DECLARATION)].map((m) => ({ at: m.index ?? 0, name: m[1] }));
  const from = starts.filter((s) => s.at <= offset).pop() ?? { at: 0, name: '' };
  const to = starts.find((s) => s.at > offset)?.at ?? text.length;
  return { name: from.name ?? '', body: text.slice(from.at, to) };
}

/** The body of a named top-level declaration in a convex file. */
function bodyOf(key: string): string {
  const [file, fn] = key.split(':') as [string, string];
  const text = readFileSync(join(CONVEX, file), 'utf8');
  const at = [...text.matchAll(DECLARATION)].find((m) => m[1] === fn)?.index;
  expect(at, `${key} exists`).toBeDefined();
  return enclosing(text, at as number).body;
}

const names = (span: string, key: string) => new RegExp(`\\b${key}\\s*[:,}]`).test(span);

test('every write of a withdrawal field is an inventoried writer that keeps the row', () => {
  const holes: string[] = [];
  const writers = new Set<string>();
  const others = new Set<string>();
  for (const path of sources(CONVEX)) {
    const file = relative(CONVEX, path);
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(/ctx\.db\.(insert|patch|replace)\(/g)) {
      const at = m.index ?? 0;
      const span = callSpan(text, at);
      if (!['authorDeletedAt', 'retractedAt', 'erasedAt'].some((f) => names(span, f))) continue;
      const key = `${file}:${enclosing(text, at).name}`;
      if (key in OTHER_TABLES) {
        others.add(key);
        continue;
      }
      writers.add(key);
      const entry = WITHDRAWAL_WRITERS[key];
      const where = `${file}:${text.slice(0, at).split('\n').length}`;
      if (!entry) {
        holes.push(`${where} writes a withdrawal field in an uninventoried function`);
        continue;
      }
      const keeper = entry.keeps === 'self' ? key : entry.keeps;
      if (!ROW_CALLS.test(bodyOf(keeper))) {
        holes.push(`${where}: ${keeper} doesn’t keep the withdrawal row`);
      }
    }
  }
  expect(holes).toEqual([]);
  // The inventory is exact: a new writer is read and listed, a gone one is taken off.
  expect([...writers].sort()).toEqual(Object.keys(WITHDRAWAL_WRITERS).sort());
  expect([...others].sort()).toEqual(Object.keys(OTHER_TABLES).sort());
  // The eraser drops the row of whatever it erased, or left as a shell.
  expect(bodyOf('erasure.ts:eraseOne')).toMatch(/\bdropWithdrawal\(/);
});

test('`contentWithdrawals` is written only by `lib/withdrawals`', () => {
  const touching = sources(CONVEX)
    .filter((p) => !p.endsWith('schema.ts'))
    .filter((p) => /['"]contentWithdrawals['"]/.test(readFileSync(p, 'utf8')))
    .map((p) => relative(CONVEX, p))
    .sort();
  // `contentRecord` reads the Deleted list's range and counts it; the withdrawals backfill
  // (`peopleJobs`) walks the stored rows for its repair — each through the one writer. Neither
  // writes the table itself.
  expect(touching).toEqual(['contentRecord.ts', 'lib/withdrawals.ts', 'peopleJobs.ts']);
  for (const file of ['contentRecord.ts', 'peopleJobs.ts']) {
    const text = readFileSync(join(CONVEX, file), 'utf8');
    expect(text, file).not.toMatch(/(?:insert|patch|replace|delete)\('contentWithdrawals'/);
    for (const m of text.matchAll(/['"]contentWithdrawals['"]/g)) {
      const before = text.slice(Math.max(0, (m.index ?? 0) - 20), m.index);
      expect(before, `${file} only queries the rows`).toMatch(/query\($/);
    }
  }
});

test('every verdict write moves the withdrawal row’s `held`', () => {
  for (const key of HOLD_KEEPERS) {
    expect(bodyOf(key), key).toMatch(/\brefreshWithdrawalHold\(/);
  }
});
