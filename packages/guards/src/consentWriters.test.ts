/**
 * **The consent record is sealed** (D297; B03 §9.4, §9.12). One `consentRecords` row per terms
 * acceptance and per Know Before You Go completion, written once and whole; after the insert only
 * named fill-once fields change — the IP (`ipStatus`, `ip`, `ipUnavailable`), the emailed copy's
 * outcome (`copyEmail`) and an email the token lacked (`identity`, by the copy's send for an
 * acceptance and by `setRecordEmail` for a completion) — plus the finalize stage's sever
 * (`profileId`, `clerkUserId`, `severedAt`, `purgeAt`); `consent.purgeDue` is the only delete. The
 * readings (`termsReadings`) are written by `consent.ts` and erased by it and the finalize `erase`
 * stage. And the profile's five routing fields are written only by `consent.ts` (and the inbox
 * seed's fake people, born routed) and cleared only by the tombstone.
 *
 * This lint reads the convex sources with comments blanked and holds:
 *
 * 1. every top-level function that names either table by its literal (`'consentRecords'`,
 *    `'termsReadings'` — a query, an insert, a `v.id`, an `Id<…>`) is in {@link TOUCHES}, and every
 *    listed one still does — so a new reader or writer fails until it is read;
 * 2. an `insert('consentRecords' | 'termsReadings', …)` only in its listed inserters;
 * 3. in those functions, every `ctx.db.patch(` / `ctx.db.delete(` names a listed target, and no
 *    `ctx.db.replace(` exists;
 * 4. every `ctx.db.patch(` whose target is a record (`recordId`, `record._id`) names only the keys its
 *    function may fill, at any depth of the patch's literal;
 * 5. the profile's routing fields appear as object keys only in `consent.ts`, the schema and the
 *    tombstone.
 *
 * **What it can't see:** a write in a function that never names the table — `reachTermsEnd` stamps
 * the reading its helper `currentReading` found (a reading is not sealed; a record helper would be
 * caught by rule 4's target names) — a write whose fields arrive in a variable (`patch(recordId, fields)` — none
 * does, and rule 4 then finds no keys, which it refuses), a record handled under a name that never
 * says which table it came from, or a function nested inside another's body (judged by its top-level
 * function). `packages/convex/convex/consent*.test.ts` drive the writes themselves.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

const CONVEX = resolve(__dirname, '../../convex/convex');

const TABLES = ['consentRecords', 'termsReadings'] as const;

/** A function that names a consent table: what it does, and what it may patch or delete. */
interface Touch {
  why: string;
  /** Tables it may insert into. */
  inserts?: readonly (typeof TABLES)[number][];
  /** `ctx.db.patch(` targets it may name, by their exact text. */
  patches?: readonly string[];
  /** `ctx.db.delete(` targets it may name, by their exact text. */
  deletes?: readonly string[];
}

/** Every top-level function that names `consentRecords` or `termsReadings`, by `file:function`. */
const TOUCHES: Record<string, Touch> = {
  'consent.ts:currentReading': { why: 'the caller’s reading of the current terms' },
  'consent.ts:openTerms': { why: 'the reading opened', inserts: ['termsReadings'] },
  'consent.ts:acceptTerms': {
    why: 'the acceptance: the profile, the record, the reading consumed',
    inserts: ['consentRecords'],
    patches: ['profileId'],
    deletes: ['reading._id'],
  },
  'consent.ts:scheduleIp': { why: 'schedules the IP capture for a new record' },
  'consent.ts:newestRecord': { why: 'the caller’s newest record of a kind' },
  'consent.ts:completeKnowBeforeYouGo': {
    why: 'the completion: the record and the profile’s two fields',
    inserts: ['consentRecords'],
    patches: ['profile._id'],
  },
  'consent.ts:copyTarget': { why: 'the copy’s address (read)' },
  'consent.ts:sendTermsCopy': { why: 'the copy’s send (an action: no db)' },
  'consent.ts:setCopyOutcome': { why: 'fill-once: the copy’s outcome', patches: ['recordId'] },
  'consent.ts:fillRecordEmail': { why: 'a completion’s missing address (an action: no db)' },
  'consent.ts:setRecordEmail': {
    why: 'fill-once: an email the token lacked',
    patches: ['recordId'],
  },
  'consent.ts:captureIp': { why: 'the IP lookup (an action: no db)' },
  'consent.ts:setIp': { why: 'fill-once: the IP', patches: ['recordId'] },
  'consent.ts:pruneReadings': { why: 'unaccepted readings, 30 days on', deletes: ['row._id'] },
  'consent.ts:purgeDue': { why: 'the only delete of a record', deletes: ['record._id'] },
  'consent.ts:recordsFor': { why: 'the CLI lookup by account (read)' },
  'consent.ts:recordsByEmail': { why: 'the CLI lookup by email (read)' },
  'accountDeletion.ts:erasePrivate': {
    why: 'the finalize `erase` stage: the subject’s unaccepted readings, through its `drain` (its patch is an export bundle’s `expiresAt`)',
    patches: ['row._id'],
    deletes: ['row._id'],
  },
  'accountDeletion.ts:severConsent': {
    why: 'the finalize `consent` stage: the sever',
    patches: ['record._id'],
  },
  'dataExport.ts:collect': { why: 'the export (read)' },
};

