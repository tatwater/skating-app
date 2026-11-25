/**
 * **A placeholder is the third ink, everywhere.** A field's example text is set in `fg3` (and
 * `fg-disabled` on a disabled field), the kit's placeholder tone — never the secondary ink that
 * captions and dialog descriptions use. The shadcn primitives under `components/ui` once set their
 * placeholders in `muted-foreground`, the same color as the description over the field, so an empty
 * *Ask for this lake back* note read as already filled in.
 *
 * A lint over the source text, not a proof: `kit/input.stories.tsx` measures `fg3` on a field
 * against AA.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const WEB = resolve(__dirname, '../../../apps/web/src');

/** The tones a placeholder may take. */
const ALLOWED = new Set(['fg3', 'fg-disabled']);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(e.name) ? [path] : [];
  });
}

test('every placeholder utility in the web app sets the placeholder tone', () => {
  const found: string[] = [];
  const wrong: string[] = [];
  for (const file of sources(WEB)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/placeholder:text-([A-Za-z0-9_-]+)/g)) {
      const where = `${file.slice(WEB.length + 1)}: text-${m[1]}`;
      found.push(where);
      if (!ALLOWED.has(m[1] ?? '')) wrong.push(where);
    }
  }
  // The scan sees the fields it is about (the kit's and the shadcn primitives').
  expect(found.some((f) => f.startsWith('components/ui/textarea.tsx'))).toBe(true);
  expect(found.some((f) => f.startsWith('components/kit/input.tsx'))).toBe(true);
  expect(wrong).toEqual([]);
});
