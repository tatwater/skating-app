/**
 * A phase doc's `### N.M` sections are unique and in order.
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

/** Every `### N.M` heading of a phase doc, in the order it appears. */
function sectionNumbers(body: string): string[] {
  return [...body.matchAll(/^#{2,4}\s+(\d+\.\d+)\s+\S/gm)].map((m) => m[1] as string);
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

  test('numbers only ever go up', () => {
    const value = (n: string) => {
      const [major, minor] = n.split('.').map(Number) as [number, number];
      return major * 1000 + minor;
    };
    for (const doc of phaseDocs) {
      const numbers = sectionNumbers(doc.body);
      const backwards = numbers.filter(
        (n, i) => i > 0 && value(n) <= value(numbers[i - 1] as string),
      );
      expect(backwards, `${doc.name} goes backwards at these sections`).toEqual([]);
    }
  });
});

describe('a §N.M pointer in the code', () => {
  /** `B03 §8.5`, `A06c §3.2` — a phase token and a section, as the code comments write them. */
  const CITATION = /\b([A-Z]\d{2}[a-z]?)\s+§(\d+\.\d+)/g;

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
    const broken: string[] = [];
    for (const path of sources) {
      const body = readFileSync(path, 'utf8');
      for (const [, phase, section] of body.matchAll(CITATION)) {
        const sections = byPhase.get(phase as string);
        // A phase with no doc here is not this test's business.
        if (!sections || sections.size === 0) continue;
        if (!sections.has(section as string)) {
          broken.push(`${relative(REPO, path)} cites ${phase} §${section}, which does not exist`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
