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

/**
 * A reason the system builds from stored names or text is a `composed` one (D261): the audit writer
 * shortens it to fit, where a plain string — what a person typed — is refused past the cap. A raw
 * template with a value, passed to an audit writer, would be refused on a long name instead.
 */
test('every reason an audit writer composes is tagged composed', () => {
  // The People entry and the ledger's own writer too: `typed(...)` takes any string, so a raw template
  // passed through it would compile, and be refused on a long name.
  const writers =
    /\b(?:writeAudit|writePersonAudit|takeLedgerGrant|audit|auditLandmark|auditUser|writeDepth|mergeBodyInto)\(/g;
  const raw: string[] = [];
  for (const p of sources(CONVEX)) {
    const text = readFileSync(p, 'utf8');
    for (let m = writers.exec(text); m; m = writers.exec(text)) {
      let depth = 0;
      let end = m.index;
      for (let i = m.index + m[0].length - 1; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')' && --depth === 0) {
          end = i;
          break;
        }
      }
      const span = text.slice(m.index, end);
      for (const t of span.matchAll(/(composed)?`[^`]*\$\{/g)) {
        if (!t[1]) raw.push(`${relative(CONVEX, p)}: ${t[0].slice(0, 60)}`);
      }
    }
  }
  expect(raw).toEqual([]);
});

/**
 * The People writers take a tagged reason only (`writePersonAudit`, B01-4b): a bare string — built in
 * a variable, quoting stored text — can't compile into a person write. The type is the fence; this is
 * the backstop that the People modules don't reach around it.
 */
test('the People writers go through writePersonAudit, never writeAudit', () => {
  const PEOPLE_MODULES = ['admin.ts', 'peopleJobs.ts', join('lib', 'ledgerEditors.ts')];
  const direct = PEOPLE_MODULES.filter((p) =>
    /\bwriteAudit\(/.test(readFileSync(join(CONVEX, p), 'utf8')),
  );
  expect(direct).toEqual([]);
  const moderation = readFileSync(join(CONVEX, 'moderation.ts'), 'utf8');
  const auditUser = moderation.slice(
    moderation.indexOf('async function auditUser('),
    moderation.indexOf('\n}\n', moderation.indexOf('async function auditUser(')),
  );
  expect(auditUser).toContain('writePersonAudit(ctx');
  expect(auditUser).toContain('reason: AuditReason,');
});

/**
 * One cap for every audit reason (D261: `AUDIT_REASON_MAX`, 2,000, and its own refusal sentence). A
 * second constant for the same limit — #130 brought an interim 1,000-character one before D261 landed
 * — would let two writers refuse the same words at different lengths. Any constant whose name pairs
 * a reason or a note with a cap, in core or the server — exported or module-local (the server keeps
 * most of its caps local), typed or not — is that regression.
 */
test('one audit-reason cap: AUDIT_REASON_MAX, nowhere a second', () => {
  const CORE = resolve(__dirname, '../../core/src');
  const exported = /\bconst ([A-Z][A-Z0-9_]*)\s*(?::[^=;\n]+)?=/g;
  // A name's words: one of them a reason or a note, one of them a cap.
  const isReasonCap = (name: string) => {
    const words = name.split('_');
    return (
      words.some((w) => w === 'REASON' || w === 'NOTE') &&
      words.some((w) => w === 'MAX' || w === 'CAP' || w === 'LIMIT')
    );
  };
  const found: string[] = [];
  for (const root of [CORE, CONVEX]) {
    for (const p of sources(root)) {
      const text = readFileSync(p, 'utf8');
      for (let m = exported.exec(text); m; m = exported.exec(text)) {
        if (isReasonCap(m[1] as string)) found.push(m[1] as string);
      }
    }
  }
  // Text stored on rows of its own, read there under its own, tighter limit: a flag's note, an
  // access alert's note, a posted-access citation, and the notes a body's standing, access ruling
  // and depth show skaters. Two also land verbatim in an audit line — a request's note (a decline's
  // note is its row's audit reason) and an imagery pass override's reason (quoted after "Hid the …
  // pass") — and their row's limit holds them under the audit cap, so that cap never bites them.
  // A support note is a `supportMessages` row (B01-5f): its audit row carries the default reason,
  // never the note. A known feature's note is its `bodyFeatures` row's: its audit row carries the
  // write's reason, never the note.
  const notReasons = new Set([
    'FLAG_NOTE_MAX_CHARS',
    'ACCESS_ALERT_NOTE_MAX_CHARS',
    'MAX_REQUEST_NOTE_LENGTH',
    'MAX_POSTED_NOTE_LENGTH',
    'MAX_OVERRIDE_REASON_CHARS',
    'MAX_STANDING_NOTE_LENGTH',
    'MAX_PUBLIC_ACCESS_NOTE_LENGTH',
    'MAX_DEPTH_NOTE_LENGTH',
    'MAX_SUPPORT_NOTE_LENGTH',
    'MAX_BODY_FEATURE_NOTE_LENGTH',
  ]);
  expect(found.filter((name) => !notReasons.has(name)).sort()).toEqual(['AUDIT_REASON_MAX']);
  // An exemption whose cap is gone would let a new cap under that name past unseen.
  expect([...notReasons].filter((name) => !found.includes(name))).toEqual([]);
});

// ── A person's words quoted in a composed reason are checked there (B01-4h) ──────────────────────

/**
 * A reason's or a note's name — what a person types beside a takedown, a dismissal, a decline. The
 * convention the guard reads: a person's words travel under one of these names.
 */
const PERSONS_WORDS = /\b(?:reason|note|noted|why|[a-z][A-Za-z]*(?:Reason|Note))\b/g;

/**
 * Values a composed reason quotes that are not a person's words, though named like them — each with
 * why. A new entry is a decision, made here where it is read.
 */
const NOT_A_PERSONS_WORDS: Record<string, string> = {
  // The undo's default quotes the undone row's own stored reason: written once, under the cap
  // (D261) or from before it, and fitted with the rest — never what this caller typed.
  'lib/undo.ts :: row.reason': 'a stored row’s reason',
  // A place name's dismissal reason is one of `DISMISS_REASONS`, a literal the validator holds.
  'corpusPlaceNames.ts :: reason': 'an enum (the dismissal reason)',
  // A body's removal reason is one of `REMOVAL_REASONS`, a literal the validator holds.
  'waterBodies.ts :: args.reason': 'an enum (the removal reason)',
  // The system's own delisting cause (`systemDelist`: an outline change's clip, a merge's name
  // clash), never typed.
  'subAreas.ts :: reason': 'the system’s own cause',
};

/** The end of a string or template literal opened at `start` (its quote), skipping escapes and `${…}`. */
function literalEnd(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i;
    else if (quote === '`' && text[i] === '$' && text[i + 1] === '{') i = braceEnd(text, i + 1);
  }
  return text.length;
}

