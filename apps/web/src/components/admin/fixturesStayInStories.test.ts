import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * **No fixture reaches the console.** The Overview's blocks are props-driven and drawn from board
 * fixtures in their stories; the page the app mounts must draw only what a read returned, and say
 * *Not recorded yet* where none does. A fixture imported into the app would put a board's made-up
 * numbers in front of an operator as if they were measured.
 *
 * The rule, followed transitively: a module that imports one of `components/admin`'s fixtures —
 * directly, or through any chain of other modules, fixture-named or not — is *tainted*. Tests and
 * stories may import tainted modules (they end a chain). A tainted route file, top-level entry or
 * module nothing imports is a leak: the chain reached a root of the app rather than ending in a
 * story. So story support (a board frame) is fine exactly while only stories reach it.
 *
 * This reads the package's own files, so Turbo's hash of the package covers it.
 */

type Graph = ReadonlyMap<string, readonly string[]>;

const isTestOrStory = (file: string) => /\.(test|stories)\.tsx?$/.test(file);
const isFixture = (file: string) => /[Ff]ixtures?(\.[a-z]+)?\.tsx?$/.test(file);

/** A route file: the router mounts it, so it is a root of the app whoever imports it. */
const isRouteFile = (file: string) => /(^|\/)routes\/[^/]+\.tsx?$/.test(file);

/**
 * Every leak in `graph` (module → the modules it imports): a chain from one of `seeds` up through
 * its importers to a root of the app — an entry (`isEntry`; route files always) or a module
 * nothing imports — without passing through a test or a story. Each leak is written as the
 * chain, root first. (The router and its generated tree import each other, so "nothing imports
 * it" alone would never find the top.)
 */
function fixtureLeaks(
  graph: Graph,
  seeds: readonly string[],
  isEntry: (file: string) => boolean = isRouteFile,
): string[][] {
  const importers = new Map<string, string[]>();
  for (const [file, imports] of graph) {
    for (const spec of imports) importers.set(spec, [...(importers.get(spec) ?? []), file]);
  }
  // Breadth-first up the importers: `via` is the module each tainted one was reached from.
  const via = new Map<string, string | null>(seeds.map((s) => [s, null]));
  const queue = [...seeds];
  while (queue.length > 0) {
    const at = queue.shift() as string;
    for (const user of importers.get(at) ?? []) {
      if (isTestOrStory(user) || via.has(user)) continue;
      via.set(user, at);
      queue.push(user);
    }
  }
  const leaks: string[][] = [];
  for (const [file, from] of via) {
    // An unused fixture is no leak; a module that reaches it and is reached by nothing is.
    if (from === null) continue;
    if (!isEntry(file) && (importers.get(file) ?? []).length > 0) continue;
    const chain: string[] = [];
    for (let at: string | null = file; at !== null; at = via.get(at) ?? null) chain.push(at);
    leaks.push(chain);
  }
  return leaks;
}

// ── The app's own import graph ───────────────────────────────────────────────────────────────

const ADMIN = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(ADMIN, '../..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** A local import's file, with its extension or index found; `undefined` for a package. */
function resolveSpec(from: string, spec: string): string | undefined {
  const base = spec.startsWith('@/')
    ? resolve(SRC, spec.slice(2))
    : spec.startsWith('.')
      ? resolve(dirname(from), spec)
      : undefined;
  if (base === undefined) return undefined;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/** Static imports, re-exports, side-effect imports and dynamic `import()`. */
const IMPORT = /(?:from\s+|import\s+|import\s*\(\s*)'([^']+)'/g;

function appGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf8');
    const imports = [...source.matchAll(IMPORT)]
      .map((m) => resolveSpec(file, m[1] as string))
      .filter((f): f is string => f !== undefined);
    graph.set(file, [...new Set(imports)]);
  }
  return graph;
}

