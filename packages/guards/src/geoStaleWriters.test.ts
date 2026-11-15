/**
 * **Every write that can change a body's geometry facts marks them** (B01-3b). The facts are derived
 * from a body's outline and box, its neighbors' outlines and the places layer, and stored; a writer
 * that changes one of those without a mark leaves them behind.
 *
 * The marks go through choke points: `syncWaterBodyCells` (every body creation, moved box and listing
 * change re-cells the body, and marks its facts there), `markGeoStale` (an outline moved inside its
 * box), and `noteAdminAreasChanged` (the places layer). This lint finds, in the convex sources, every
 * `ctx.db.insert('waterBodies', …)` and every `ctx.db.patch`/`insert`/`replace` whose literal names a
 * `polygon` or `bbox` key, and requires the enclosing top-level function to call the matching choke
 * point. Writes to tables that are not inputs (bays, hazards, known features) are listed by file.
 *
 * **What it can't see:** a write whose fields arrive through a variable or a spread (`patch(id,
 * fields)`), a write in a helper whose caller holds the mark, or a write outside `convex/`. The drift
 * repair (`bodyGeo.repairDrift`, `bodyGeo.repairMissing`) is the net for those.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

const CONVEX = resolve(__dirname, '../../convex/convex');

/** Files whose outline or box writes are to tables the geometry facts don't read. */
const NOT_INPUTS: Record<string, string> = {
  'subAreas.ts': 'bay outlines (`waterBodySubAreas`)',
  'hazards.ts': 'hazard footprints',
  'lib/hazardMerge.ts': 'a merged hazard’s footprint',
  'bodyFeatures.ts': 'known features on a body',
};

/** The marks a write of each kind needs in its enclosing function. */
const BODY_MARKS = ['syncWaterBodyCells(', 'markGeoStale('];
const AREA_MARKS = ['noteAdminAreasChanged('];

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

/** The top-level declaration holding `offset`: from its column-0 start to the next one. */
function enclosing(text: string, offset: number): string {
  const starts = [...text.matchAll(/^(?:export )?(?:const|async function|function) /gm)].map(
    (m) => m.index ?? 0,
  );
  const from = starts.filter((s) => s <= offset).pop() ?? 0;
  const to = starts.find((s) => s > offset) ?? text.length;
  return text.slice(from, to);
}

test('every write of a body or an admin area outline is followed by its geometry mark', () => {
  const unmarked: string[] = [];
  let seen = 0;
  for (const path of sources(CONVEX)) {
    const file = relative(CONVEX, path);
    if (file in NOT_INPUTS) continue;
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(/ctx\.db\.(?:insert|patch|replace)\(/g)) {
      const at = m.index ?? 0;
      const span = callSpan(text, at);
      const bodyInsert = span.startsWith("ctx.db.insert('waterBodies'");
      const areaWrite = span.startsWith("ctx.db.insert('adminAreas'") || file === 'adminAreas.ts';
      const namesOutline = /\b(?:polygon|bbox)\s*[:,}]/.test(span);
      if (!bodyInsert && !namesOutline) continue;
      seen++;
      const marks = areaWrite ? AREA_MARKS : BODY_MARKS;
      const fn = enclosing(text, at);
      if (!marks.some((mark) => fn.includes(mark))) {
        unmarked.push(`${file}:${text.slice(0, at).split('\n').length}`);
      }
    }
  }
  // The lint saw the writers it exists for (the import's insert and patch, the drawn body, the
  // admit, the admin-area upsert) — a regex that stopped matching would pass vacuously.
  expect(seen).toBeGreaterThanOrEqual(5);
  expect(unmarked).toEqual([]);
});
