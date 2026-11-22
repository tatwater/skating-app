/**
 * **The web unit tests' split by environment stays honest** (the CI saving, 2026-11-22). Every
 * `*.test.tsx` runs under jsdom (`unit`); a `*.test.ts` runs under Node (`unit-node`) unless it is
 * listed in `apps/web/src/test/domTests.ts`. A `.test.ts` outside that list that names the DOM —
 * `window`, `document`, storage, IndexedDB, `navigator`, an animation frame, a media query,
 * computed style, `HTMLElement`, Testing Library — fails here, naming the file to list. One that
 * reaches the DOM only through an import fails loudly under Node itself (`document is not defined`).
 *
 * A lint over the source text, comments stripped (a comment that mentions jsdom is no DOM use).
 * Lives in `@skating/guards`: it reads another package's files, which no Turbo input glob of the
 * web package's own test task would hash for this check (D236).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

const WEB = resolve(__dirname, '../../../apps/web');
const LIST = join(WEB, 'src/test/domTests.ts');

/** A direct use of the DOM, or of the library that renders into it. */
const DOM_USE =
  /\bdocument\.|\bwindow\.|@testing-library|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bnavigator\.|\brequestAnimationFrame\b|\bmatchMedia\b|\bgetComputedStyle\b|\bHTMLElement\b/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === 'node_modules' || name === 'coverage') return [];
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** The source without its comments (a `//` after a colon or a quote — a URL — is kept). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

const listed = (): string[] =>
  [...readFileSync(LIST, 'utf8').matchAll(/^\s*'([^']+\.test\.ts)',$/gm)].map(
    (m) => m[1] as string,
  );

const logicTests = (): string[] =>
  walk(join(WEB, 'src'))
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => relative(WEB, f));

test('a .test.ts that names the DOM is listed to run under jsdom', () => {
  const dom = new Set(listed());
  const unlisted = logicTests().filter(
    (f) => !dom.has(f) && DOM_USE.test(code(readFileSync(join(WEB, f), 'utf8'))),
  );
  expect(unlisted, 'add each to apps/web/src/test/domTests.ts').toEqual([]);
});

test('the list names files that are still there, each once', () => {
  const all = new Set(logicTests());
  const names = listed();
  // A floor: the list parsed (a pattern that matched nothing would pass anything).
  expect(names.length).toBeGreaterThan(10);
  expect(names.filter((f) => !all.has(f))).toEqual([]);
  expect(new Set(names).size).toBe(names.length);
});