/** The `}` that closes the `{` at `open`, skipping string and template literals. */
function braceEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') i = literalEnd(text, i);
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return text.length;
}

/** The `)` that closes the `(` at `open`, skipping literals. */
function parenEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') i = literalEnd(text, i);
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return text.length;
}

/** What a composed reason quotes: each `${…}` of a `composed` template, and `composedOf`'s arguments. */
function composedValues(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bcomposed`/g)) {
    const tick = (m.index ?? 0) + m[0].length - 1;
    const end = literalEnd(text, tick);
    for (let i = tick + 1; i < end; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '$' && text[i + 1] === '{') {
        const close = braceEnd(text, i + 1);
        out.push(text.slice(i + 2, close));
        i = close;
      }
    }
  }
  for (const m of text.matchAll(/\bcomposedOf\(/g)) {
    // Its own declaration, and the tag's call through it, carry no person's words.
    if (/function\s+$/.test(text.slice(0, m.index))) continue;
    const open = (m.index ?? 0) + m[0].length - 1;
    out.push(text.slice(open + 1, parenEnd(text, open)));
  }
  return out;
}

/** `expr` with every `checkedReason(…)` call taken out: what is left was quoted unchecked. */
function withoutChecked(expr: string): string {
  let out = expr;
  for (let at = out.search(/\bcheckedReason\(/); at >= 0; at = out.search(/\bcheckedReason\(/)) {
    const open = out.indexOf('(', at);
    out = out.slice(0, at) + out.slice(parenEnd(out, open) + 1);
  }
  return out;
}

/**
 * **The person's words a source quotes in a composed reason without `checkedReason`** — one line
 * each, `file :: expression`. A composed reason is shortened to fit and never refused (D261's cap is
 * for what a person types), so a person's words quoted in it unchecked would be cut where they should
 * be refused, and kept with the whitespace the one normalizer would take off.
 */
function uncheckedQuotes(file: string, text: string): string[] {
  const found: string[] = [];
  for (const value of composedValues(text)) {
    const left = withoutChecked(value);
    for (const m of left.matchAll(PERSONS_WORDS)) {
      // The whole member chain the name ends, as the exemptions spell it (`args.reason`).
      const before = left.slice(0, m.index).match(/[\w$.?]*$/)?.[0] ?? '';
      const chain = `${before}${m[0]}`.replace(/\?\./g, '.');
      found.push(`${file} :: ${chain}`);
    }
  }
  return found;
}

test('a composed reason quotes a person’s words only through checkedReason', () => {
  const found = sources(CONVEX).flatMap((p) =>
    uncheckedQuotes(relative(CONVEX, p), readFileSync(p, 'utf8')),
  );
  expect(found.filter((f) => NOT_A_PERSONS_WORDS[f] === undefined)).toEqual([]);
  // An exemption no source needs any more would let a new quote under that name past unseen.
  expect(Object.keys(NOT_A_PERSONS_WORDS).filter((k) => !found.includes(k))).toEqual([]);
});

/** A source sample, its lines joined, `#{` read as an interpolation's `${`. */
const src = (lines: string[]) => lines.join('\n').replaceAll('#{', '${');

test('the guard fails a deliberately wrong sample, and passes it once checked', () => {
  // Samples spell an interpolation `#{…}` (a source sample, not this file's own template).
  const wrong = src([
    'await writeAudit(ctx, {',
    '  reason: composed`Removed from map (#{kind}): #{args.note}`,',
    '});',
    'const r = composedOf([`Hid the `, ` pass: #{reason}`], [granuleId]);',
    'const s = composed`Dismissed: #{why ?? ""} #{overrideReason}`;',
  ]);
  expect(uncheckedQuotes('sample.ts', wrong)).toEqual([
    'sample.ts :: args.note',
    'sample.ts :: why',
    'sample.ts :: overrideReason',
    'sample.ts :: reason',
  ]);
  const right = src([
    'reason: composed`Removed from map (#{kind}): #{checkedReason(args.note)}`,',
    "const r = composedOf(['Hid the ', ' pass: ', checkedReason(reason)], [granuleId, '']);",
    'const s = composed`Dismissed: #{checkedReason(why ?? "")} #{checkedReason(overrideReason)}`;',
    'export function composedOf(fixed: readonly FixedWords, values: readonly string[]) {}',
  ]);
  expect(uncheckedQuotes('sample.ts', right)).toEqual([]);
});

// ── The one normalizer changes nothing a writer's own words or a reader's match depend on ─────────

/** The writers whose call spans the literal-reason scan reads (the composed guard's, above). */
const WRITER_CALLS =
  /\b(?:writeAudit|writePersonAudit|takeLedgerGrant|audit|auditLandmark|auditUser|writeDepth)\(/g;

/** Every string literal a writer passes as a whole reason: after `reason:`, `??` or `||`. */
function literalReasons(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(WRITER_CALLS)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const span = text.slice(open, parenEnd(text, open) + 1);
    for (const r of span.matchAll(/(?:\breason:|\?\?|\|\|)\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
      out.push(r[2] as string);
    }
  }
  // The fixed reasons a writer names by constant (`AUTHOR_DELETE_REASON`, `ERASE_REASON`'s values…).
  for (const c of text.matchAll(/\bconst [A-Z][A-Z_]*_REASON\b[^=]*=\s*(\{[^}]*\}|'[^']*')/g)) {
    for (const lit of (c[1] as string).matchAll(/'((?:\\.|[^'])*)'/g)) out.push(lit[1] as string);
  }
  return out;
}

test('every literal reason a writer passes is already trimmed, so the normalizer stores it unchanged', () => {
  const found = sources(CONVEX).flatMap((p) => literalReasons(readFileSync(p, 'utf8')));
  // The scan finds the writers' own words (a floor, so a broken scan can't pass by finding none).
  expect(found.length).toBeGreaterThan(30);
  expect(found).toContain('Deleted by the author');
  expect(found.filter((r) => r !== r.trim())).toEqual([]);
});

test('a reader matching a composed reason by its start still matches rows written before', () => {
  // A prefix match on a stored reason (`row.reason.startsWith('…')`): the words it looks for are the
  // fixed start of a composed writer's line, which starts with no whitespace — so trimming a new row
  // can't move its start, and an old row (the same fixed words first) matches as it did.
  const prefixes = sources(CONVEX).flatMap((p) =>
    [...readFileSync(p, 'utf8').matchAll(/\.reason\.startsWith\('([^']+)'\)/g)].map(
      (m) => m[1] as string,
    ),
  );
  expect(prefixes.length).toBeGreaterThan(0);
  const writers = sources(CONVEX).map((p) => readFileSync(p, 'utf8'));
  for (const prefix of prefixes) {
    expect(prefix, 'a prefix starts with its words').toBe(prefix.trimStart());
    expect(
      writers.some((text) => text.includes(`composed\`${prefix}`)),
      `a composed writer starts with "${prefix}"`,
    ).toBe(true);
  }
});
