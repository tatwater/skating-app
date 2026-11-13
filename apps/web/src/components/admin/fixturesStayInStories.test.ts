import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * **No fixture reaches the console.** The Overview's blocks are props-driven and drawn from board
 * fixtures in their stories; the page the app mounts must draw only what a read returned, and say
 * *Not recorded yet* where none does. A fixture imported into the app would put a board's made-up
 * numbers in front of an operator as if they were measured.
 *
 * So: a module anywhere in the app that imports one of `components/admin`'s fixture modules must be
 * a test or a story — or story support (a board frame) that only tests and stories import in turn. This reads the
 * package's own files, so Turbo's hash of the package covers it.
 */

const ADMIN = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(ADMIN, '../..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Every module in the app, so an importer anywhere (a route, a lib) is seen. */
const files = walk(SRC);
const isTestOrStory = (file: string) => /\.(test|stories)\.tsx?$/.test(file);
const isFixture = (file: string) => /[Ff]ixtures?(\.[a-z]+)?\.tsx?$/.test(file);

/** The local modules `file` imports, resolved to paths (extension-less, as written). */
function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/from\s+'([^']+)'/g)]
    .map((m) => m[1] as string)
    .flatMap((spec) => {
      if (spec.startsWith('@/')) return [resolve(SRC, spec.slice(2))];
      if (spec.startsWith('.')) return [resolve(dirname(file), spec)];
      return [];
    });
}

const stem = (file: string) => file.replace(/\.tsx?$/, '');
const importers = (target: string) =>
  files.filter((f) => importsOf(f).some((spec) => spec === stem(target)));

describe('the console’s fixtures', () => {
  const fixtures = files.filter((f) => f.startsWith(ADMIN) && isFixture(f));

  it('finds the fixture modules (the guard is not vacuous)', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
  });

  it('are imported only by tests, stories and story-only support', () => {
    const leaks: string[] = [];
    for (const fixture of fixtures) {
      for (const user of importers(fixture)) {
        if (isTestOrStory(user) || isFixture(user)) continue;
        // Story support: allowed only while nothing but tests and stories import it.
        const outside = importers(user).filter((u) => !isTestOrStory(u));
        const unused = importers(user).length === 0;
        if (outside.length > 0 || unused) {
          leaks.push(`${relative(SRC, user)} imports ${relative(SRC, fixture)}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });
});
