/**
 * The roadmap's shape, enforced.
 *
 * `plans/07-roadmap.md` was rewritten on 2026-09-16 around one entry template (the HTML comment at
 * the top of the file) after the old one drifted into 1,900 lines with three phases missing, one
 * phase listed twice, and status written five different ways. A template nobody checks drifts
 * again, so this test reads the file and holds it to what the template promises:
 *
 * - every `## Phase …` heading is followed by exactly one status line of the fixed shape, then a
 *   blank line, then the summary paragraph — present, and bounded (the old file's entries ran to
 *   hundreds of lines; the template says ~120 words, up to ~180 for a big phase);
 * - the `####` sections under an entry come from the fixed set, in the fixed order, once each;
 * - every phase doc in `plans/` has an entry, and every entry's `[plan](…)` link resolves;
 * - the deferred register is present and is a table.
 *
 * It reads the repo rather than a fixture on purpose — the fixture would be the thing that drifts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const PLANS = resolve(__dirname, '../../../plans');
const ROADMAP = join(PLANS, '07-roadmap.md');
const roadmap = readFileSync(ROADMAP, 'utf8');

/** The template, minus the HTML comment that carries it (so the example entry isn't an entry). */
const body = roadmap.replace(/<!--[\s\S]*?-->/g, '');

const STATUS_LINE =
  /^(🟢 \*\*Complete\*\*|🟡 \*\*In progress\*\*|⚪ \*\*Scoped\*\*|⚫ \*\*Withdrawn\*\*) \d{4}-\d{2}-\d{2}(?: · PRs? #\d+(?:[–, #\d]*\d)?)? · \[plan\]\((\.\/[^)]+\.md)\)(?: · D\d+[^\n]*)?$/u;

const SECTIONS = ['Data runs', 'Deferred', 'Ruled out', 'Owed'] as const;

type Entry = {
  heading: string;
  statusLine: string;
  afterStatus: string;
  summaryWords: number;
  planPath: string;
  sections: string[];
};

function parseEntries(text: string): Entry[] {
  const lines = text.split('\n');
  const entries: Entry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.startsWith('## Phase ')) continue;
    const statusLine = lines[i + 1] ?? '';
    const afterStatus = lines[i + 2] ?? '';
    const sections: string[] = [];
    const summary: string[] = [];
    let inSummary = true;
    for (let j = i + 3; j < lines.length; j++) {
      const l = lines[j] ?? '';
      if (l.startsWith('## ')) break;
      if (l.startsWith('#### ')) {
        inSummary = false;
        sections.push(l.slice(5).trim());
        continue;
      }
      if (inSummary) summary.push(l);
    }
    const summaryWords = summary.join(' ').split(/\s+/).filter(Boolean).length;
    const planPath = statusLine.match(/\[plan\]\((\.\/[^)]+\.md)\)/)?.[1] ?? '';
    entries.push({ heading: line, statusLine, afterStatus, summaryWords, planPath, sections });
  }
  return entries;
}

const entries = parseEntries(body);

describe('plans/07-roadmap.md follows its own entry template', () => {
  test('has entries', () => {
    expect(entries.length).toBeGreaterThan(20);
  });

  test('every entry heading is followed by one status line of the fixed shape', () => {
    const bad = entries.filter((e) => !STATUS_LINE.test(e.statusLine));
    expect(
      bad.map((e) => `${e.heading}\n  got: ${e.statusLine}`),
      'status line must be: <dot> **<Status>** YYYY-MM-DD · PR #n · [plan](./…md) · D#…',
    ).toEqual([]);
  });

  test('the status line stands alone, followed by a blank line', () => {
    const bad = entries.filter((e) => e.afterStatus.trim() !== '');
    expect(
      bad.map((e) => `${e.heading}\n  after the status line: ${e.afterStatus}`),
      'nothing rides on the status line — the summary starts after a blank line',
    ).toEqual([]);
  });

  test('every entry has a summary paragraph, and it is a paragraph, not an essay', () => {
    const MIN = 40;
    const MAX = 220; // the template says ~120, up to ~180; this catches the essay, not the 130
    const bad = entries.filter((e) => e.summaryWords < MIN || e.summaryWords > MAX);
    expect(
      bad.map((e) => `${e.heading}: ${e.summaryWords} words (want ${MIN}–${MAX})`),
      'the summary is the entry; the detail belongs in the phase doc',
    ).toEqual([]);
  });

  test('sections come from the fixed set, in the fixed order, at most once each', () => {
    const bad: string[] = [];
    for (const e of entries) {
      const unknown = e.sections.filter((s) => !(SECTIONS as readonly string[]).includes(s));
      if (unknown.length) bad.push(`${e.heading}: unknown section(s) ${unknown.join(', ')}`);
      const order = e.sections.map((s) => SECTIONS.indexOf(s as (typeof SECTIONS)[number]));
      const sorted = [...order].sort((a, b) => a - b);
      if (order.join() !== sorted.join())
        bad.push(`${e.heading}: sections out of order (${e.sections.join(' → ')})`);
      if (new Set(e.sections).size !== e.sections.length)
        bad.push(`${e.heading}: a section repeats`);
    }
    expect(bad).toEqual([]);
  });

  test('every [plan] link resolves', () => {
    const missing = entries.filter((e) => !existsSync(resolve(dirname(ROADMAP), e.planPath)));
    expect(missing.map((e) => `${e.heading} → ${e.planPath}`)).toEqual([]);
  });

  test('every phase doc has an entry', () => {
    // Flat `phase-*.md` today; `phases/*.md` after the renumbering pass. Both are checked so the
    // test survives the move without an edit.
    const docs = [
      ...readdirSync(PLANS)
        .filter((f) => /^phase-.*\.md$/.test(f))
        .map((f) => `./${f}`),
      ...(existsSync(join(PLANS, 'phases'))
        ? readdirSync(join(PLANS, 'phases'))
            .filter((f) => f.endsWith('.md'))
            .map((f) => `./phases/${f}`)
        : []),
    ];
    const linked = new Set(entries.map((e) => e.planPath));
    const orphaned = docs.filter((d) => !linked.has(d));
    expect(orphaned, 'a phase doc with no roadmap entry — add one from the template').toEqual([]);
  });

  test('no phase is entered twice', () => {
    const tokens = entries.map((e) => e.heading.replace(/^## Phase /, '').split(' — ')[0]);
    const dupes = tokens.filter((t, i) => tokens.indexOf(t) !== i);
    expect(dupes).toEqual([]);
  });

  test('the deferred register is a table at the end', () => {
    const idx = body.indexOf('## Deferred register');
    expect(idx).toBeGreaterThan(0);
    const after = body.slice(idx);
    expect(after).toMatch(
      /\n\| Item \| Status \| Blocked on \| Where \|\n\| --- \| --- \| --- \| --- \|\n/,
    );
    expect(after.includes('\n## Phase ')).toBe(false);
  });
});
