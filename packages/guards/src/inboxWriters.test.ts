/**
 * **Every write of an Inbox source's open/closed state calls the one writer** (B01-5). The Inbox lists
 * stored items (`inboxItems`), kept by `lib/inboxItems.ts` beside every write that opens, closes or
 * moves a flag, an ask, a drawn body or a ticket. A write that skips it leaves an item open on a
 * decided flag, or a filed ask in no lane — until the slow drift repair finds it.
 *
 * This lint reads the convex sources with their comments blanked, finds every such write by its
 * literal —
 *
 * - an `insert('contentFlags' | 'waterBodyRequests' | 'supportTickets', …)`, and an
 *   `insert('waterBodies', …)` that names `reviewStatus` (a skater's drawing);
 * - a `patch(…)` / `replace(…)` naming `status` with a decision's stamp (`resolvedAt`,
 *   `resolvedByUserId`, `retractedAt`, `decidedAt`, `decidedByUserId`), or naming `reviewStatus`,
 *   `targetId:`, `candidateExternalId`, or `mergedIntoId:` (a question moved);
 * - a `.delete(` in a function that names one of those source tables by its literal —
 *
 * and holds each one's enclosing top-level function to calling an entry point of `lib/inboxItems`
 * (`fileMember`, `leaveMember`, `leaveMembers`, `decideItem`, `rekey`, `reopenItem`,
 * `syncInboxSource`, `syncReopened`, `refreshItemTab`), found in the function's text with comments **and strings**
 * blanked, so a mention in a comment or a string never counts. The functions making them are exactly
 * the inventories below — the writers, and the same-shaped writes that are named one by one as not an
 * Inbox source — so a new one fails until it is read.
 *
 * **What it can't see:** a write whose fields arrive through a variable (`patch(id, fields)`); a
 * delete in a function that doesn't name the source table (a generic drain of rows it was handed);
 * an ask moved by `{ waterBodyId }`, which every body-keyed table shares; a function nested inside
 * another's body, judged by its top-level function's text. The writers of those found by reading are
 * hooked, each with its test: `erasure.ts`' erasers (a withdrawn flag or ask, 30 days on),
 * `accountDeletion.ts`' `erasePrivate` (an account's tickets), `waterBodies.ts`' `retargetEach` (a
 * merge's asks moved by body id), and the duplicate-candidate and ruling writes that move a tab
 * (`flagAsDuplicates`, `clearDuplicateFlag`, `setPublicAccessImpl`). The drift repair
 * (`inboxItems:repair`, over open and decided items) is the net for anything else.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

const CONVEX = resolve(__dirname, '../../convex/convex');

/** Every function that writes an Inbox source's state, by `file#function` — each calls the writer. */
const SOURCE_WRITERS: Record<string, string> = {
  'contentFlags.ts#flag': 'a person files a flag',
  'contentFlags.ts#retract': 'its filer withdraws it',
  'lib/autoFlag.ts#fileOrBumpAutoFlag': 'the app files a flag',
  'lib/flagResolution.ts#closeFlag': 'every flag resolution, a ruling’s included',
  'corpusRequests.ts#create': 'a person asks (both inserts)',
  'corpusRequests.ts#retract': 'the asker withdraws it',
  'corpusRequests.ts#recordResolution': 'an admit resolved to a catalog feature',
  'corpusRequests.ts#seedBayRequests': 'a script’s asks (origin seed: files nothing)',
  'lib/landmarkProposals.ts#fileLandmarkProposals': 'a report’s where asks for a landmark',
  'lib/requestDecisions.ts#closeRow': 'every request decision, each sibling page’s included',
  // The Inbox's inverses (S2): an undo reopens the flags and the asks a decision closed.
  'lib/inboxFlags.ts#reopenFlagStep': 'a flag decision undone: each flag checked and reopened, a page at a time',
  'lib/undoHandlersCorpus.ts#reopenRequestPage':
    'a request decision undone: its asks reopen, a page at a time',
  'waterBodies.ts#create': 'a skater draws a body',
  // `approve`, `reject` and their undo (`return_to_review`) move a drawing's review through this one
  // helper since S2's turn 1 (the integration, 2026-11-21).
  'waterBodies.ts#moveDrawnReview': 'a drawing approved, rejected, or returned to review',
  'waterBodies.ts#retargetEach': 'a merge moves access reports (and, by body id, asks), one batch',
  'waterBodies.ts#mergeBodyInto': 'a drawing merged into a known body',
  'support.ts#create': 'a ticket filed',
  'support.ts#resolve': 'a ticket resolved',
};

