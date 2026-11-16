/**
 * **A body's towns are one entry per boundary, built in one place each** (B01-3l). The facts' town
 * entries (`townEntries`) and a moderator's pinned towns (`pinnedTowns`) are keyed by boundary and
 * carry a town's kind when its state has two of its name — a derived fact the label (`townLabel`)
 * reads. They are built only by `placesFrom` (the computed half, stored by `store`) and
 * `pinnedFactsFor` (the pinned half); everything else reads them. This lint finds every function in
 * the convex sources that names either field and holds the list to the inventory below, so a new
 * writer — or a new reader keying them some other way — is read and listed.
 *
 * A lint over the source text, not a proof (`townKeys.test.ts` is the property).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

const CONVEX = resolve(__dirname, '../../convex/convex');

/** Every function that names the fields, and what it does with them. */
const INVENTORY: Record<string, string> = {
  'bodyGeo.ts:placesFrom:townEntries': 'builds the computed entries, one per boundary, with kinds',
  'bodyGeo.ts:store:townEntries': 'stores what placesFrom built',
  'lib/bodyGeo.ts:pinnedFactsFor:pinnedTowns': 'builds the pinned half, with kinds',
  'lib/bodyGeo.ts:withPinnedTowns:pinnedTowns': 'reads: merges the pinned half in, by boundary',
  'lib/bodyGeo.ts:withPinnedTowns:townEntries': 'reads: merges the pinned half in, by boundary',
  'lib/bodyGeo.ts:hasTownEntries:townEntries': 'reads: whether the facts carry entries',
  'lib/bodyGeo.ts:townRowsOf:townEntries': 'reads: each entry named by townName',
  'lib/bodyGeo.ts:townNamesOf:townEntries': 'reads: the names list, from townRowsOf',
  'lib/bodyGeo.ts:townsWithStateOf:townEntries': 'reads: from townRowsOf',
  'bodyConsole.ts:places:pinnedTowns': 'reads: each pin named by townName',
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '_generated' ? [] : sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && e.name !== 'schema.ts'
      ? [p]
      : [];
  });
}

const DECLARATION = /^(?:export )?(?:const|async function|function|type|interface) (\w+)/gm;

test('the town entries and pinned towns are built in their two places, and read only by the inventory', () => {
  const found = new Set<string>();
  for (const path of sources(CONVEX)) {
    const file = relative(CONVEX, path);
    const text = readFileSync(path, 'utf8');
    const starts = [...text.matchAll(DECLARATION)].map((m) => ({ at: m.index ?? 0, name: m[1] }));
    for (const m of text.matchAll(/\b(townEntries|pinnedTowns)\b/g)) {
      const fn = starts.filter((s) => s.at <= (m.index ?? 0)).pop()?.name ?? '';
      found.add(`${file}:${fn}:${m[1]}`);
    }
  }
  expect([...found].sort()).toEqual(Object.keys(INVENTORY).sort());
  // The two builders key by boundary.
  const geo = readFileSync(join(CONVEX, 'bodyGeo.ts'), 'utf8');
  expect(geo).toContain('townEntries.some((e) => e.id === area.id)');
  const lib = readFileSync(join(CONVEX, 'lib/bodyGeo.ts'), 'utf8');
  expect(lib).toContain('townEntries.some((e) => e.id === p.id)');
});
