/**
 * **Every write of a Corpus task's source calls the one writer** (B01-6a). The Corpus lanes read
 * stored tasks (`corpusTasks`), kept by `lib/corpusTasks.ts` beside every write that changes a body's
 * questions. A write that skips it leaves a task open on a question a campaign dropped, or a raised
 * question in no lane — until the slow drift repair finds it.
 *
 * This lint reads the convex sources with their comments blanked, finds every such write by its
 * literal —
 *
 * - an `insert(…)`, `patch(…)` or `replace(…)` whose text names `reviewReasons`, `reviewReason` or
 *   `reviewSettled`, and every `...mergeFields(` spread (the import's: it carries all three);
 * - a delete of a `waterBodies` row: a `db.delete(` or a `.delete('waterBodies'` in a function that
 *   names the `'waterBodies'` table by its literal (a type argument, `Doc<'waterBodies'>`, doesn't
 *   count) —
 *
 * and holds each one's enclosing top-level function to calling an entry point of `lib/corpusTasks`
 * (`syncBodyTasks`, `leaveBodyTasks`, `leaveTask`, `settleReason`, `reopenTask`), found in the
 * function's text with comments **and strings** blanked, so a mention in either never counts. The
 * functions making them are exactly the inventories below — the writers, and the deletes named one
 * by one as not of a body — so a new one fails until it is read.
 *
 * **What it can't see:** a write whose fields arrive through a variable built elsewhere
 * (`patch(id, fields)` with no `mergeFields(` in the function); a body's merge, removal or restore,
 * which end or revive its questions through `mergedIntoId`, `removedAt` and `dedupStatus` rather
 * than the reason fields; a function nested inside another's body, judged by its top-level function's
 * text. Those found by reading are hooked, each with its test (`corpusTaskHooks.test.ts`):
 * `mergeBodyInto`, `unmerge.ts`' `restoreBodies`, `removeBodyImpl`, `restoreBodyImpl`. The drift
 * repair (`corpusTaskJobs:repair`, the open tasks and a lap over every body with a reason) is the net
 * for anything else.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

const CONVEX = resolve(__dirname, '../../convex/convex');

/** Every function that writes a task's source fields, by `file#function` — each calls the writer. */
const SOURCE_WRITERS: Record<string, string> = {
  'waterBodies.ts#importCanonical':
    'the import: reasons asserted, dropped, held or asked again (D305), insert and patch',
};

/** Functions that delete a `waterBodies` row: each calls the writer… */
const DELETE_WRITERS: Record<string, string> = {
  'waterBodies.ts#resolveIncomingMergeDuplicates':
    'a loser the import declined, deleted (its tasks leave `deleted`)',
  'waterBodies.ts#resolveCampaignDuplicates':
    'a duplicate the campaign did not re-affirm, deleted (its tasks leave `deleted`)',
};
/** …or deletes something else beside a body read, named here with why. */
const DELETE_NOT_BODIES: Record<string, string> = {
  'accessPoints.ts#setOfficialParking': 'deletes a parking row, not the body',
  'bodyGeo.ts#store': 'deletes a geometry fact row, not the body',
  'waterBodyFavorites.ts#toggle': 'deletes a favorite, not the body',
  // A seed person's drawing (dev only, `inboxSeed:clear`): drawn, never imported, so it carries no
  // review reason and so no task. Named here rather than hooked: `inboxSeed.ts` is not this wave's.
  'inboxSeed.ts#dropDrawnBody': 'a seed person’s drawn body: never imported, so never a question',
};

