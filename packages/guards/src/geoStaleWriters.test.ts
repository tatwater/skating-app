/**
 * **Every write that can change a body's geometry facts marks them** (B01-3b). The facts are derived
 * from a body's outline and box, its neighbors' outlines and the places layer, and stored; a writer
 * that changes one of those without a mark leaves them behind.
 *
 * The marks go through choke points: `syncWaterBodyCells` (every body creation re-cells the body, and
 * a body with no facts row is marked there — nothing else is, since B01-3c), `markGeoStale` (an
 * outline whose stamp moved, a merge, a deletion), and `noteAdminAreasChanged` (the places layer). This lint finds, in the convex sources, every
 * `ctx.db.insert('waterBodies', …)` and every `ctx.db.patch`/`insert`/`replace` whose literal names a
 * `polygon` or `bbox` key, and requires the enclosing top-level function to call the matching choke
 * point. **A patch or replace that names a `polygon` or a `bbox` needs `markGeoStale` in its own
 * block**: the cell index marks only a new body, so a moved outline or box is never marked there, and
 * a mark in a sibling branch (the import's insert) says nothing about the patch. In `adminAreas.ts`, a
 * delete needs the places mark too (a boundary gone moves the layer). Writes to tables that are not
 * inputs (bays, hazards, known features) are listed by the function that makes them.
 *
 * **What it can't see:** a write whose fields arrive through a variable or a spread (`patch(id,
 * fields)`, the import's `shapeFields` interior point), a write in a helper whose caller holds the
 * mark, or a write outside `convex/`. The drift repair (`bodyGeo.repairDrift`,
 * `bodyGeo.repairMissing`) is the net for those.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

const CONVEX = resolve(__dirname, '../../convex/convex');

/**
 * The functions whose outline or box writes are to tables the geometry facts don't read — by
 * function, not file, so a body write that ever lands beside them is still checked.
 */
const NOT_INPUTS: Record<string, string> = {
  'subAreas.ts:insertSubArea': 'a bay outline (`waterBodySubAreas`)',
  'subAreas.ts:rederiveSubArea': 'a bay outline (`waterBodySubAreas`)',
  'hazards.ts:insertHazard': 'a hazard footprint',
  'lib/hazardMerge.ts:refreshMergedFootprint': 'a merged hazard’s footprint',
  'bodyFeatures.ts:insertBodyFeature': 'a known feature on a body',
  'adminAreas.ts:deleteAreaOutline': 'a boundary’s drawn outline (`adminAreaOutlines`, B01-3c)',
};

/** The marks a write of each kind needs in its enclosing function. */
const BODY_MARKS = ['syncWaterBodyCells(', 'markGeoStale('];
const AREA_MARKS = ['noteAdminAreasChanged('];
/** The mark an outline or box patch needs in its own block. */
const OUTLINE_MARK = 'markGeoStale(';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '_generated' ? [] : sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

/** The span of the call opened at `start` (its argument list, balanced parentheses). */
function callSpan(text: string, start: number): string {
  let depth = 0;
  for (let i = text.indexOf('(', start); i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

const DECLARATION = /^(?:export )?(?:const|async function|function) (\w+)/gm;

/** The top-level declaration holding `offset`: its name, and from its column-0 start to the next. */
function enclosing(text: string, offset: number): { name: string; body: string } {
  const starts = [...text.matchAll(DECLARATION)].map((m) => ({ at: m.index ?? 0, name: m[1] }));
  const from = starts.filter((s) => s.at <= offset).pop() ?? { at: 0, name: '' };
  const to = starts.find((s) => s.at > offset)?.at ?? text.length;
  return { name: from.name ?? '', body: text.slice(from.at, to) };
}

/** The innermost `{ … }` block holding `offset` (braces balanced back to the one left open). */
function enclosingBlock(text: string, offset: number): string {
  let depth = 0;
  let start = 0;
  for (let i = offset - 1; i >= 0; i--) {
    if (text[i] === '}') depth++;
    else if (text[i] === '{' && depth-- === 0) {
      start = i;
      break;
    }
  }
  depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

test('every write of a body or an admin area outline is followed by its geometry mark', () => {
  const unmarked: string[] = [];
  const excused = new Set<string>();
  let seen = 0;
  let outlinePatches = 0;
  for (const path of sources(CONVEX)) {
    const file = relative(CONVEX, path);
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(/ctx\.db\.(insert|patch|replace|delete)\(/g)) {
      const at = m.index ?? 0;
      const span = callSpan(text, at);
      const inAreas = file === 'adminAreas.ts';
      if (m[1] === 'delete' && !inAreas) continue;
      const bodyInsert = span.startsWith("ctx.db.insert('waterBodies'");
      const areaWrite = span.startsWith("ctx.db.insert('adminAreas'") || inAreas;
      const namesOutline = /\b(?:polygon|bbox)\s*[:,}]/.test(span);
      if (m[1] !== 'delete' && !bodyInsert && !namesOutline) continue;
      const fn = enclosing(text, at);
      const key = `${file}:${fn.name}`;
      if (key in NOT_INPUTS) {
        excused.add(key);
        continue;
      }
      seen++;
      const line = text.slice(0, at).split('\n').length;
      const marks = areaWrite ? AREA_MARKS : BODY_MARKS;
      if (!marks.some((mark) => fn.body.includes(mark))) {
        unmarked.push(`${file}:${line}`);
        continue;
      }
      const outlinePatch =
        !areaWrite &&
        (m[1] === 'patch' || m[1] === 'replace') &&
        /\b(?:polygon|bbox)\s*[:,}]/.test(span);
      if (outlinePatch) {
        outlinePatches++;
        if (!enclosingBlock(text, at).includes(OUTLINE_MARK)) unmarked.push(`${file}:${line}`);
      }
    }
  }
  // The lint saw the writers it exists for (the import's insert and patch, the drawn body, the
  // admit, the admin-area upsert and deletes) — a regex that stopped matching would pass vacuously.
  expect(seen).toBeGreaterThanOrEqual(9);
  expect(outlinePatches).toBeGreaterThanOrEqual(1);
  // Every excusal still names a function that writes an outline; a stale one is a hole.
  expect([...excused].sort()).toEqual(Object.keys(NOT_INPUTS).sort());
  expect(unmarked).toEqual([]);
});
