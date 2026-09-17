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

// ─────────────────────────────────────────────────────────────────────────────
// Two rules the renumbering pass (features/phase-numbers.md, deleted 2026-09-17 when it shipped)
// had left as "not done, noted", closed in the US-spellings PR and kept closed here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A phase doc's H1 is `# Phase <token> — <title>` — the same shape as its roadmap entry. The pass
 * found three styles in the tree (`# Phase 01 build plan —`, `# A01 —`, `# Phase A06e —`); a reader
 * skimming `plans/phases/` should not have to guess whether a bare `A01` is a doc or a citation.
 * `A03 / A04` is the one shared doc.
 */
const PHASE_H1 = /^# Phase (?:\d\d[a-z]?|A\d\d[a-z]?(?: \/ A\d\d)?) — \S/u;

describe('every phase doc is headed "# Phase <token> — <title>"', () => {
  test('no phase doc H1 deviates', () => {
    const bad = markdownFiles(join(REPO, 'plans/phases')).flatMap((file) => {
      const h1 = readFileSync(file, 'utf8')
        .split('\n')
        .find((l) => l.startsWith('# '));
      return h1 && PHASE_H1.test(h1) ? [] : [`${relative(REPO, file)}: ${h1 ?? '(no H1)'}`];
    });
    expect(bad).toEqual([]);
  });

  test('the rule accepts the shapes in use and rejects the three the pass had to fix', () => {
    for (const ok of [
      '# Phase 00 — Foundations',
      '# Phase 02a — Map',
      '# Phase A06e — Imagery',
      '# Phase A03 / A04 — Accounts',
    ]) {
      expect(PHASE_H1.test(ok), ok).toBe(true);
    }
    for (const bad of [
      '# Phase 01 build plan — Water',
      '# A01 — Read-path',
      '# Phase A03/A04 — Accounts',
      '# Foundations',
    ]) {
      expect(PHASE_H1.test(bad), bad).toBe(false);
    }
  });
});

/**
 * Every relative link in the Markdown tree resolves — the file exists, and the `#anchor` is the
 * GitHub slug of a heading in it. The pass found 84 that did not: 80 short `[D3](#d3)` forms inside
 * `01-decisions.md` whose real slug is `#d3--safety-first…`, full slugs whose heading text had since
 * changed, two decisions (D109, D110) cited by a dozen places that had never been written up, and
 * links into A07a's own `## D9x` entries from the register. A stale anchor renders as a link and
 * silently scrolls nowhere, so this is the one check a reader cannot do by eye.
 *
 * GitHub's slug (github-slugger): lowercase; drop everything that is not a letter, number, mark,
 * space, `-` or `_`; spaces become `-`; a repeated slug gets `-1`, `-2`. Two things fall out of
 * that: an em dash leaves a double hyphen (`d3--safety-first`), and an emoji-led heading slugs to a
 * leading hyphen (`#-six-ways-…`). Code spans and emphasis markers are stripped first, as GitHub does.
 */
const LINK_ROOTS = [
  ...ROOTS,
  join(REPO, 'README.md'),
  ...readdirSync(join(REPO, 'scripts')).flatMap((pkg) =>
    ['README.md', 'PROVENANCE.md'].map((n) => join(REPO, 'scripts', pkg, n)),
  ),
].filter((p) => statSync(p, { throwIfNoEntry: false }));

function githubSlug(heading: string): string {
  const stripped = heading
    .replace(/`/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/(?<!\w)[*_](?!\w)/g, '')
    .toLowerCase();
  let out = '';
  for (const ch of stripped) {
    if (ch === ' ') out += '-';
    else if (ch === '-' || ch === '_' || /[\p{L}\p{N}\p{M}]/u.test(ch)) out += ch;
  }
  return out;
}

/** Fenced blocks and HTML comments are not rendered links; the roadmap's entry template lives in one. */
function linkable(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, '').replace(/<!--[\s\S]*?-->/g, '');
}

const anchorCache = new Map<string, Set<string>>();
function anchorsOf(file: string): Set<string> {
  let set = anchorCache.get(file);
  if (set) return set;
  set = new Set();
  const seen = new Map<string, number>();
  const text = linkable(readFileSync(file, 'utf8'));
  for (const m of text.matchAll(/^#{1,6} (.+?)\s*#*$/gmu)) {
    const base = githubSlug(m[1] as string);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    set.add(n === 0 ? base : `${base}-${n}`);
  }
  for (const m of text.matchAll(/<a\s+(?:id|name)="([^"]+)"/gu)) set.add(m[1] as string);
  anchorCache.set(file, set);
  return set;
}

function brokenLinks(): string[] {
  const found: string[] = [];
  const files = LINK_ROOTS.flatMap((p) => (statSync(p).isDirectory() ? markdownFiles(p) : [p]));
  for (const file of files) {
    const rel = relative(REPO, file);
    const text = linkable(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/gu)) {
      const target = m[1] as string;
      if (/^[a-z]+:/u.test(target)) continue; // http(s), mailto
      const [path, anchor] = target.split('#') as [string, string | undefined];
      const targetFile = path ? resolve(file, '..', path) : file;
      const line = text.slice(0, m.index).split('\n').length;
      if (path && !statSync(targetFile, { throwIfNoEntry: false })) {
        found.push(`${rel}:${line}  no such file  →  ${target}`);
        continue;
      }
      if (anchor && targetFile.endsWith('.md') && !anchorsOf(targetFile).has(anchor)) {
        found.push(`${rel}:${line}  no such anchor  →  ${target}`);
      }
    }
  }
  return found;
}

describe('every relative link and #anchor in the Markdown tree resolves', () => {
  test('no broken file or anchor links', () => {
    expect(brokenLinks()).toEqual([]);
  });

  test('the slugger matches GitHub on the shapes that bit', () => {
    expect(githubSlug('D3 — Safety-first, non-authoritative framing (product-defining)')).toBe(
      'd3--safety-first-non-authoritative-framing-product-defining',
    );
    expect(githubSlug('⚠ Six ways to get this wrong, each of which costs money')).toBe(
      '-six-ways-to-get-this-wrong-each-of-which-costs-money',
    );
    expect(githubSlug('§0 — Getting the way in into the app ✅ **BUILT 2026-08-21**')).toBe(
      '0--getting-the-way-in-into-the-app--built-2026-08-21',
    );
    expect(githubSlug('D129 — `RECONCILE_MIN_IOU` **holds at 0.5**, and nine pairs (A07a-2)')).toBe(
      'd129--reconcile_min_iou-holds-at-05-and-nine-pairs-a07a-2',
    );
    expect(githubSlug('D90 — Wind exposure is frequency × fetch, never fetch alone (A06c-1)')).toBe(
      'd90--wind-exposure-is-frequency--fetch-never-fetch-alone-a06c-1',
    );
  });
});
