/**
 * The guard over the guards.
 *
 * Every other test in this package reads the repo off disk — `plans/`, `docs/`, each `src` tree
 * under `apps/` and `scripts/`, `packages/convex/convex`, every `.env.example`, and in
 * `planConventions` the output of `git ls-files`. Turbo hashes a package's own files plus its
 * dependencies', so none of that is in the hash of the task that runs them. `@skating/core`
 * does not depend on `@skating/web`, so for as long as these lived in core, editing
 * `apps/web/**` or `plans/**` could not invalidate them.
 *
 * That is not theoretical. On PR #91 a local `pnpm test` reported "167 passed, Tasks: 15
 * successful" entirely from cache while CI, cold, failed `credentialsRegister` on the same commit.
 * The cache even crosses worktrees: it lives in the main checkout's `.turbo/cache`, keyed off the
 * git common dir, so one poisoned entry is replayed to every worktree on the machine.
 *
 * The fix is that this package's `test` task is uncached, so it always runs (D236). This file
 * holds that fix in place, and because it is itself in the uncached task it can never be served a
 * stale pass of itself:
 *
 * 1. `packages/guards/turbo.json` still declares `test` with `cache: false`;
 * 2. no test file in a *cached* package reads above its own package root — which is how a new
 *    repo-wide guard would quietly reacquire the original bug.
 *
 * Check 2 recognizes a relative path that climbs out of the package, in either spelling: one
 * literal (`resolve(__dirname, '../../..')`, the shape all four guards use) or one argument per
 * level (`join(dir, '..', '..', '..')`, the shape the repo's other filesystem-reading tests use).
 * It is a lint, not a proof: a test that escaped via `process.cwd()`, an absolute path, a template
 * literal or a double-quoted string would pass it. It is here to catch the honest mistake —
 * someone adding the fifth guard next to the code it checks — not a determined one. Both checks
 * carry floors against the one way a lint fails worst: passing without having looked at anything.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO = resolve(__dirname, '../../..');
const GUARDS = 'packages/guards';

/** Every extension vitest's default `include` runs, so a guard added as a `.spec.ts` can't hide. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

/**
 * One climb, however it is spelled: a single literal (`'../../..'`), or a run of bare `'..'`
 * arguments (`'..', '..', '..'`) optionally ending in one that carries a tail. The run form is not
 * hypothetical — it is the idiom every other filesystem-reading test in this repo already uses
 * (both apps' `src/lib/contourMap.test.ts`, `scripts/bathymetry/src/tile.test.ts`), so counting
 * levels one literal at a time would miss the exact mistake this lint is here to catch. Chaining
 * only *bare* `'..'` arguments is what keeps an array of sibling paths (`['../a', '../b']`) from
 * reading as a two-level climb.
 */
const CLIMB = /'\.\.'(?:\s*,\s*'\.\.')*(?:\s*,\s*'\.\.\/[^'\n]*')?|'\.\.\/[^'\n]*'/gu;
const LITERAL = /'(\.\.(?:\/[^'\n]*)?)'/gu;

/** How many levels a matched climb rises: `..` segments, summed across the run's literals. */
function levelsClimbed(climb: string): number {
  let levels = 0;
  for (const [, literal] of climb.matchAll(LITERAL)) {
    const segments = (literal as string).split('/');
    const stops = segments.findIndex((segment) => segment !== '..');
    levels += stops === -1 ? segments.length : stops;
  }
  return levels;
}

