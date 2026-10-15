/**
 * `lib/audit.ts` is the only writer of the audit log (D226, B01 §11). One writer is what lets every
 * row carry the same shape — and, for an undo, the row it undoes — so a direct insert elsewhere is
 * the regression this catches.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

const CONVEX = resolve(__dirname, '../../convex/convex');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '_generated' ? [] : sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

test('only lib/audit.ts inserts into moderationActions', () => {
  const writers = sources(CONVEX)
    .filter((p) => readFileSync(p, 'utf8').includes("insert('moderationActions'"))
    .map((p) => relative(CONVEX, p));
  expect(writers).toEqual([join('lib', 'audit.ts')]);
});
