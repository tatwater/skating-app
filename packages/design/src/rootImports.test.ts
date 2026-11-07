import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The package root (`@skating/design`) must not reach the token system. `src/tokens/` loads culori
 * and solves all four theme maps' colors at module scope, so a root re-export would put that
 * work into the startup of every root importer — mobile's Tamagui config among them — before
 * either app has adopted the new tokens. The tokens live behind `@skating/design/tokens`.
 *
 * Walks the static import graph from `src/index.ts` (relative specifiers resolved to files; bare
 * ones recorded as packages) and checks what it reaches.
 */

const srcDir = dirname(fileURLToPath(import.meta.url));
const tokensDir = join(srcDir, 'tokens');

const SPECIFIER = /(?:^|\n)\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g;

function resolveRelative(fromFile: string, spec: string): string {
  const base = join(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
  }
  throw new Error(`Unresolved import ${spec} from ${relative(srcDir, fromFile)}`);
}

function walk(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      if (spec === undefined) continue;
      if (spec.startsWith('.')) queue.push(resolveRelative(file, spec));
      else packages.add(spec);
    }
  }
  return { files, packages };
}

describe('the package root', () => {
  const root = walk(join(srcDir, 'index.ts'));

  it('reaches no token-system module', () => {
    const inTokens = [...root.files].filter((f) => f.startsWith(`${tokensDir}/`));
    expect(inTokens.map((f) => relative(srcDir, f))).toEqual([]);
  });

  it('loads no color-conversion library', () => {
    expect([...root.packages]).not.toContain('culori');
  });

  it('still reaches the modules it exports (the walk sees the graph)', () => {
    const reached = [...root.files].map((f) => relative(srcDir, f));
    expect(reached).toEqual(expect.arrayContaining(['index.ts', 'themes.ts', 'contrast.ts']));
  });
});

describe('the tokens entry point', () => {
  it('is the token system, culori included', () => {
    const tokens = walk(join(tokensDir, 'index.ts'));
    expect([...tokens.files].map((f) => relative(srcDir, f))).toContain('tokens/maps.ts');
    expect([...tokens.packages]).toContain('culori');
  });

  it('is published as its own subpath', () => {
    const pkg = JSON.parse(readFileSync(join(srcDir, '..', 'package.json'), 'utf8')) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports['./tokens']).toBe('./src/tokens/index.ts');
  });
});
