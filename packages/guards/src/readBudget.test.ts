/**
 * The D248 erasure and record jobs charge every read against one budget per transaction
 * (`convex/lib/readBudget.ts`), so no pass reads past Convex's limit however heavy its rows. A raw
 * read added outside a charge is the regression this catches: in the modules below, every database
 * read — `ctx.db.get`, `.first()`, `.unique()`, `.take(`, `.paginate(`, `.collect()` — must sit inside
 * the parentheses of a charging call (`reads.one/take/page/measured/capped`, the same on `budget` and
 * on the request's budget opened in place, `requestBudget(…)`, a wave item's `share.read(` and
 * `share.take(` — charged to what `ReadBudget.waves` reserved for it — `drain(` — which charges what
 * its `take` returns — the People pages' `takeCapped(`, or the record sheet's `takeAfter(`, whose two
 * parts each go through `reads.take`). `.collect()` and `.unique()` are refused
 * outright: neither has a bound a budget can size.
 *
 * A lint over the source text, not a proof: a read reached through a helper in another module is
 * the helper's to charge (`lib/eraseClock` is in the list for that reason).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const CONVEX = resolve(__dirname, '../../convex/convex');
const MODULES = [
  'erasure.ts',
  'contentRecord.ts',
  'authorDeletions.ts',
  'lib/eraseClock.ts',
  // The People pages (B01-4): every public read and job, each read charged on every axis.
  'people.ts',
  'peopleJobs.ts',
  // A staffer's tenure, read live by the strip and stamped on the Staff lane's rows (B01-4b).
  'lib/staffTenure.ts',
  // The rows an undo's refusal reads, which History and Decisions reach on every line (B01-3f).
  'lib/undoReads.ts',
  // The People record sheet's lists, counts and pane (B01-4d).
  'lib/recordReads.ts',
];

/**
 * The source with comments and string contents blanked, offsets preserved. One pass, so whichever
 * starts first wins: a `//` or `/*` inside a string is not a comment, and a quote inside a comment is
 * not a string — either mistake would blank real code and hide a read on it.
 */
function code(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g,
    (m, quote: string | undefined) =>
      quote ? `${quote}${' '.repeat(m.length - 2)}${quote}` : m.replace(/[^\n]/g, ' '),
  );
}

/** Spans `[open, close]` of every charging call's argument list. */
function chargedSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const opener =
    /\b(?:reads|budget|requestBudget\([^()]*\))\.(?:one|take|page|measured|capped)\(|\bshare\.(?:read|take)\(|\bdrain\(|\btakeCapped\(|\btakeAfter\(/g;
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
    // The charging call itself (`budget.take(`, a wave item's `share.take(`), not a read it wraps.
    const isBudgetCall = /\b(?:reads|budget|share)$/.test(text.slice(Math.max(0, at - 7), at));
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
  // A comment marker inside a string hides nothing after it.
  expect(unchargedReads("const u = 'https://x'; const y = await ctx.db.get(id);")).toHaveLength(1);
  // A wave item's share (`lib/undoReads`) charges its read to what `ReadBudget.waves` reserved.
  expect(
    unchargedReads('const r = share.read(kind, () => ctx.db.get(id) as Promise<Doc<T> | null>);'),
  ).toEqual([]);
  expect(unchargedReads('share.read(kind, get); const x = await ctx.db.get(id);')).toHaveLength(1);
  // Its `take` charges the rows its read returns, as `budget.take` does.
  expect(unchargedReads('take: (kind, n, read) => share.take(kind, n, read),')).toEqual([]);
  expect(unchargedReads("await share.take('launch', n, () => ctx.db.query('x').take(n));")).toEqual(
    [],
  );
  expect(
    unchargedReads("share.take(kind, n, read); await ctx.db.query('x').take(5);"),
  ).toHaveLength(1);
  // The request's own budget, opened in place, charges as `budget` does.
  expect(
    unchargedReads("await requestBudget(ctx).measured('putIn', () => ctx.db.get(id));"),
  ).toEqual([]);
  expect(
    unchargedReads("await requestBudget(ctx, OPEN).one('profile', () => ctx.db.get(id));"),
  ).toEqual([]);
  // The record sheet's two-part read charges each part through `reads.take`.
  expect(
    unchargedReads("await takeAfter(reads, 'verdict', n, null, (m) => q().take(m));"),
  ).toEqual([]);
  expect(unchargedReads('takeAfter(reads, k, n, a, b); await q().take(5);')).toHaveLength(1);
  // Opening it is no charge: a read beside it, outside a charging call, is still caught.
  expect(unchargedReads('const b = requestBudget(ctx); await ctx.db.get(id);')).toHaveLength(1);
  expect(
    unchargedReads("requestBudget(ctx).spend(1); await ctx.db.query('x').take(5);"),
  ).toHaveLength(1);
});