const ENTRY = /\b(syncBodyTasks|leaveBodyTasks|leaveTask|settleReason|reopenTask)\(/;
const SOURCE_FIELD = /\b(reviewReasons|reviewReason|reviewSettled)\b/;
const BODY_TABLE = /(?<!(?:Doc|Id|TableNames)<)'waterBodies'/;
const BODY_DELETE = /\bdb\.delete\(|\.delete\('waterBodies'/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '_generated' ? [] : sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

/** The text of the call opened at `start` (its first `(`), to its matching `)`. */
function callAt(text: string, start: number): string {
  let depth = 0;
  for (let i = text.indexOf('(', start); i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

/** Where each function starts: a top-level declaration (a Convex function is a top-level `const`). */
const DECL = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*[:=]/gm;

type Fn = { name: string; start: number; end: number };

function functionsOf(text: string): Fn[] {
  const starts = [...text.matchAll(DECL)].map((m) => ({
    name: m[1] ?? m[2] ?? '?',
    start: m.index,
  }));
  return starts.map((s, i) => ({ ...s, end: starts[i + 1]?.start ?? text.length }));
}

/** The function a position sits in: the last one starting at or before it. */
function enclosing(fns: readonly Fn[], at: number): Fn | undefined {
  let found: Fn | undefined;
  for (const f of fns) if (f.start <= at) found = f;
  return found;
}

/**
 * The source with its comments blanked (and, with `strings`, its string literals' contents too),
 * every offset kept — so a match is never a comment, and a hook mentioned only in one never counts.
 */
function blanked(source: string, strings: boolean): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g,
    (m, quote: string | undefined) =>
      quote
        ? strings
          ? `${quote}${' '.repeat(m.length - 2)}${quote}`
          : m
        : m.replace(/[^\n]/g, ' '),
  );
}

/** Each `file#function` writing a source (or deleting a body), and whether it calls the writer. */
function scanText(
  where: string,
  raw: string,
  writes: Map<string, boolean>,
  deletes: Map<string, boolean>,
): void {
  const text = blanked(raw, false);
  const bare = blanked(raw, true);
  const fns = functionsOf(text);
  const callsWriter = (fn: Fn | undefined) =>
    fn ? ENTRY.test(bare.slice(fn.start, fn.end)) : false;
  for (const m of text.matchAll(/\b(insert|patch|replace)\(|\.\.\.mergeFields\(/g)) {
    if (!m[0].startsWith('...') && !SOURCE_FIELD.test(callAt(text, m.index))) continue;
    const fn = enclosing(fns, m.index);
    const key = `${where}#${fn?.name ?? '?'}`;
    writes.set(key, (writes.get(key) ?? true) && callsWriter(fn));
  }
  for (const fn of fns) {
    const body = text.slice(fn.start, fn.end);
    if (BODY_TABLE.test(body) && BODY_DELETE.test(body)) {
      deletes.set(`${where}#${fn.name}`, callsWriter(fn));
    }
  }
}

function scan(root: string): { writes: Map<string, boolean>; deletes: Map<string, boolean> } {
  const writes = new Map<string, boolean>();
  const deletes = new Map<string, boolean>();
  for (const p of sources(root)) {
    const where = relative(root, p);
    if (where === 'lib/corpusTasks.ts') continue; // the writer itself
    scanText(where, readFileSync(p, 'utf8'), writes, deletes);
  }
  return { writes, deletes };
}

test('every write of a Corpus task’s source calls the one writer, and the writers are the inventory', () => {
  const { writes, deletes } = scan(CONVEX);
  expect([...writes.keys()].sort()).toEqual(Object.keys(SOURCE_WRITERS).sort());
  expect([...writes.entries()].filter(([, calls]) => !calls).map(([k]) => k)).toEqual([]);
  expect([...deletes.keys()].sort()).toEqual(
    [...Object.keys(DELETE_WRITERS), ...Object.keys(DELETE_NOT_BODIES)].sort(),
  );
  expect(Object.keys(DELETE_WRITERS).filter((k) => deletes.get(k) !== true)).toEqual([]);
});

test('the lint sees a writer that skips the hook, a spread of mergeFields, and a body deleted', () => {
  const text = [
    'export const sneaky = mutation({',
    '  handler: async (ctx, { id }) => {',
    '    await ctx.db.patch(id, { reviewReasons: undefined, reviewReason: undefined });',
    '  },',
    '});',
    'export const spread = mutation({',
    '  handler: async (ctx, { id, item }) => {',
    '    await ctx.db.patch(id, { ...mergeFields(item) });',
    '  },',
    '});',
    'export const drop = mutation({',
    "  handler: async (ctx, { id }: { id: Id<'waterBodies'> }) => {",
    "    const row = await ctx.db.query('waterBodies').first();",
    '    if (row) await ctx.db.delete(row._id);',
    '  },',
    '});',
    "function typed(row: Doc<'waterBodies'>, ctx: MutationCtx) {",
    '  return ctx.db.delete(row._id);',
    '}',
  ].join('\n');
  const writes = new Map<string, boolean>();
  const deletes = new Map<string, boolean>();
  scanText('x.ts', text, writes, deletes);
  expect(Object.fromEntries(writes)).toEqual({ 'x.ts#sneaky': false, 'x.ts#spread': false });
  // A type argument alone names no table: `typed` deletes something it was handed.
  expect(Object.fromEntries(deletes)).toEqual({ 'x.ts#drop': false });
});

test('a hook named only in a comment or a string does not count; a real call does', () => {
  const text = [
    'export const sneaky = mutation({',
    '  handler: async (ctx, { id }) => {',
    '    // await syncBodyTasks(ctx, id);',
    "    const note = 'leaveBodyTasks(ctx, id)';",
    '    await ctx.db.patch(id, { reviewSettled: [] });',
    '  },',
    '});',
    'export const honest = mutation({',
    '  handler: async (ctx, { id }) => {',
    "    await ctx.db.patch(id, { reviewReason: 'name-conflict' });",
    '    await syncBodyTasks(ctx, id);',
    '  },',
    '});',
  ].join('\n');
  const writes = new Map<string, boolean>();
  scanText('x.ts', text, writes, new Map());
  expect(Object.fromEntries(writes)).toEqual({ 'x.ts#sneaky': false, 'x.ts#honest': true });
});