/**
 * Writers whose hook another builder adds in this wave (B01-5's appendix: S2 owns these functions).
 * Listed so the guard passes until they land — and fails once one calls the writer and is still here.
 */
const OWED: Record<string, string> = {};

/** Writes of the same shape on other tables, one function at a time: no Inbox source, no hook owed. */
const NOT_SOURCES: Record<string, string> = {
  'corpusPlaceNames.ts#dismiss':
    'an email group’s place name dismissed: Corpus, not the Inbox (D216)',
  'corpusPlaceNames.ts#reopen': 'an email group’s place name reopened: Corpus',
  'corpusPlaceNames.ts#fileAsSpelling': 'an email group’s place name filed as a spelling: Corpus',
  'lib/landmarkRows.ts#placeCorpusName': 'a place name placed as a landmark: Corpus',
  'lib/landmarkRows.ts#repointLandmarksOnMerge': 'landmarks folded into a survivor on a merge',
  'landmarks.ts#restoreLandmarkImpl': 'a landmark put back on the map',
  'landmarks.ts#unrestoreLandmarkImpl': 'a landmark’s restore undone',
};

/** Functions that delete rows and name a source table: each calls the writer… */
const DELETE_WRITERS: Record<string, string> = {
  'erasure.ts#ERASERS': 'a withdrawn flag or ask erased, 30 days on',
  'accountDeletion.ts#erasePrivate': 'an account’s tickets erased at finalization',
  'waterBodies.ts#mergeBodyInto':
    'a merge deletes favorites; its asks and drawing move through the writer',
};
/** …or deletes something else, named here with why. */
const DELETE_NOT_SOURCES: Record<string, string> = {
  'erasure.ts#eraseReport':
    'deletes the report; a landmark ask it filed is only unlinked (its own life)',
  'lib/contentPurge.ts#redactAgedContent':
    'deletes revisions, tracks and bounties; only redacts flag notes',
};

