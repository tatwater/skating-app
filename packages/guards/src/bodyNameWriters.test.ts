/**
 * **Every write of a landmark's or a bay's names, kind, point, removal or body rebuilds the body's
 * short list of names, through the one helper** (B01-3u, D282). History checks the landmark undo's
 * whole rule from `bodyNameLists` (`convex/lib/bodyNames`); a writer that changes a name without
 * rebuilding it would let a list offer an undo the write then refuses, or refuse one it would take.
 *
 * This lint finds, in the convex sources, every `ctx.db.insert('bodyLandmarks' | 'waterBodySubAreas',
 * …)` and every `ctx.db.patch`/`replace` whose literal names `name`, `aliases`, `point`, `removedAt`,
 * or — in the files that write landmarks or bays — `waterBodyId` or `kind`, and holds:
 *
 * - each is in a function of the inventory below, whose listed keepers each call
 *   `refreshBodyNames(` (the writer itself, or — for a write a loop or a batch makes — the functions
 *   that rebuild once for it, which must then be its only callers);
 * - the other tables' writes of those field names are listed apart, by function;
 * - both lists are exact, so a new writer fails until it is read and listed;
 * - `bodyNameLists` is written only by `lib/bodyNames`.
 *
 * **What it can't see:** a write whose fields arrive through a variable (a catalog load's patch, a
 * merge's fold) — those sit in functions the inventory already holds — or a writer outside
 * `convex/`. `convex/bodyNameRows.test.ts` holds the rows to the tables over generated histories, and
 * the backfill (`landmarks:backfillBodyNames`) rebuilds every named body's row.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

const CONVEX = resolve(__dirname, '../../convex/convex');

/** Every function that writes what the list holds — and the functions that rebuild for it. */
const NAME_WRITERS: Record<string, { keepers: string[]; why: string }> = {
  'landmarks.ts:importOneBody': { keepers: ['self'], why: 'a catalog load (`importBatch`)' },
  'landmarks.ts:create': { keepers: ['self'], why: 'a moderator’s landmark' },
  'landmarks.ts:updateLandmarkImpl': { keepers: ['self'], why: 'an edit, and its undo' },
  'landmarks.ts:removeLandmarkImpl': { keepers: ['self'], why: 'a removal, and an undo' },
  'landmarks.ts:restoreLandmarkImpl': { keepers: ['self'], why: 'a restore, and an undo' },
  'landmarks.ts:unrestoreLandmarkImpl': { keepers: ['self'], why: 'a restore’s undo' },
  'lib/landmarkRows.ts:retireRow': {
    keepers: ['lib/landmarkRows.ts:retireAsPromoted', 'lib/landmarkRows.ts:retireNamedAsBays'],
    why: 'a landmark drawn as a bay, or named by one — rebuilt once by each caller',
  },
  'lib/landmarkRows.ts:repointLandmarksOnMerge': {
    keepers: ['self'],
    why: 'a body merge: the moves and the fold, both bodies',
  },
  'corpusPlaceNames.ts:fileAsSpelling': { keepers: ['self'], why: 'a corpus spelling filed' },
  'subAreas.ts:insertSubArea': {
    keepers: ['self', 'subAreas.ts:retireCollected'],
    why: 'every bay’s birth (chord, freehand, the seed, the campaign); a batch rebuilds per parent',
  },
  'subAreas.ts:systemDelist': {
    keepers: ['subAreas.ts:reclipSubAreasToParent', 'subAreas.ts:repointSubAreasOnMerge'],
    why: 'an automatic delist — rebuilt once a parent after each caller’s loop',
  },
  'subAreas.ts:repointSubAreasOnMerge': { keepers: ['self'], why: 'a body merge’s bays' },
  'subAreas.ts:renameSubAreaImpl': { keepers: ['self'], why: 'a bay renamed, and its undo' },
  'subAreas.ts:removeSubAreaImpl': { keepers: ['self'], why: 'a bay delisted, and an undo' },
  'subAreas.ts:restoreSubAreaImpl': { keepers: ['self'], why: 'a bay restored, and an undo' },
};

/** Writes of those field names to tables the list doesn't hold, by function. */
const OTHER_TABLES: Record<string, string> = {
  'accessPoints.ts:matchAndImportParking': 'a parking lot',
  'accessPoints.ts:setOfficialParking': 'a parking lot',
  'adminAreas.ts:importCanonical': 'a boundary',
  'corpusPlaceNames.ts:setLake': 'a corpus name’s lake (`corpusPlaceNames`)',
  'lib/landmarkRows.ts:placeCorpusName': 'a corpus name placed (`corpusPlaceNames`)',
  'putIns.ts:promotePutInImpl': 'a launch',
  'putIns.ts:demotePutInImpl': 'a launch',
  'reports.ts:update': 'a Report’s point',
  'waterBodies.ts:mergeBodyInto': 'a body’s own aliases',
  'waterBodies.ts:setWaterBodyNameImpl': 'a body’s own name',
};

