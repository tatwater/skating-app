/**
 * A phase doc's numbered sections (`### N.M`, `### §N.M —`) are unique and in order.
 *
 * **Why this exists.** PR #104's branch was rebased onto a main that had grown two new sections in
 * `B03-skater-web.md`, and the rebase renumbered the branch's own §8.3 to §8.5 — correctly. The
 * follow-up commit then *appended* a `### 8.4`, so main landed with two §8.4s and with a paragraph
 * and six code comments pointing at a "§8.3" that was now somebody else's section. Nothing caught
 * it: the number is prose to every other check, the doc still parsed, and the citations still
 * looked like citations.
 *
 * That is the ordinary cost of a numbered register in a file two branches both append to, so it
 * gets a lint rather than a convention. Duplicates and backward jumps are both failures — a section
 * out of order is how a duplicate gets written next.
 *
 * It also holds the other half: a `B03 §8.5` in the code has to resolve to a section that exists.
 * A pointer into a register is only worth its accuracy, and the renumbering above is exactly the
 * event that breaks every one of them at once.
 *
 * Lives in `@skating/guards` because it reads `plans/` and the apps' sources off disk, which no
 * Turbo input glob describes (D236).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO = resolve(__dirname, '../../..');
const PHASES = join(REPO, 'plans/phases');

function files(dir: string, ext: string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) return [];
    if (statSync(path).isDirectory()) return files(path, ext);
    return ext.some((e) => name.endsWith(e)) ? [path] : [];
  });
}

/**
 * Every numbered section of a phase doc, in the order it appears, as the doc writes it: `8.5` for
 * `### 8.5 Title` (B03), `§2.4` for `### §2.4 — Title` (A06c, A08, …), and `§9.1` for a
 * `- §9.1 Title` item under a `### §9 —` workstream heading (A10 numbers its workstreams that way).
 *
 * The `§` stays on the number because the two forms are two registers, not two spellings of one: a
 * doc can number its outline `1.1` and its workstreams `§1.1` side by side (A05c does), so they are
 * counted and ordered apart. Missing the `§` form is how this guard once read A08 as having no
 * sections at all, and so skipped every citation into it.
 */
