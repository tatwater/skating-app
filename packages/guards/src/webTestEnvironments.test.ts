/**
 * **The web unit tests' split by environment stays honest** (the CI saving, 2026-11-22). Every
 * JSX test runs under jsdom (`unit`); any other test file runs under Node (`unit-node`) unless it is
 * listed in `apps/web/src/test/domTests.json`. One outside that list that names the DOM —
 * `window`, `document`, storage, IndexedDB, `navigator`, an animation frame, a media query,
 * computed style, `HTMLElement`, Testing Library — fails here, naming the file to list. One that
 * reaches the DOM only through an import fails loudly under Node itself (`document is not defined`).
 *
 * A lint over the source text, comments stripped (a comment that mentions jsdom is no DOM use).
 * Lives in `@skating/guards`: it reads another package's files, which no Turbo input glob of the
 * web package's own test task would hash for this check (D236).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, matchesGlob, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

const WEB = resolve(__dirname, '../../../apps/web');
const LIST = join(WEB, 'src/test/domTests.json');
const CONFIG = join(WEB, 'vitest.config.ts');

/** What Vitest's default include matched: a test or spec file of any JS/TS flavor, anywhere. */
const DEFAULT_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
/** Directories no test lives in (Vitest's default exclude, and build output). */
const SKIP = new Set([
  'node_modules',
  'coverage',
  'dist',
  '.output',
  '.vercel',
  'storybook-static',
]);

/** A direct use of the DOM, or of the library that renders into it. */
const DOM_USE =
  /\bdocument\.|\bwindow\.|@testing-library|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bnavigator\.|\brequestAnimationFrame\b|\bmatchMedia\b|\bgetComputedStyle\b|\bHTMLElement\b/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (SKIP.has(name)) return [];
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** The source without its comments (a `//` after a colon or a quote — a URL — is kept). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

const listed = (): string[] => JSON.parse(readFileSync(LIST, 'utf8')) as string[];

/** Every test file the default would run, relative to the web package. */
const allTests = (): string[] =>
  walk(WEB)
    .map((f) => relative(WEB, f))
    .filter((f) => DEFAULT_TEST.test(f));

const logicTests = (): string[] => allTests().filter((f) => !/x$/.test(f));

/** A project's `include` patterns in the config, by the constant each names. */
function includeOf(name: 'JSX_TESTS' | 'LOGIC_TESTS'): string {
  const m = new RegExp(`const ${name} = '([^']+)'`).exec(readFileSync(CONFIG, 'utf8'));
  if (m === null) throw new Error(`vitest.config.ts names no ${name}`);
  return m[1] as string;
}

test('a .test.ts that names the DOM is listed to run under jsdom', () => {
  const dom = new Set(listed());
  const unlisted = logicTests().filter(
    (f) => !dom.has(f) && DOM_USE.test(code(readFileSync(join(WEB, f), 'utf8'))),
  );
  expect(unlisted, 'add each to apps/web/src/test/domTests.json').toEqual([]);
});

test('the list names files that are still there, each once', () => {
  const all = new Set(logicTests());
  const names = listed();
  // A floor: the list parsed (a pattern that matched nothing would pass anything).
  expect(names.length).toBeGreaterThan(10);
  expect(names.filter((f) => !all.has(f))).toEqual([]);
  expect(new Set(names).size).toBe(names.length);
});

test('every test file the default ran is in exactly one unit project — a .spec or one outside src too', () => {
  const jsx = includeOf('JSX_TESTS');
  const logic = includeOf('LOGIC_TESTS');
  const dom = new Set(listed());
  // The project a file runs in: JSX ones and the listed DOM ones under jsdom, the rest under Node.
  const projects = (f: string) =>
    [
      matchesGlob(f, jsx) || dom.has(f) ? 'unit' : null,
      matchesGlob(f, logic) && !dom.has(f) ? 'unit-node' : null,
    ].filter((p) => p !== null);
  // The shapes the default matched, wherever they live.
  for (const f of [
    'src/a/b.test.ts',
    'src/a/b.spec.ts',
    'scripts/c.test.mts',
    'e2e/d.spec.js',
    'src/e.test.tsx',
    'src/f.spec.jsx',
  ]) {
    expect(projects(f), f).toHaveLength(1);
  }
  // And every one on disk.
  const tests = allTests();
  expect(tests.length).toBeGreaterThan(400);
  expect(tests.filter((f) => projects(f).length !== 1)).toEqual([]);
});
