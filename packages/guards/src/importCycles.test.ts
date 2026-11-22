/**
 * **No module joins an import cycle** (B01-5c). The undo engine sits above the writes it undoes: its
 * handlers import `waterBodies.ts`, `accessAlerts.ts` and the rest, so a write module that imports
 * the engine back — directly or through a helper — closes a cycle that `tsc` accepts and the bundle
 * may not (a `const` read before its module has run). B01-5c's decision answers did exactly that
 * once (`waterBodies.ts` → `lib/decisionResult.ts` → `moderation.ts` → `lib/undo.ts` → … →
 * `waterBodies.ts`); they now ask the engine through `ctx.runQuery`, a function reference.
 *
 * Held here over the runtime import graph of `packages/convex/convex` (type-only imports erased, as
 * the bundler erases them): the modules that sit in a cycle today are named below, and the test
 * fails when any other module joins one — or when one of them leaves, so the list only shrinks.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

const CONVEX = resolve(__dirname, '../../convex/convex');

/** Every module in a cycle today, by its path under `convex/` — each an existing, older cycle. */
const KNOWN_CYCLES: readonly (readonly string[])[] = [
  // `inbox.ts` ↔ `lib/inboxViews.ts` left with the map's bounds (`lib/inboxMapBounds.ts`, B01-5c).
  ['lib/inboxItems.ts', 'lib/requestDecisions.ts'],
  ['lib/undo.ts', 'lib/undoHandlers.ts', 'lib/undoHandlersCorpus.ts'],
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === '_generated' || name === 'node_modules') continue;
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts') && !name.includes('.test.') && !name.endsWith('.d.ts'))
      out.push(path);
  }
  return out;
}

/** The source with comments blanked, so an import in a comment is not one. */
const uncommented = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ');

/** Relative module specifiers this source imports or re-exports at runtime. */
function runtimeImports(source: string): string[] {
  const out: string[] = [];
  const stmt = /^\s*(import|export)\s+([\s\S]*?)\s+from\s+'(\.[^']+)'/gm;
  for (const m of uncommented(source).matchAll(stmt)) {
    const clause = (m[2] ?? '').trim();
    if (clause.startsWith('type ')) continue;
    // `import { type A, type B } from` is erased whole; one value specifier keeps it.
    const braces = clause.match(/^\{([\s\S]*)\}$/);
    if (braces) {
      const names = (braces[1] ?? '')
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith('type '))) continue;
    }
    out.push(m[3] as string);
  }
  // A bare side-effect import (`import './x'`) runs the module too.
  for (const m of uncommented(source).matchAll(/^\s*import\s+'(\.[^']+)'/gm))
    out.push(m[1] as string);
  return out;
}

function graph(): Map<string, string[]> {
  const files = sources(CONVEX);
  const known = new Set(files);
  const g = new Map<string, string[]>();
  for (const f of files) {
    const deps: string[] = [];
    for (const spec of runtimeImports(readFileSync(f, 'utf8'))) {
      const base = normalize(join(dirname(f), spec));
      const hit = [`${base}.ts`, join(base, 'index.ts')].find((c) => known.has(c));
      if (hit) deps.push(hit);
    }
    g.set(f, deps);
  }
  return g;
}

/** Strongly connected components of more than one module (Tarjan). */
function cycles(g: Map<string, string[]>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    on.add(v);
    for (const w of g.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v) as number, idx.get(w) as number));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      for (;;) {
        const w = stack.pop() as string;
        on.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      if (comp.length > 1) out.push(comp.map((c) => relative(CONVEX, c)).sort());
    }
  };
  for (const v of g.keys()) if (!idx.has(v)) visit(v);
  return out.sort((a, b) => (a[0] as string).localeCompare(b[0] as string));
}

test('no module joins an import cycle; the known ones only shrink', () => {
  expect(cycles(graph())).toEqual(KNOWN_CYCLES);
});

test('the writes the undo engine imports never import it back', () => {
  const g = graph();
  const undo = join(CONVEX, 'lib/undo.ts');
  const reaches = (from: string) => {
    const seen = new Set<string>();
    const todo = [join(CONVEX, from)];
    while (todo.length > 0) {
      const x = todo.pop() as string;
      if (x === undo) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      todo.push(...(g.get(x) ?? []));
    }
    return false;
  };
  expect(['waterBodies.ts', 'corpusRequests.ts', 'accessAlerts.ts'].filter(reaches)).toEqual([]);
});
