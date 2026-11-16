/**
 * **Every write of a verdict row keeps its `superseded` flag** (B01-4d). The record sheet's Reversed
 * list shows each item once, as its newest decision, by a flag stored on the verdict
 * (`contentVerdicts.superseded`, read by index): a writer that inserts a verdict or ends one without
 * saying whether a later one superseded it would drop the item from Reversed, or show it twice.
 *
 * This lint finds, in the convex sources, every `insert('contentVerdicts', …)` and every `patch(…)`
 * whose literal names `endedByActionId` or `standing:` (the fields that end a verdict), and holds:
 *
 * - each names `superseded` in the same call — or, for the replay's insert, spreads a replayed verdict
 *   (`...verdict`, whose type requires the flag);
 * - the files making them are exactly the inventory below, so a new writer fails until it is read.
 *
 * **What it can't see:** a write whose fields arrive through a variable. The verdict backfill
 * (`peopleJobs:backfillVerdicts`, which replays every item's history and rewrites what differs) is the
 * net for those, and `contentVerdicts.test.ts` holds the replay to the live writers.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

const CONVEX = resolve(__dirname, '../../convex/convex');

/** Every file that writes a verdict row's ending or inserts one — the inventory. */
const VERDICT_WRITERS: Record<string, string> = {
  'lib/contentVerdicts.ts': 'the live writers: recorded, ended, superseded',
  'contentRecord.ts': 'the replay that rebuilds the record from the audit log',
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '_generated' ? [] : sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

/** The text of the call opened at `start` (its first `(`), to its matching `)`. */
function callAt(text: string, start: number): string {
  let depth = 0;
  for (let i = text.indexOf('(', start); i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

test('every verdict insert and ending names `superseded`, and the writers are the inventory', () => {
  const holes: string[] = [];
  const writers = new Set<string>();
  for (const p of sources(CONVEX)) {
    const text = readFileSync(p, 'utf8');
    const where = relative(CONVEX, p);
    for (const m of text.matchAll(/\binsert\('contentVerdicts',/g)) {
      writers.add(where);
      const call = callAt(text, m.index);
      if (!/\bsuperseded\b/.test(call) && !/\.\.\.verdict\b/.test(call)) {
        holes.push(`${where}: a verdict inserted without \`superseded\``);
      }
    }
    for (const m of text.matchAll(/\bpatch\(/g)) {
      const call = callAt(text, m.index);
      if (!/\bendedByActionId\b|\bstanding:/.test(call)) continue;
      writers.add(where);
      if (!/\bsuperseded\b/.test(call)) {
        holes.push(`${where}: a verdict ended without \`superseded\``);
      }
    }
  }
  expect(holes).toEqual([]);
  expect([...writers].sort()).toEqual(Object.keys(VERDICT_WRITERS).sort());
});