/** The keys each function may write on a record, at any depth of its patch's literal. */
const RECORD_FILLS: Record<string, readonly string[]> = {
  'consent.ts:setIp': [
    'ipStatus',
    'ip',
    'address',
    'source',
    'match',
    'fetchedAt',
    'ipUnavailable',
  ],
  'consent.ts:setCopyOutcome': ['copyEmail', 'status', 'at', 'identity', 'email'],
  'consent.ts:setRecordEmail': ['identity', 'email'],
  'accountDeletion.ts:severConsent': ['profileId', 'clerkUserId', 'severedAt', 'purgeAt'],
};

/** A record-patch target: the names a record id goes by. */
const RECORD_TARGET = /^(?:recordId|record\._id)$/;

/**
 * The profile's routing fields, and where they may be written as keys: `consent.ts`, the schema, the
 * tombstone that clears them, and the inbox seed's fake people (`inboxSeed.ts:ensurePeople`, dev
 * only), born routed as through the way in — they stand where the retired risk acknowledgment's
 * stamp stood, and write no record.
 */
const ROUTING_FIELDS =
  /\b(termsVersion|termsAcceptedAt|knowBeforeYouGoAt|knowBeforeYouGoVersion|welcomeStep)\s*:/g;
const ROUTING_WRITERS = new Set([
  'consent.ts',
  'schema.ts',
  'accountDeletion.ts:writeTombstone',
  'inboxSeed.ts:ensurePeople',
]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '_generated' ? [] : sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

/** Comments blanked, positions kept. */
function uncomment(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:'"`])\/\/[^\n]*/g,
      (m, lead: string) => lead + ' '.repeat(m.length - lead.length),
    );
}

/** Strings blanked too (their quotes kept), positions kept. */
function unstring(text: string): string {
  return text.replace(
    /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g,
    (m) => `${m[0]}${' '.repeat(m.length - 2)}${m[0]}`,
  );
}

/** The top-level declaration (column 0) around `at`. */
function functionAt(text: string, at: number): string {
  let name = '<module>';
  for (const m of text.matchAll(
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*[:=]/gm,
  )) {
    if ((m.index ?? 0) > at) break;
    name = (m[1] ?? m[2]) as string;
  }
  return name;
}

/** The argument text of the call whose `(` is at `open`. */
function argsAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if ((c === ')' || c === '}' || c === ']') && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** The call's first argument, and the rest. */
function splitFirst(args: string): [string, string] {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) return [args.slice(0, i).trim(), args.slice(i + 1).trim()];
  }
  return [args.trim(), ''];
}

/** Every property key in an object literal's text, at any depth: `key:` and shorthand `{ key }`. */
function keysIn(literal: string): string[] {
  const keys = new Set<string>();
  for (const m of literal.matchAll(/([A-Za-z_$][\w$]*)\s*:(?!:)/g)) keys.add(m[1] as string);
  for (const m of literal.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g))
    keys.add(m[1] as string);
  return [...keys];
}

interface Call {
  fn: string;
  target: string;
  rest: string;
}

interface Scan {
  touches: Set<string>;
  inserts: { fn: string; table: string }[];
  patches: Call[];
  deletes: Call[];
  replaces: string[];
  routingKeys: string[];
}

