/**
 * The D248 erasure and record jobs charge every read against one budget per transaction
 * (`convex/lib/readBudget.ts`), so no pass reads past Convex's limit however heavy its rows. A raw
 * read added outside a charge is the regression this catches: in the modules below, every database
 * read — `ctx.db.get`, `.first()`, `.unique()`, `.take(`, `.paginate(`, `.collect()` — must sit inside
 * the parentheses of a charging call (`reads.one/take/page`, `budget.one/take/page`, or `drain(`,
 * which charges what its `take` returns). `.collect()` and `.unique()` are refused outright: neither
 * has a bound a budget can size.
 *
 * A lint over the source text, not a proof: a read reached through a helper in another module is
 * the helper's to charge (`lib/eraseClock` is in the list for that reason).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const CONVEX = resolve(__dirname, '../../convex/convex');
const MODULES = ['erasure.ts', 'contentRecord.ts', 'authorDeletions.ts', 'lib/eraseClock.ts'];

/** The source with comments and string contents blanked, offsets preserved. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(
      /(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g,
      (m) => `${m[0]}${' '.repeat(m.length - 2)}${m[0]}`,
    );
}

/** Spans `[open, close]` of every charging call's argument list. */
function chargedSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const opener = /\b(?:reads|budget)\.(?:one|take|page)\(|\bdrain\(/g;
  for (let m = opener.exec(text); m; m = opener.exec(text)) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) {
        spans.push([m.index, i]);
        break;
      }
    }
  }
  return spans;
}

/** Every read in `text` outside a charging call, as `line: source`. */
function unchargedReads(source: string): string[] {
  const text = code(source);
  const spans = chargedSpans(text);
  const read = /\bdb\.get\(|\.first\(\)|\.unique\(\)|\.collect\(\)|\.take\(|\.paginate\(/g;
  const out: string[] = [];
  for (let m = read.exec(text); m; m = read.exec(text)) {
    const at = m.index;
    const isBudgetCall = /\b(?:reads|budget)$/.test(text.slice(Math.max(0, at - 7), at));
    if (isBudgetCall) continue;
    const unbounded = m[0] === '.collect()' || m[0] === '.unique()';
    const inside = spans.some(([open, close]) => at > open && at < close);
    if (inside && !unbounded) continue;
    const line = text.slice(0, at).split('\n').length;
    out.push(`${line}: ${source.split('\n')[line - 1]?.trim()}`);
  }
  return out;
}

test.each(MODULES)('every read in %s is charged against its budget', (module) => {
  expect(unchargedReads(readFileSync(resolve(CONVEX, module), 'utf8'))).toEqual([]);
});

test('the lint sees a raw read, and passes a charged one', () => {
  expect(unchargedReads('const x = await ctx.db.get(id);')).toHaveLength(1);
  expect(unchargedReads("const x = await reads.one('report', () => ctx.db.get(id));")).toEqual([]);
  expect(unchargedReads("await reads.take('small', n, (k) => ctx.db.query('x').take(k));")).toEqual(
    [],
  );
  expect(
    unchargedReads("await reads.one('small', () => ctx.db.query('x').collect());"),
  ).toHaveLength(1);
  expect(unchargedReads("// ctx.db.get(id) in a comment\nconst s = 'ctx.db.get(id)';")).toEqual([]);
});
