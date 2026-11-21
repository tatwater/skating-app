/**
 * **The Inbox reads no row it hasn't budgeted, and closes no group of sources outside a batch**
 * (B01-5, PR #170). Three review rounds found the same defect in the last round's fix: a read that
 * pulled rows before it knew it could afford them, where a row can weigh near the document limit (an
 * admit ask carrying its catalog polygon). This lint holds the shape that prevents it.
 *
 * **Reads.** In the Inbox's read modules — `inbox.ts`, `lib/inboxViews.ts`, `lib/inboxRules.ts`, and
 * the own-filing check the views call (`lib/requestDecisions.ts`' `ownAsks`, `alongsideAnswer`) —
 * every row read (`ctx.db.get(`, a query chain ending `.take(` / `.first(` / `.unique(` /
 * `.collect(` / `.paginate(`, an async iteration of one) and every call of a read callback (`read(`)
 * sits lexically inside the arguments of a budgeted call: the reader's `r.get` / `r.take` /
 * `r.members`, a `ReadBudget`'s `take` / `measured` / `one` / `page` / `row`, a pass's `reads.get` /
 * `reads.take`, or `itemsUpTo`. Such a call charges the read's worst case before it starts, or
 * starts it only while that fits. The exceptions are named below, function by function, each with why
 * it is bounded.
 *
 * **Writes.** In the write and undo modules, every loop whose body calls an entry of the one writer
 * (or a closer built on it) sits inside `inboxBatch(`, so a group's items are recounted once.
 *
 * Comments and strings are blanked first, every offset kept. **What it can't see:** a read through a
 * helper in another module (only the named `requestDecisions` functions are held), a budget wrapper
 * by another name (it then fails, and gets named here), and whether a wrapper's declared worst case
 * is honest — that is the heavy-rows matrix's (`convex/inboxHeavy.test.ts`).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const CONVEX = resolve(__dirname, '../../convex/convex');

/** The source with comments and string contents blanked, every offset kept. */
function blanked(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g,
    (m, quote: string | undefined) =>
      quote ? `${quote}${' '.repeat(m.length - 2)}${quote}` : m.replace(/[^\n]/g, ' '),
  );
}

const DECL = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*[:=]/gm;
type Fn = { name: string; at: number };
const functionsOf = (text: string): Fn[] =>
  [...text.matchAll(DECL)].map((m) => ({ name: m[1] ?? m[2] ?? '?', at: m.index }));
const enclosing = (fns: readonly Fn[], at: number) =>
  [...fns].reverse().find((f) => f.at <= at)?.name ?? '?';

/** Whether the call whose `(` opens at `i` is a budgeted one, by what precedes it. */
const BUDGETED =
  /(?:\b(?:budget|r|reads|share|read|this)|\br\.budget)\.(?:take|measured|one|page|row|get|members)\s*$|\bitemsUpTo\s*$/;

/** Whether `at` sits inside the arguments of a call matching `wrapper`, walking out paren by paren. */
function insideCall(text: string, at: number, wrapper: RegExp): boolean {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ')') depth++;
    else if (c === '(') {
      if (depth === 0) {
        if (wrapper.test(text.slice(Math.max(0, i - 40), i))) return true;
      } else depth--;
    }
  }
  return false;
}