function scan(): Scan {
  const out: Scan = {
    touches: new Set(),
    inserts: [],
    patches: [],
    deletes: [],
    replaces: [],
    routingKeys: [],
  };
  for (const path of sources(CONVEX)) {
    const rel = relative(CONVEX, path);
    const withStrings = uncomment(readFileSync(path, 'utf8'));
    const code = unstring(withStrings);
    for (const table of TABLES) {
      for (const m of withStrings.matchAll(new RegExp(`'${table}'`, 'g'))) {
        out.touches.add(`${rel}:${functionAt(code, m.index ?? 0)}`);
      }
      for (const m of withStrings.matchAll(new RegExp(`\\binsert\\(\\s*'${table}'`, 'g'))) {
        out.inserts.push({ fn: `${rel}:${functionAt(code, m.index ?? 0)}`, table });
      }
    }
    const calls = (verb: string) =>
      [...code.matchAll(new RegExp(`\\bctx\\.db\\.${verb}\\(`, 'g'))].map((m) => {
        const open = (m.index ?? 0) + m[0].length - 1;
        const [target, rest] = splitFirst(argsAt(code, open));
        return { fn: `${rel}:${functionAt(code, m.index ?? 0)}`, target, rest };
      });
    out.patches.push(...calls('patch'));
    out.deletes.push(...calls('delete'));
    out.replaces.push(...calls('replace').map((c) => c.fn));
    for (const m of code.matchAll(ROUTING_FIELDS)) {
      const fn = functionAt(code, m.index ?? 0);
      if (!ROUTING_WRITERS.has(rel) && !ROUTING_WRITERS.has(`${rel}:${fn}`)) {
        out.routingKeys.push(`${rel}:${fn} (${m[1]})`);
      }
    }
  }
  return out;
}

test('every function that names a consent table is listed, and every listed one still does', () => {
  const { touches } = scan();
  expect([...touches].filter((f) => !(f in TOUCHES)).sort()).toEqual([]);
  expect(Object.keys(TOUCHES).filter((f) => !touches.has(f))).toEqual([]);
  // A floor: the lint must have found the writers it exists for.
  expect(touches.size).toBeGreaterThanOrEqual(15);
});

test('only the listed inserters insert a record or a reading', () => {
  const { inserts } = scan();
  for (const { fn, table } of inserts) {
    expect(TOUCHES[fn]?.inserts ?? [], `${fn} inserts into ${table}`).toContain(table);
  }
  expect(inserts.map((i) => i.fn).sort()).toEqual(
    ['consent.ts:acceptTerms', 'consent.ts:completeKnowBeforeYouGo', 'consent.ts:openTerms'].sort(),
  );
});

test('the functions that touch the tables patch and delete only their listed targets, and never replace', () => {
  const { patches, deletes, replaces } = scan();
  for (const call of patches.filter((c) => c.fn in TOUCHES)) {
    expect(TOUCHES[call.fn]?.patches ?? [], `${call.fn} patches ${call.target}`).toContain(
      call.target,
    );
  }
  for (const call of deletes.filter((c) => c.fn in TOUCHES)) {
    expect(TOUCHES[call.fn]?.deletes ?? [], `${call.fn} deletes ${call.target}`).toContain(
      call.target,
    );
  }
  expect(replaces.filter((fn) => fn in TOUCHES)).toEqual([]);
});

test('every patch on a record names only the fill-once fields its function may write', () => {
  const recordPatches = scan().patches.filter((c) => RECORD_TARGET.test(c.target));
  expect(recordPatches.map((c) => c.fn).sort()).toEqual(
    [
      'accountDeletion.ts:severConsent',
      'consent.ts:setCopyOutcome',
      'consent.ts:setIp',
      'consent.ts:setRecordEmail',
      'consent.ts:setIp',
    ].sort(),
  );
  for (const call of recordPatches) {
    const allowed = RECORD_FILLS[call.fn] ?? [];
    const keys = keysIn(call.rest);
    // A patch whose fields arrive in a variable can't be read here: it has to be a literal.
    expect(keys.length, `${call.fn}: a record patch must be an object literal`).toBeGreaterThan(0);
    expect(
      keys.filter((k) => !allowed.includes(k)),
      call.fn,
    ).toEqual([]);
  }
});

test('the profile’s routing fields are written only by consent.ts (and the seed) and cleared only by the tombstone', () => {
  expect(scan().routingKeys).toEqual([]);
});

test('the key reader sees keys at any depth, and shorthand ones', () => {
  expect(keysIn('{ a: 1, b: { c: 2 }, ...(x ? { d } : {}) , e }').sort()).toEqual(
    ['a', 'b', 'c', 'd', 'e'].sort(),
  );
});