function sectionNumbers(body: string): string[] {
  return [...body.matchAll(/^(?:#{2,4}[ \t]+(§?\d+\.\d+)|- (§\d+\.\d+))[ \t]+\S/gm)].map(
    (m) => (m[1] ?? m[2]) as string,
  );
}

/** `§2.4` → `§`, `8.5` → `` — which register a section number belongs to. */
const register = (n: string) => (n.startsWith('§') ? '§' : '');

/** `B03 §8.5`, `A06c §2.5` — a phase token and a section, as the code comments write them. */
const CITATION = /\b([A-Z]\d{2}[a-z]?)\s+§(\d+\.\d+)/g;

/**
 * Every citation in `source` that does not resolve, as a sentence. A citation's `§` is how the code
 * marks a pointer, so `B03 §8.5` resolves to either register's `8.5`. A phase with no doc is not this
 * guard's business; a phase whose doc has no numbered section the guard can read is — that is a
 * parser that has stopped seeing the doc, and it would otherwise pass every citation silently.
 */
function brokenCitations(
  source: string,
  where: string,
  byPhase: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const broken: string[] = [];
  for (const [, phase, section] of source.matchAll(CITATION)) {
    const sections = byPhase.get(phase as string);
    if (!sections) continue;
    if (sections.size === 0) {
      broken.push(`${where} cites ${phase} §${section}, but no numbered section in its doc parses`);
    } else if (!sections.has(section as string) && !sections.has(`§${section}`)) {
      broken.push(`${where} cites ${phase} §${section}, which does not exist`);
    }
  }
  return broken;
}

const phaseDocs = files(PHASES, ['.md']).map((path) => ({
  path,
  name: relative(REPO, path),
  body: readFileSync(path, 'utf8'),
}));

describe('a phase doc’s numbered sections', () => {
  test('there is at least one phase doc to check', () => {
    expect(phaseDocs.length).toBeGreaterThan(0);
  });

  test('no number is used twice', () => {
    for (const doc of phaseDocs) {
      const seen = new Map<string, number>();
      const twice: string[] = [];
      for (const n of sectionNumbers(doc.body)) {
        const count = (seen.get(n) ?? 0) + 1;
        seen.set(n, count);
        if (count === 2) twice.push(n);
      }
      expect(twice, `${doc.name} numbers two sections the same`).toEqual([]);
    }
  });

  test('numbers only ever go up, within each register', () => {
    const value = (n: string) => {
      const [major, minor] = n.replace('§', '').split('.').map(Number) as [number, number];
      return major * 1000 + minor;
    };
    for (const doc of phaseDocs) {
      const all = sectionNumbers(doc.body);
      for (const reg of ['', '§']) {
        const numbers = all.filter((n) => register(n) === reg);
        const backwards = numbers.filter(
          (n, i) => i > 0 && value(n) <= value(numbers[i - 1] as string),
        );
        expect(backwards, `${doc.name} goes backwards at these sections`).toEqual([]);
      }
    }
  });
});

describe('a §N.M pointer in the code', () => {
  const sources = ['apps/web/src', 'apps/mobile/src', 'packages']
    .map((d) => join(REPO, d))
    .filter((d) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    })
    .flatMap((d) => files(d, ['.ts', '.tsx']))
    // Generated coverage reports quote old comments back at us.
    .filter((p) => !p.includes('/coverage/') && !p.includes('/_generated/'));

  const byPhase = new Map(
    phaseDocs.map((doc) => {
      const phase = /^([A-Z]\d{2}[a-z]?)/.exec(doc.name.replace('plans/phases/', ''))?.[1] ?? '';
      return [phase, new Set(sectionNumbers(doc.body))];
    }),
  );

  test('resolves to a section that exists in that phase’s doc', () => {
    const broken = sources.flatMap((path) =>
      brokenCitations(readFileSync(path, 'utf8'), relative(REPO, path), byPhase),
    );
    expect(broken).toEqual([]);
  });
});

describe('sectionNumbers', () => {
  test('reads both heading forms, keeping the § on the number', () => {
    const doc = ['## §1 — Part', '### §1.1 — Read path', '### 1.2 Outline', '#### §2.4 — Deep'];
    expect(sectionNumbers(doc.join('\n'))).toEqual(['§1.1', '1.2', '§2.4']);
  });

  test('reads a workstream’s `- §N.M` items, but not a bold or plain list item', () => {
    const doc = ['### §9 — Offline', '- §9.1 The queue', '- **§9.1 as built**', '- 9.2 A list'];
    expect(sectionNumbers(doc.join('\n'))).toEqual(['§9.1']);
  });

  test('skips what is not a numbered section', () => {
    const doc = [
      '# 1.1 A title, not a section',
      '##### 1.1 Too deep',
      '## §6 — One level',
      '#### §2.4a — A lettered sub-part',
      '### 1.1',
      'Prose that says ### 1.1 midline',
    ];
    expect(sectionNumbers(doc.join('\n'))).toEqual([]);
  });
});

describe('brokenCitations', () => {
  const byPhase = new Map<string, Set<string>>([
    ['A08', new Set(['§1.1', '§2.4'])],
    ['B03', new Set(['8.5'])],
    ['A99', new Set()],
  ]);

  test('a citation resolves to either register', () => {
    expect(brokenCitations('A08 §2.4, B03 §8.5', 'f.ts', byPhase)).toEqual([]);
  });

  test('a missing section is broken', () => {
    expect(brokenCitations('see A08 §3.1', 'f.ts', byPhase)).toEqual([
      'f.ts cites A08 §3.1, which does not exist',
    ]);
  });

  test('a cited doc with no readable section is loud, not skipped', () => {
    expect(brokenCitations('A99 §1.1', 'f.ts', byPhase)).toEqual([
      'f.ts cites A99 §1.1, but no numbered section in its doc parses',
    ]);
  });

  test('a phase with no doc is not this guard’s business', () => {
    expect(brokenCitations('Z01 §1.1', 'f.ts', byPhase)).toEqual([]);
  });
});