const RAW =
  /ctx\.db\.get\(|\.(take|first|unique|collect|paginate)\(|\bawait\s+read\(|=>\s*read\(|Symbol\.asyncIterator/g;

/** Every unbudgeted read in `text`, as `file#function`, restricted to `only` when given. */
function unbudgetedReads(file: string, text: string, only?: ReadonlySet<string>): string[] {
  const fns = functionsOf(text);
  const out = new Set<string>();
  for (const m of text.matchAll(RAW)) {
    if (m[1]) {
      // A query chain's terminal only: the statement it ends names the database or an index.
      const before = text.slice(Math.max(0, m.index - 600), m.index);
      const cut = Math.max(before.lastIndexOf(';'), before.lastIndexOf('{\n'));
      if (!/ctx\.db|\.withIndex\(|\.query\(/.test(before.slice(cut + 1))) continue;
    }
    const fn = enclosing(fns, m.index);
    if (only && !only.has(fn)) continue;
    if (!insideCall(text, m.index, BUDGETED)) out.add(`${file}#${fn}`);
  }
  return [...out];
}

const WRITER =
  /\b(decideItem|syncInboxSource|syncReopened|fileMember|rekey|leaveMember|reopenItem|closeRow|closeFlag|itemToDecide)\(/;

/** Every loop calling the writer outside a batch in `text`, as `file#function`. */
function unbatchedLoops(file: string, text: string): string[] {
  const fns = functionsOf(text);
  const out = new Set<string>();
  for (const m of text.matchAll(/\bfor\s*\(/g)) {
    let close = m.index;
    let depth = 0;
    for (let j = m.index + m[0].length - 1; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')' && --depth === 0) {
        close = j;
        break;
      }
    }
    let k = close + 1;
    while (/\s/.test(text[k] ?? '')) k++;
    let end = text.indexOf(';', k);
    if (text[k] === '{') {
      let braces = 0;
      for (end = k; end < text.length; end++) {
        if (text[end] === '{') braces++;
        else if (text[end] === '}' && --braces === 0) break;
      }
    }
    if (!WRITER.test(text.slice(k, end + 1))) continue;
    if (!insideCall(text, m.index, /\binboxBatch\s*$/))
      out.add(`${file}#${enclosing(fns, m.index)}`);
  }
  return [...out];
}

const READ_MODULES = ['inbox.ts', 'lib/inboxViews.ts', 'lib/inboxRules.ts'];
/** In `lib/requestDecisions.ts`, the functions the Inbox's reads call. */
const READ_HELPERS = new Set(['ownAsks', 'alongsideAnswer']);

/** Reads outside a budgeted call, each bounded another way. */
const READ_EXCEPTIONS: Record<string, string> = {
  'inbox.ts#aroundIt':
    'a report at a time: the next pulled only after `affordsRead`, charged as it weighs',
  'inbox.ts#claimWeather':
    'the flagged report, its body, and a fixed count of fixed-shape weather days',
  'lib/inboxViews.ts#authoredReports':
    'a report at a time: the next pulled only after `affordsRead`, charged as it weighs',
  'lib/inboxViews.ts#recordOf':
    'a Post’s ≤10 members, reserved whole first — and left unread when that doesn’t fit',
  'lib/inboxViews.ts#itemOfRef': 'point reads: the item, or one member per source table (four)',
  'lib/inboxRules.ts#filedByViewer': 'one member row',
  'lib/inboxRules.ts#filedOnTarget':
    'reads through the caller’s take (a list row’s is its page budget): ≤2 lanes × (1 + 8) small rows',
  'lib/inboxRules.ts#plainTake': 'the item read’s reader for the rule’s few small rows',
  'lib/requestDecisions.ts#ownAsks':
    'while pending, an ask at a time: the next pulled only after `affordsRead`, charged as it weighs',
};

const WRITE_MODULES = [
  'inboxWrites.ts',
  'inboxItems.ts',
  'corpusRequests.ts',
  'moderation.ts',
  'support.ts',
  'waterBodies.ts',
  'accountDeletion.ts',
  'erasure.ts',
  'contentFlags.ts',
  'lib/inboxFlags.ts',
  'lib/inboxItems.ts',
  'lib/inboxRepair.ts',
  'lib/requestDecisions.ts',
  'lib/undoHandlersCorpus.ts',
  'lib/flagResolution.ts',
];

/** Loops over sources outside a batch, each run inside one by its only caller. */
const LOOP_EXCEPTIONS: Record<string, string> = {
  'waterBodies.ts#retargetEach': 'called only by `retargetAsks`, inside its batch',
};

const read = (file: string) => blanked(readFileSync(resolve(CONVEX, file), 'utf8'));

test('every Inbox read is budgeted, but for the named exceptions', () => {
  const found = [
    ...READ_MODULES.flatMap((f) => unbudgetedReads(f, read(f))),
    ...unbudgetedReads('lib/requestDecisions.ts', read('lib/requestDecisions.ts'), READ_HELPERS),
  ];
  expect(found.filter((k) => !(k in READ_EXCEPTIONS)).sort()).toEqual([]);
  // An exception whose reads are budgeted now comes off the list.
  expect(Object.keys(READ_EXCEPTIONS).filter((k) => !found.includes(k))).toEqual([]);
});

test('every loop over sources in a write or an undo is one batch, but for the named exceptions', () => {
  const found = WRITE_MODULES.flatMap((f) => unbatchedLoops(f, read(f)));
  expect(found.filter((k) => !(k in LOOP_EXCEPTIONS)).sort()).toEqual([]);
  expect(Object.keys(LOOP_EXCEPTIONS).filter((k) => !found.includes(k))).toEqual([]);
});

test('the lint fails the shape three rounds found: rows pulled before they were charged', () => {
  // `alongsideOf` as it stood at 8bdb7d7d: every open ask read, then charged.
  const before = blanked(`
async function alongsideOf(r, first, approve, decline) {
  const take = async (n, read) => {
    r.budget.reserveCalls(1, n);
    const rows = await read(n);
    r.budget.spend(rows.reduce((b, row) => b + getDocumentSize(row), 0));
    return rows;
  };
  const mine = await ownOpenAsks(r.ctx, r.viewerId, take);
}`);
  expect(unbudgetedReads('lib/inboxViews.ts', before)).toEqual(['lib/inboxViews.ts#alongsideOf']);
  // The same read through the budget's own take passes; a read named only in a comment never counts.
  const after = blanked(`
async function alongsideOf(r) {
  // const rows = await ctx.db.query('waterBodyRequests').take(200);
  return r.budget.take('inboxMember', 201, (n) => ctx.db.query('inboxItemMembers').take(n));
}`);
  expect(unbudgetedReads('lib/inboxViews.ts', after)).toEqual([]);
  // A loop deciding sources one by one outside a batch fails; inside one, it passes.
  const loop = blanked(`
async function closeAll(ctx, rows) {
  for (const row of rows) await closeRow(ctx, row, decision);
}
async function closeBatched(ctx, rows) {
  await inboxBatch(ctx, async () => {
    for (const row of rows) await closeRow(ctx, row, decision);
  });
}`);
  expect(unbatchedLoops('x.ts', loop)).toEqual(['x.ts#closeAll']);
});