/** The files that write landmarks or bays: there a `waterBodyId` write may be a move. */
const MOVE_FILES = ['landmarks.ts', 'lib/landmarkRows.ts', 'subAreas.ts', 'corpusPlaceNames.ts'];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '_generated' ? [] : sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

function callSpan(text: string, start: number): string {
  let depth = 0;
  for (let i = text.indexOf('(', start); i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

const DECLARATION = /^(?:export )?(?:const|async function|function) (\w+)/gm;

function enclosing(text: string, offset: number): { name: string; body: string } {
  const starts = [...text.matchAll(DECLARATION)].map((m) => ({ at: m.index ?? 0, name: m[1] }));
  const from = starts.filter((s) => s.at <= offset).pop() ?? { at: 0, name: '' };
  const to = starts.find((s) => s.at > offset)?.at ?? text.length;
  return { name: from.name ?? '', body: text.slice(from.at, to) };
}

function bodyOf(key: string): string {
  const [file, fn] = key.split(':') as [string, string];
  const text = readFileSync(join(CONVEX, file), 'utf8');
  const at = [...text.matchAll(DECLARATION)].find((m) => m[1] === fn)?.index;
  expect(at, `${key} exists`).toBeDefined();
  return enclosing(text, at as number).body;
}

const names = (span: string, key: string) => new RegExp(`\\b${key}\\s*[:,}]`).test(span);

test('every write of what a body’s short list holds is an inventoried writer that rebuilds it', () => {
  const holes: string[] = [];
  const writers = new Set<string>();
  const others = new Set<string>();
  for (const path of sources(CONVEX)) {
    const file = relative(CONVEX, path);
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(/ctx\.db\.(insert|patch|replace)\(/g)) {
      const at = m.index ?? 0;
      const span = callSpan(text, at);
      const listedInsert = /^ctx\.db\.insert\('(?:bodyLandmarks|waterBodySubAreas)'/.test(span);
      if (m[1] === 'insert' && !listedInsert) continue;
      const fields =
        listedInsert ||
        ['name', 'aliases', 'point', 'removedAt'].some((f) => names(span, f)) ||
        (MOVE_FILES.includes(file) && (names(span, 'waterBodyId') || names(span, 'kind')));
      if (!fields) continue;
      const key = `${file}:${enclosing(text, at).name}`;
      if (key in OTHER_TABLES) {
        others.add(key);
        continue;
      }
      writers.add(key);
      const entry = NAME_WRITERS[key];
      const where = `${file}:${text.slice(0, at).split('\n').length}`;
      if (!entry) {
        holes.push(`${where} writes a name, point, removal or body in an uninventoried function`);
        continue;
      }
      for (const keeper of entry.keepers) {
        const k = keeper === 'self' ? key : keeper;
        if (!/\brefreshBodyNames\(/.test(bodyOf(k))) {
          holes.push(`${where}: ${k} doesn’t rebuild the body’s short list of names`);
        }
      }
    }
  }
  // A writer rebuilt by its callers instead of itself: every caller must be one of its keepers, so a
  // new path to the write that skips the rebuild fails here.
  for (const [key, entry] of Object.entries(NAME_WRITERS)) {
    if (entry.keepers.includes('self')) continue;
    const fn = key.split(':')[1] as string;
    for (const path of sources(CONVEX)) {
      const file = relative(CONVEX, path);
      const text = readFileSync(path, 'utf8');
      for (const m of text.matchAll(new RegExp(`\\b${fn}\\(`, 'g'))) {
        const caller = `${file}:${enclosing(text, m.index ?? 0).name}`;
        if (caller === key) continue;
        if (!entry.keepers.includes(caller)) {
          holes.push(`${caller} calls ${fn} without being one of its keepers`);
        }
      }
    }
  }
  expect(holes).toEqual([]);
  expect([...writers].sort()).toEqual(Object.keys(NAME_WRITERS).sort());
  expect([...others].sort()).toEqual(Object.keys(OTHER_TABLES).sort());
});

test('`bodyNameLists` is written only by `lib/bodyNames`', () => {
  const writing = sources(CONVEX)
    .filter((p) =>
      /(?:insert|replace|patch)\('bodyNameLists'|insert\('bodyNameLists'/.test(
        readFileSync(p, 'utf8'),
      ),
    )
    .map((p) => relative(CONVEX, p));
  expect(writing).toEqual(['lib/bodyNames.ts']);
  const naming = sources(CONVEX)
    .filter((p) => !p.endsWith('schema.ts'))
    .filter((p) => /['"]bodyNameLists['"]/.test(readFileSync(p, 'utf8')))
    .map((p) => relative(CONVEX, p))
    .sort();
  // The writer, the one reader (History's undo check, through the undo engine's reader) and its type.
  expect(naming).toEqual(['lib/bodyNames.ts', 'lib/undoReads.ts', 'lib/undoTypes.ts']);
});