describe('the repo-wide guards cannot be served from cache', () => {
  test("this package's test task declares cache: false", () => {
    const raw = readFileSync(resolve(REPO, GUARDS, 'turbo.json'), 'utf8');
    // The file is JSONC — turbo.json carries comments, and ours carries the reasoning. A comment
    // may also trail a value, so match `//` after whitespace rather than only at line start; the
    // whitespace is what keeps the `https://` in `$schema` from being eaten.
    const config = JSON.parse(raw.replace(/(^|\s)\/\/[^\n]*/g, '$1')) as {
      tasks?: Record<string, { cache?: boolean }>;
    };
    expect(
      config.tasks?.test?.cache,
      `${GUARDS}/turbo.json must keep "test": { "cache": false } — these tests read the whole ` +
        'repo, which Turbo cannot hash, so a cached pass is not a pass (D236)',
    ).toBe(false);
  });

  test('no test in a cached package reads above its own package root', () => {
    // Workspace roots, longest first, so `packages/guards` wins over any prefix of it.
    const roots = (
      JSON.parse(execSync('pnpm -r list --depth -1 --json', { cwd: REPO, encoding: 'utf8' })) as {
        path: string;
      }[]
    )
      .map((p) => relative(REPO, p.path))
      .filter((p) => p !== '')
      .sort((a, b) => b.length - a.length);

    // `existsSync`, because `git ls-files` reads the *index*: a test deleted or renamed in the
    // working tree is still listed until the deletion is staged, and `readFileSync` below would
    // throw ENOENT. That turned a routine `rm` followed by `pnpm test` into a failure of the
    // guard rather than of anything real. Filtered here rather than inside the loop so the floor
    // below counts the files that will actually be read.
    const tests = execSync('git ls-files', { cwd: REPO, encoding: 'utf8' })
      .split('\n')
      .filter((f) => TEST_FILE.test(f))
      .filter((f) => existsSync(resolve(REPO, f)));

    // Floors on both lists, because the failure this package exists to prevent is a green that
    // verified nothing: if `pnpm -r list` changes shape, or its paths stop matching `REPO` (a
    // symlinked checkout), every file below is skipped and the loop passes vacuously.
    expect(
      roots.length,
      'no workspace roots — `pnpm -r list` returned nothing usable',
    ).toBeGreaterThan(10);
    expect(tests.length, 'no test files — `git ls-files` returned nothing usable').toBeGreaterThan(
      100,
    );

    const escapes: string[] = [];
    let examined = 0;
    for (const file of tests) {
      const root = roots.find((r) => file.startsWith(`${r}/`));
      // A test outside every workspace has no package root to stay inside of.
      if (root === undefined || root === GUARDS) continue;
      examined++;
      // How far the file's own directory sits below its package root — that is how many levels a
      // relative path may climb before it leaves the package.
      const fromRoot = relative(root, dirname(file));
      const headroom = fromRoot === '' ? 0 : fromRoot.split(sep).length;
      const text = readFileSync(resolve(REPO, file), 'utf8');
      for (const [climb] of text.matchAll(CLIMB)) {
        if (levelsClimbed(climb) > headroom) escapes.push(`${file}  →  ${climb}`);
      }
    }

    expect(
      examined,
      'no test file matched a workspace root — see the floors above',
    ).toBeGreaterThan(100);
    expect(
      escapes,
      `a test that reads outside its own package cannot be hashed by Turbo and will be served ` +
        `stale. Move it to ${GUARDS}, whose task is uncached (D236)`,
    ).toEqual([]);
  });

  test('the lint recognizes a climb however it is spelled, and leaves in-package paths alone', () => {
    // Headroom 1 is `packages/<pkg>/src/<name>.test.ts` — where a fifth guard would land.
    const flagged = (source: string) =>
      [...source.matchAll(CLIMB)].some((m) => levelsClimbed(m[0] as string) > 1);

    for (const climbsOut of [
      "const REPO = resolve(__dirname, '../../..');", // the shape all four guards use
      "const REPO = resolve(__dirname, '..', '..', '..');", // the same climb, one arg per level
      "readFileSync(join(import.meta.dirname, '..', '..', '..', 'plans', '05.md'));",
      "readFileSync(new URL('../../../plans/06-data-model.md', import.meta.url));",
      "const PLANS = resolve(__dirname, '..', '../../plans');", // a run with a tail
    ]) {
      expect(flagged(climbsOut), climbsOut).toBe(true);
    }

    for (const stays of [
      "readFileSync(join(import.meta.dirname, '..', 'components', 'MapView.tsx'));",
      "readFileSync(new URL('../fixtures/vermont-sample.geojsonseq', import.meta.url));",
      "const fixtures = ['../a.json', '../b.json'];", // siblings, not a two-level climb
      "import { summarize } from '../summarize';",
    ]) {
      expect(flagged(stays), stays).toBe(false);
    }
  });
});
