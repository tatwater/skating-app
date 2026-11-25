/**
 * **Every write that changes what a body is found by rebuilds its search text, through the one
 * builder** (B01-3h). `waterBodies.searchText` is derived from the name, the catalogs' claims and a
 * moderator's aliases (`@skating/core`'s `bodySearchTextFor`); skater search, the sheet's "Which
 * lake?" and Explore read it through `searchByName`, and the console's library rows read the same
 * rule (`bodyAliasesFor`). A writer that changes an ingredient without rebuilding it leaves a body
 * unfindable by a name it has.
 *
 * This lint finds, in the convex sources, every `ctx.db.insert`/`patch`/`replace` whose literal names
 * `name`, `nameClaims`, `moderatorAliases` or `searchText`, or that inserts a body, and holds:
 *
 * - a body write (a body insert, or one naming `nameClaims` or `moderatorAliases`) names `searchText`
 *   built by `bodySearchTextFor` in the same call — or spreads `nameFields(`, the import's helper,
 *   which must itself build it so;
 * - a write naming `searchText` builds it by `bodySearchTextFor` (in the call, or in its function for
 *   the repair pass's item) unless it is another table's, listed by function;
 * - a write naming `name` is a body write, or another table's, listed by function;
 * - the body writers found are exactly the inventory below, so a new one fails until it is read and
 *   listed.
 *
 * Writers that change no ingredient need nothing: a merge moves no catalog names (a merged-away
 * duplicate's names find its survivor at search time) — it carries only a moderator's aliases, and
 * rebuilds the survivor's text when it does — and a removal or rejection leaves the names and is
 * filtered by standing at search time.
 *
 * **What it can't see:** a write whose fields arrive through a variable or a spread other than
 * `nameFields(`, or a write outside `convex/`. The repair pass (`waterBodies.backfillSearchText`)
 * is the net for those.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

const CONVEX = resolve(__dirname, '../../convex/convex');

/** Every function that writes a body's name, claims, aliases or search text — the inventory. */
const BODY_WRITERS: Record<string, string> = {
  'waterBodies.ts:importCanonical': 'the import, insert and re-import (through `nameFields`)',
  'waterBodies.ts:create': 'a body a skater drew',
  'waterBodies.ts:setAliasesImpl': 'a moderator’s aliases, and their undo',
  'waterBodies.ts:mergeBodyInto': 'a merge, carrying the loser’s aliases to its survivor (B01-3g)',
  'waterBodies.ts:setWaterBodyNameImpl': 'the name override, its clear and its undo',
  'waterBodies.ts:writeSearchTextOne': 'the repair pass’s item',
  'corpusRequests.ts:admitCandidate': 'a catalog body admitted on a skater’s request',
};

/** Writes of a `name` to tables search doesn't read through `waterBodies.searchText`. */
const OTHER_NAME_WRITERS: Record<string, string> = {
  'corpusRequests.ts:create': 'a skater’s request (`waterBodyRequests`)',
  'corpusRequests.ts:seedBayRequests': 'a bay request (`waterBodyRequests`)',
  'lib/landmarkProposals.ts:fileLandmarkProposals': 'a landmark proposal (`waterBodyRequests`)',
  'subAreas.ts:insertSubArea': 'a bay (its own `searchText`)',
  'subAreas.ts:renameSubAreaImpl': 'a bay (its own `searchText`)',
  'putIns.ts:placePutInImpl': 'a launch',
  'putIns.ts:promotePutInImpl': 'a launch',
  'putIns.ts:demotePutInImpl': 'a launch',
  'adminAreas.ts:importCanonical': 'a boundary',
  'accessPoints.ts:matchAndImportParking': 'a parking lot',
  'accessPoints.ts:setOfficialParkingImpl': 'a parking lot',
  // `landmarks.ts:importOneBody` writes a landmark's name through its recorded write (`put`, and an
  // insert of a built row), which a dry run also replays in memory — no literal `name` here to list.
  'landmarks.ts:create': 'a landmark',
  'landmarks.ts:updateLandmarkImpl': 'a landmark',
};

/** Writes of a `searchText` to other tables. */
const OTHER_SEARCH_TEXT: Record<string, string> = {
  'subAreas.ts:insertSubArea': 'a bay',
  'subAreas.ts:renameSubAreaImpl': 'a bay',
  'lib/postSync.ts:refreshPostSearchText': 'a Post',
};

const BUILDER = 'bodySearchTextFor(';

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

const names = (span: string, key: string) => new RegExp(`\\b${key}\\s*[:,}]`).test(span);

test('every writer of what a body is found by rebuilds its search text through the one builder', () => {
  const holes: string[] = [];
  const bodyWriters = new Set<string>();
  const others = new Set<string>();
  for (const path of sources(CONVEX)) {
    const file = relative(CONVEX, path);
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(/ctx\.db\.(insert|patch|replace)\(/g)) {
      const at = m.index ?? 0;
      const span = callSpan(text, at);
      const bodyInsert = span.startsWith("ctx.db.insert('waterBodies'");
      const bodyFields = names(span, 'nameClaims') || names(span, 'moderatorAliases');
      const writesName = names(span, 'name');
      const writesText = names(span, 'searchText');
      if (!bodyInsert && !bodyFields && !writesName && !writesText) continue;
      const fn = enclosing(text, at);
      const key = `${file}:${fn.name}`;
      const where = `${file}:${text.slice(0, at).split('\n').length}`;
      const built = span.includes(BUILDER) || span.includes('...nameFields(');
      if (bodyInsert || bodyFields) {
        bodyWriters.add(key);
        if (!built) holes.push(`${where} writes a body’s names without \`${BUILDER}\``);
        continue;
      }
      if (writesText) {
        if (key in OTHER_SEARCH_TEXT) {
          others.add(key);
          continue;
        }
        bodyWriters.add(key);
        if (!built && !fn.body.includes(BUILDER)) {
          holes.push(`${where} writes a search text not built by \`${BUILDER}\``);
        }
        continue;
      }
      if (key in OTHER_NAME_WRITERS) {
        others.add(key);
        continue;
      }
      holes.push(
        `${where} writes a \`name\` that is neither a body’s (with its search text) nor listed`,
      );
    }
  }
  // The import's helper builds the text itself, from the aliases a moderator gave the body.
  const water = readFileSync(join(CONVEX, 'waterBodies.ts'), 'utf8');
  const helper = enclosing(water, water.indexOf('function nameFields('));
  expect(helper.body).toContain(BUILDER);
  expect(helper.body).toContain('moderatorAliases');
  expect(holes).toEqual([]);
  // The inventory is exact: a new writer is read and listed, a gone one is taken off.
  expect([...bodyWriters].sort()).toEqual(Object.keys(BODY_WRITERS).sort());
  const listed = new Set([...Object.keys(OTHER_NAME_WRITERS), ...Object.keys(OTHER_SEARCH_TEXT)]);
  expect([...others].sort()).toEqual([...listed].sort());
});

test('no search text is joined by hand: a body’s goes through the builder, a bay’s through `subAreaSearchText`', () => {
  const bare = sources(CONVEX)
    .filter((p) => /\bsearchTextFor\(/.test(readFileSync(p, 'utf8')))
    .map((p) => relative(CONVEX, p));
  expect(bare).toEqual([]);
});