const graph = appGraph();
const fixtures = [...graph.keys()].filter((f) => f.startsWith(ADMIN) && isFixture(f));
/** The app's entries: the route files and every module at the top of `src` (router, client…). */
const isAppEntry = (file: string) => isRouteFile(file) || dirname(file) === SRC;
const named = (chains: string[][]) => chains.map((c) => c.map((f) => relative(SRC, f)).join(' ← '));

describe('the console’s fixtures', () => {
  it('finds the fixture modules and the app’s roots (the guard is not vacuous)', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
    expect(graph.get(resolve(SRC, 'router.tsx'))).toContain(resolve(SRC, 'routeTree.gen.ts'));
  });

  it('reach no root of the app — only tests, stories and story-only support', () => {
    expect(named(fixtureLeaks(graph, fixtures, isAppEntry))).toEqual([]);
  });

  it('would catch a leak planted in the real graph, directly and through a fixture-named step', () => {
    const fixture = fixtures[0] as string;
    const route = resolve(SRC, 'routes/admin.index.tsx');
    const runtime = resolve(ADMIN, 'overview/planted.ts');
    const relay = resolve(ADMIN, 'overview/plantedFixtures.ts');
    const plant = (edges: Array<[string, string]>) => {
      const planted = new Map(graph);
      for (const [from, to] of edges) planted.set(from, [...(planted.get(from) ?? []), to]);
      return fixtureLeaks(planted, fixtures, isAppEntry);
    };
    expect(plant([[route, fixture]]).length).toBeGreaterThan(0);
    expect(
      plant([
        [relay, fixture],
        [runtime, relay],
        [route, runtime],
      ]).length,
    ).toBeGreaterThan(0);
  });
});

describe('fixtureLeaks', () => {
  const seed = 'admin/overview/overviewFixtures.ts';

  it('allows story support that only stories reach', () => {
    const g = new Map([
      [seed, []],
      ['admin/overview/overviewBoard.tsx', [seed]],
      ['admin/overview/Home.stories.tsx', ['admin/overview/overviewBoard.tsx']],
      ['admin/overview/Home.test.tsx', [seed]],
    ]);
    expect(fixtureLeaks(g, [seed])).toEqual([]);
  });

  it('catches a runtime module that imports a fixture', () => {
    const g = new Map([
      [seed, []],
      ['routes/admin.index.tsx', ['admin/overview/OverviewRoute.tsx']],
      ['admin/overview/OverviewRoute.tsx', [seed]],
    ]);
    expect(fixtureLeaks(g, [seed])).toEqual([
      ['routes/admin.index.tsx', 'admin/overview/OverviewRoute.tsx', seed],
    ]);
  });

  // The guard this replaced skipped any importer whose own name looked like a fixture, so this
  // two-step chain passed it.
  it('follows a chain through a second fixture-named module', () => {
    const g = new Map([
      [seed, []],
      ['admin/overview/moreFixtures.ts', [seed]],
      ['admin/overview/OverviewRoute.tsx', ['admin/overview/moreFixtures.ts']],
      ['routes/admin.index.tsx', ['admin/overview/OverviewRoute.tsx']],
    ]);
    expect(fixtureLeaks(g, [seed])).toEqual([
      [
        'routes/admin.index.tsx',
        'admin/overview/OverviewRoute.tsx',
        'admin/overview/moreFixtures.ts',
        seed,
      ],
    ]);
  });

  it('counts story support a runtime module also imports as a leak', () => {
    const g = new Map([
      [seed, []],
      ['admin/overview/overviewBoard.tsx', [seed]],
      ['admin/overview/Home.stories.tsx', ['admin/overview/overviewBoard.tsx']],
      ['admin/overview/OverviewRoute.tsx', ['admin/overview/overviewBoard.tsx']],
    ]);
    expect(fixtureLeaks(g, [seed])).toHaveLength(1);
  });

  it('counts an unused module that imports a fixture as a leak, as the old guard did', () => {
    const g = new Map([
      [seed, []],
      ['admin/overview/orphan.ts', [seed]],
    ]);
    expect(fixtureLeaks(g, [seed])).toEqual([['admin/overview/orphan.ts', seed]]);
  });
});
