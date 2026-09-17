/**
 * The workstream-naming convention, enforced.
 *
 * `plans/README.md § Workstreams` says a workstream is `§3`, its items `§3.2`, and the sigil is
 * mandatory — so that a bare `A4` or `B2` can only ever be a phase and `D74` can only ever be a
 * decision. The renumbering pass (2026-09-17, PRs #64/#65) got the tree there by hand, and found on
 * the way that the two things a letter can collide with are exactly the two registers readers
 * trust most: `A06c`'s "Workstream D2" was cited as `D2` in ~70 places while decision D2 is "Convex
 * as the app database", and `A08`'s `### D3 — Fail-open` read as the safety invariant. A rule
 * nobody checks drifts, so this test reads `plans/` and `docs/` and fails on the old shapes:
 *
 * - `Workstream A` / `§A` — a lettered workstream, in prose or a heading;
 * - a bare `A4`, `B5b`, `E3's` — a lettered workstream *item* (letters A–G; `D#` is a decision, and
 *   a single-digit `D1`–`D9` *heading* inside a phase doc is the one D-shape that can't be one);
 * - `A08/B4`, `D84/C4` — the slash forms the first pass missed.
 *
 * Inline code and fenced blocks are stripped first: a doc may quote an old name in backticks
 * (`plans/README.md` is the record of the mapping and is exempt outright; the plan that ran the
 * pass, `features/phase-numbers.md`, was deleted when it shipped). Anchors (`#d2--…`) and paths (`A06c/lake-depth`) are excluded by the lookbehinds.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO = resolve(__dirname, '../../..');
const ROOTS = ['plans', 'docs'].map((d) => join(REPO, d));
const EXEMPT = new Set(['plans/README.md']);

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

/** Prose only: fenced blocks and inline code spans are where a doc is allowed to quote the past. */
function prose(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

type Rule = { name: string; pattern: RegExp; phasesOnly?: boolean };

const RULES: Rule[] = [
  {
    name: 'lettered workstream ("Workstream A")',
    pattern: /\bWorkstream \**[A-H]\d?[a-z]?\b(?![-–→])/gu,
  },
  { name: 'lettered sigil ("§A")', pattern: /§[A-H](?![A-Za-z])/gu },
  {
    // `D` is allowed in the ` — ` form only because `## D74 — …` is how the register titles a
    // decision; the single-digit phase-doc rule below is where a `D` heading can still be wrong.
    name: 'lettered workstream heading ("### A. …" / "### B3 — …")',
    pattern: /^#{1,6} \**(?:[A-H]\. |[ABCEFGH]\d?[a-z]? — )/gmu,
  },
  {
    name: 'single-digit D heading in a phase doc (a workstream item posing as a decision)',
    pattern: /^#{2,6} D[1-9] — /gmu,
    phasesOnly: true,
  },
  {
    name: 'bare workstream item ("A4", "B5b", "E3\'s")',
    // Not after a word char, sigil, anchor `#` or path `/`; not before a digit, dot, or dash (so
    // `A06c`, `2.5`, `B2B`, and `pre-A08` don't match — those have their own shapes).
    pattern: /(?<![A-Za-z0-9_§#/"$])[ABCEFG][1-9][a-z]?\b(?![.\d"-])/gu,
  },
  {
    // After a phase token or a `§` ref any letter is a workstream (`A06c/D`, `§2.3a/D`); after a
    // decision only A–C/E–H are, since `D50/D3` is two decisions.
    name: 'slash form ("A08/B4", "D84/C4", "§2.1/B2")',
    pattern:
      /(?:(?:\b(?:A0\d[a-z]?|0\d[ab]?|10)|§\d(?:\.\d+)?[a-z]?)\/[A-H]\d?[a-z]?|\bD\d+\/[ABCEFGH]\d?[a-z]?)\b(?![-–→.\d])/gu,
  },
];

function violations(): string[] {
  const found: string[] = [];
  for (const root of ROOTS) {
    for (const file of markdownFiles(root)) {
      const rel = relative(REPO, file);
      if (EXEMPT.has(rel)) continue;
      const text = prose(readFileSync(file, 'utf8'));
      const isPhaseDoc = rel.startsWith('plans/phases/');
      for (const rule of RULES) {
        if (rule.phasesOnly && !isPhaseDoc) continue;
        for (const m of text.matchAll(rule.pattern)) {
          const line = text.slice(0, m.index).split('\n').length;
          found.push(`${rel}:${line}  ${rule.name}  →  ${m[0]}`);
        }
      }
    }
  }
  return found;
}

describe('plans/ and docs/ follow the workstream convention (§N.M, never a letter)', () => {
  test('no lettered workstream, sigil, heading, bare item, or slash form survives', () => {
    expect(violations()).toEqual([]);
  });

  test('the rules catch what the renumbering pass had to fix by hand', () => {
    const sample = [
      '## Workstream D2 — Profile richness feeds prominence', // A06c, cited as `D2` ~70 times
      '### D3 — Fail-open, because the failure is silent', // A08, read as the safety decision
      '### F. Mobile (separate follow-on PR(s))', // 02a
      "E3's activity gate and B4a's dedup ladder", // possessives the first sweep skipped
      'the same shape as A08/B4 and D84/C4', // slash forms its lookbehind excluded
      'see §A3 and Workstream E for the rest',
    ].join('\n');
    const hits = RULES.flatMap((r) => [...sample.matchAll(r.pattern)].map((m) => m[0]));
    expect(hits).toEqual(
      expect.arrayContaining([
        'Workstream D2',
        '### D3 — ',
        '### F. ',
        'E3',
        'B4a',
        'A08/B4',
        'D84/C4',
        '§A',
        'Workstream E',
      ]),
    );
  });

  test('the rules leave the registers, phase tokens, and section-by-name refs alone', () => {
    const sample = [
      'D74 says so; see D3 and D184, and Q8 / L12', // decisions and the other registers
      'Phase A06c §4.2, A08 §2.4a, 02a §6.2, pre-A08, B01-4', // the new shapes
      "README §CORS, A09's §Wind in a cove, `phases/A06e` §New York", // § as "section", by name
      'Tier A and Tier B, the A→B→C pipeline, R2, S2, H3, B2B', // products, stages, not workstreams
      '`old text may say A4 in backticks`',
    ].join('\n');
    const hits = RULES.flatMap((r) => [...prose(sample).matchAll(r.pattern)].map((m) => m[0]));
    expect(hits).toEqual([]);
  });
});
