/**
 * **No rule is decided from a window** (B01-5, PR #170). Five review rounds found the same defect:
 * an allowed/refused answer read from "the newest 100" or "the first 8" rows, which a much-flagged
 * target's own rows can push the deciding one out of. This lint holds the shape that prevents it.
 *
 * In the modules that decide what a staffer may do — the Inbox's rule, the flag and request decisions
 * and their undos, the undo engine, the record rules — and the named rule functions elsewhere, every
 * capped read is one of:
 * - **(a) an exact lookup**: `.first()`, a `take(1)` (or a budget's `take(kind, 1, …)`): "is there
 *   one", on an index the caller `eq`s — never "the first few";
 * - **(b) read one past, refuse at the bound**: a cap written `X + 1` in a function that compares a
 *   length past `X` (`.length > X`) — a branch the function takes to refuse or say "unchecked";
 * - **allow-listed below** with its category and why: (a) an existence the cap can't change, (b) a
 *   refusal at the bound made elsewhere, or (c) a bound a writer holds, named with the test that holds
 *   it.
 * A capped read here is a query chain's `.take(…)` or `.paginate(…)`, a budget's `take(kind, n, …)`,
 * a page reader (`within(…)`), or an async iteration; a query `.filter(` (which reads rows it doesn't
 * return, so a `take(1)` after it is a scan) must be allow-listed too.
 *
 * **What it can't see:** whether an index's `eq`s make a `.first()` or `take(1)` exact (a `take(1)` on
 * a prefix that isn't the question passes); a cap passed in from another module (`take(n)` through a
 * caller's callback is the caller's read, checked where the caller's cap is written); whether a `> X`
 * comparison really is the refusal branch, or guards the read it follows; rule functions outside the
 * scanned modules and names; and whether an allow-listed writer cap is true — that is each entry's
 * test's to hold.
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
type Fn = { name: string; at: number; end: number };
function functionsOf(text: string): Fn[] {
  const starts = [...text.matchAll(DECL)].map((m) => ({ name: m[1] ?? m[2] ?? '?', at: m.index }));
  return starts.map((f, i) => ({ ...f, end: starts[i + 1]?.at ?? text.length }));
}

/** A capped read: its cap expression (`?` when it has none to name), by the shape it takes. */
const CAPPED =
  /\.take\(\s*([^()]*?)\s*\)|\b(?:take|within)\(\s*(?:'\s*'\s*,\s*)?([A-Za-z0-9_.+ ]+?)\s*,|\.(paginate|first)\(|(Symbol\.asyncIterator)|\.filter\(\s*\(?q\)?\s*=>\s*q\./g;

/** A read's verdict in `text`, or `null` when it passes on its shape — (a) or (b). */
function windowsIn(file: string, text: string, only?: ReadonlySet<string>): string[] {
  const fns = functionsOf(text);
  const out = new Set<string>();
  for (const m of text.matchAll(CAPPED)) {
    const fn = [...fns].reverse().find((f) => f.at <= m.index);
    if (!fn || (only && !only.has(fn.name))) continue;
    if (m[3] === 'first') continue; // (a) "is there one"
    let cap = (m[1] ?? m[2] ?? '').trim();
    // A callback's `take(n)`: its caller's wrapper names the cap, and is checked there.
    if (m[1] !== undefined && /^[a-z]\w*$/.test(cap)) continue;
    // A budget's `take(kind, n, read)` with a bare callback: the count is its second argument.
    if (m[1] !== undefined && cap.includes(',')) {
      const parts = cap.split(',').map((p) => p.trim());
      cap = (parts.length >= 3 ? parts[1] : parts[0]) ?? '';
    }
    if (cap === '1') continue; // (a)
    // (b) read one past the bound, and refuse at it — a length compared past the bound in this function.
    const past = /^(.+?)\s*\+\s*1$/.exec(cap)?.[1];
    if (past !== undefined) {
      const body = text.slice(fn.at, fn.end);
      const bound = past.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\.length\\s*>\\s*${bound}\\b`).test(body)) continue;
    }
    out.add(`${file}#${fn.name}`);
  }
  return [...out];
}

/** Whole modules whose every read decides what a staffer may do, or what a decision acts on. */
const RULE_MODULES = [
  'lib/inboxRules.ts',
  'lib/inboxFlags.ts',
  'lib/requestDecisions.ts',
  'lib/recordRules.ts',
  'lib/undo.ts',
  'lib/undoHandlers.ts',
  'lib/undoHandlersCorpus.ts',
  'lib/undoHandlersBody.ts',
];
/** Rule functions in modules that also hold other reads. */
const RULE_FUNCTIONS: Record<string, ReadonlySet<string>> = {
  'contentFlags.ts': new Set(['flag']),
  'putIns.ts': new Set(['launchRefusal', 'launchRefusalOf']),
  'lib/inboxItems.ts': new Set(['itemToDecide', 'memberOf']),
  'lib/contentVerdicts.ts': new Set(['heldKindOn']),
};

/** The capped reads that pass by another argument — the rule-window table's (a)/(b)/(c) rows. */
const WINDOW_EXCEPTIONS: Record<string, string> = {
  'lib/inboxFlags.ts#openFlagsOn':
    '(c) the closers’ cap: a takedown or alert verdict closes ≤ FLAGS_READ a status; the rest stay open, shown in the item; the undo’s gather holds every one (DECISION_FLAGS_MAX — inboxReopenRule.test.ts)',
  'lib/inboxFlags.ts#leadRowOf':
    '(c) an undo writes its own row on the target before any flag’s (a Post’s ≤10 members first), so the lead is in the first LEAD_ROW_READ — inboxReopenRule.test.ts’ later-page cases, inboxPages.test.ts',
  'lib/undo.ts#undoRowOf':
    '(a) the state is whether any row undid it, and one is enough; which tagged row names the actor is the same undo’s, the same actor',
  'lib/undoHandlers.ts#recordOnlyRefusal':
    '(c) one verdict minted a row (`recordVerdict` once a `setContentStatus`), so two read is past it',
  'lib/requestDecisions.ts#openSiblings':
    '(c) the drain’s page: what one page leaves, the next reads (a cursor, or the range again), to REQUEST_SIBLINGS_MAX; past it the rest stay open, shown — inboxReopenRule.test.ts, corpusRequests.test.ts',
  'lib/requestDecisions.ts#ownAsks':
    '(b) while pending, an ask at a time, `unchecked` past OWN_ASKS_READ or the budget — the decision refuses on `unchecked` (ALONGSIDE_UNCHECKED)',
  'lib/undoHandlersBody.ts#undoPutIn':
    '(b) SUPPRESSION_ROWS_READ + 1 read; `launchRefusalOf` refuses past SUPPRESSION_ROWS_READ (SUPPRESSION_UNCHECKED — inboxReopenRule.test.ts)',
  'lib/undoHandlersBody.ts#restoreLandmarksRetiredBy':
    '(c) a bay retires at most a lake’s live landmarks (MAX_LANDMARKS_PER_BODY, held by create and restore), all in its own write, so they lead the oldest-first read of removals since it; each landmark’s newest row is an exact `.first()` — landmarks.test.ts',
  'lib/undoHandlersBody.ts#reRetireLandmarksRestoredWith':
    '(c) one undo writes a restore per landmark the bay retired (≤ MAX_LANDMARKS_PER_BODY) and a few rows of its own, all at one clock, so the same-instant read holds them; each landmark’s newest row is an exact `.first()` — landmarks.test.ts',
  'putIns.ts#launchRefusal':
    '(b) SUPPRESSION_ROWS_READ + 1 read; `launchRefusalOf` refuses past SUPPRESSION_ROWS_READ (SUPPRESSION_UNCHECKED — inboxReopenRule.test.ts)',
};

const read = (file: string) => blanked(readFileSync(resolve(CONVEX, file), 'utf8'));

test('every capped read in a rule is exact, refuses at its bound, or is named with why', () => {
  const found = [
    ...RULE_MODULES.flatMap((f) => windowsIn(f, read(f))),
    ...Object.entries(RULE_FUNCTIONS).flatMap(([f, only]) => windowsIn(f, read(f), only)),
  ];
  expect(found.filter((k) => !(k in WINDOW_EXCEPTIONS)).sort()).toEqual([]);
  // An exception whose reads now pass on their shape comes off the list.
  expect(Object.keys(WINDOW_EXCEPTIONS).filter((k) => !found.includes(k))).toEqual([]);
  // Every named function is still there to scan (a rename would scan nothing).
  for (const [f, only] of Object.entries(RULE_FUNCTIONS)) {
    const names = new Set(functionsOf(read(f)).map((fn) => fn.name));
    expect([...only].filter((n) => !names.has(n))).toEqual([]);
  }
  // Each exception says which argument it rests on.
  expect(Object.values(WINDOW_EXCEPTIONS).filter((why) => !/^\([abc]\) /.test(why))).toEqual([]);
});

test('the lint fails the shape the fifth pass found: a rule read from the target’s newest rows', () => {
  // `newerFlagsOn` as it stood at a09e9e19: the target's newest 100 flags, scanned for the deciding one.
  const before = blanked(`
export function newerFlagsOn(ctx, flag, n = NEWER_FLAGS_READ) {
  return ctx.db
    .query('contentFlags')
    .withIndex('by_target', (q) => q.eq('targetType', flag.targetType).eq('targetId', flag.targetId))
    .order('desc')
    .take(NEWER_FLAGS_READ);
}`);
  expect(windowsIn('lib/inboxFlags.ts', before)).toEqual(['lib/inboxFlags.ts#newerFlagsOn']);
  // `filedOnTarget` as it stood: the first eight of a viewer's members, scanned for an open one.
  const firstEight = blanked(`
async function filedOnTarget(ctx, item, viewerId, take) {
  const mine = await take(FILER_MEMBERS, (n) => ctx.db.query('inboxItemMembers').take(n));
}`);
  expect(windowsIn('lib/inboxRules.ts', firstEight)).toEqual(['lib/inboxRules.ts#filedOnTarget']);
  // A filtered scan before an existence read is a window too; the dedupe as it stood.
  const filtered = blanked(`
async function flag(ctx, args) {
  const existing = await ctx.db.query('contentFlags')
    .withIndex('by_target', (q) => q.eq('targetType', t))
    .filter((q) => q.eq(q.field('flaggerId'), me))
    .first();
}`);
  expect(windowsIn('contentFlags.ts', filtered)).toEqual(['contentFlags.ts#flag']);
  // The exact shapes pass: a point read, and one past the bound with its refusal.
  const exact = blanked(`
async function reopenFactsOf(ctx, flag) {
  const one = await ctx.db.query('contentFlags').withIndex('by_supersedes', (q) => q.eq('s', flag._id)).take(1);
  const all = await ctx.db.query('inboxItemMembers').take(DECISION_FLAGS_MAX + 1);
  if (all.length > DECISION_FLAGS_MAX) throw new Error('refused');
}`);
  expect(windowsIn('lib/inboxFlags.ts', exact)).toEqual([]);
});