const ENTRY =
  /\b(fileMember|leaveMember|leaveMembers|decideItem|rekey|reopenItem|syncInboxSource|syncReopened|refreshItemTab)\(/;
const STAMP = /\b(resolvedAt|resolvedByUserId|retractedAt|decidedAt|decidedByUserId)\b/;

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

/** Where each function starts: a top-level declaration (a Convex function is a top-level `const`). */
const DECL = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*[:=]/gm;

type Fn = { name: string; start: number; end: number };

/** The function a position sits in: the last one starting at or before it. */
function enclosing(fns: readonly Fn[], at: number): Fn | undefined {
  let found: Fn | undefined;
  for (const f of fns) if (f.start <= at) found = f;
  return found;
}

function functionsOf(text: string): Fn[] {
  const starts = [...text.matchAll(DECL)].map((m) => ({
    name: m[1] ?? m[2] ?? '?',
    start: m.index,
  }));
  return starts.map((s, i) => ({ ...s, end: starts[i + 1]?.start ?? text.length }));
}

/** Whether a call writes a source's state, by its literal. */
function writesState(call: string, kind: 'insert' | 'patch'): boolean {
  if (kind === 'insert') {
    return (
      /^insert\('(contentFlags|waterBodyRequests|supportTickets)'/.test(call) ||
      (/^insert\('waterBodies'/.test(call) && /\breviewStatus\b/.test(call))
    );
  }
  return (
    (/\bstatus\b/.test(call) && STAMP.test(call)) ||
    /\breviewStatus\b/.test(call) ||
    /\btargetId:/.test(call) ||
    /\bcandidateExternalId\b/.test(call) ||
    /\bmergedIntoId:/.test(call)
  );
}

/**
 * The source with its comments blanked (and, with `strings`, its string literals' contents too),
 * every offset kept — so a match is never a comment, and a hook mentioned only in one never counts.
 */
function blanked(source: string, strings: boolean): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g,
    (m, quote: string | undefined) =>
      quote
        ? strings
          ? `${quote}${' '.repeat(m.length - 2)}${quote}`
          : m
        : m.replace(/[^\n]/g, ' '),
  );
}

const SOURCE_LITERAL = /'(contentFlags|waterBodyRequests|supportTickets)'/;

/** Every `file#function` that writes a source's state, and whether it calls the writer. */
function scan(root: string): { writes: Map<string, boolean>; deletes: Map<string, boolean> } {
  const writes = new Map<string, boolean>();
  const deletes = new Map<string, boolean>();
  for (const p of sources(root)) {
    const where = relative(root, p);
    if (where === 'lib/inboxItems.ts') continue; // the writer itself
    const raw = readFileSync(p, 'utf8');
    const text = blanked(raw, false);
    const bare = blanked(raw, true);
    const fns = functionsOf(text);
    const callsWriter = (fn: Fn | undefined) =>
      fn ? ENTRY.test(bare.slice(fn.start, fn.end)) : false;
    for (const m of text.matchAll(/\b(insert|patch|replace)\(/g)) {
      const call = callAt(text, m.index);
      if (!writesState(call, m[1] === 'insert' ? 'insert' : 'patch')) continue;
      const fn = enclosing(fns, m.index);
      const key = `${where}#${fn?.name ?? '?'}`;
      writes.set(key, (writes.get(key) ?? true) && callsWriter(fn));
    }
    for (const fn of fns) {
      const body = text.slice(fn.start, fn.end);
      if (SOURCE_LITERAL.test(body) && /\.delete\(/.test(body)) {
        deletes.set(`${where}#${fn.name}`, callsWriter(fn));
      }
    }
  }
  return { writes, deletes };
}

test('every write of an Inbox source’s state calls the one writer, and the writers are the inventory', () => {
  const { writes, deletes } = scan(CONVEX);
  const writers = [...writes.keys()].filter((k) => !(k in NOT_SOURCES));
  expect(writers.sort()).toEqual(Object.keys(SOURCE_WRITERS).sort());
  // A named exception that no longer writes comes off the list.
  expect(Object.keys(NOT_SOURCES).filter((k) => !writes.has(k))).toEqual([]);
  const missing = writers.filter((k) => !writes.get(k) && !(k in OWED));
  expect(missing).toEqual([]);
  // An owed hook that has landed comes off the list, so it is held like the rest from then on.
  const landed = Object.keys(OWED).filter((k) => writes.get(k) === true);
  expect(landed).toEqual([]);
  // Deletes in a function that names a source table: the writers call the writer; the rest are named.
  expect([...deletes.keys()].sort()).toEqual(
    [...Object.keys(DELETE_WRITERS), ...Object.keys(DELETE_NOT_SOURCES)].sort(),
  );
  expect(Object.keys(DELETE_WRITERS).filter((k) => deletes.get(k) !== true)).toEqual([]);
});

test('the lint sees a writer that skips the hook', () => {
  const text = [
    'export const sneaky = mutation({',
    '  handler: async (ctx, { id }) => {',
    "    await ctx.db.patch(id, { status: 'dismissed', resolvedAt: Date.now() });",
    '  },',
    '});',
  ].join('\n');
  const fns = functionsOf(text);
  const at = text.indexOf('patch(');
  expect(writesState(callAt(text, at), 'patch')).toBe(true);
  const fn = enclosing(fns, at);
  expect(fn?.name).toBe('sneaky');
  expect(ENTRY.test(text.slice(fn?.start ?? 0, fn?.end))).toBe(false);
});

test('a hook named only in a comment or a string does not count', () => {
  const text = [
    'export const sneaky = mutation({',
    '  handler: async (ctx, { id }) => {',
    '    // await fileMember(ctx, flagSource(id));',
    "    const note = 'decideItem(ctx, x)';",
    "    await ctx.db.patch(id, { status: 'dismissed', resolvedAt: Date.now() });",
    '  },',
    '});',
  ].join('\n');
  const bare = blanked(text, true);
  const fn = enclosing(functionsOf(blanked(text, false)), text.indexOf('patch('));
  expect(fn?.name).toBe('sneaky');
  expect(ENTRY.test(text)).toBe(true);
  expect(ENTRY.test(bare.slice(fn?.start ?? 0, fn?.end))).toBe(false);
});
