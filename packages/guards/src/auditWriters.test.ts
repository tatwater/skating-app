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
 * — would let two writers refuse the same words at different lengths. Any exported constant whose
 * name pairs a reason or a note with a cap, in core or the server, is that regression.
 */
test('one audit-reason cap: AUDIT_REASON_MAX, nowhere a second', () => {
  const CORE = resolve(__dirname, '../../core/src');
  const exported = /export const ([A-Z][A-Z0-9_]*)\s*=/g;
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
  // Text stored on rows of its own, with its own reader and limit — not an audit reason's cap: a
  // flag's note, an access alert's note, a skater's request note, a posted-access citation, and the
  // reason an imagery pass override keeps on its row (shown with the pass).
  const notReasons = new Set([
    'FLAG_NOTE_MAX_CHARS',
    'ACCESS_ALERT_NOTE_MAX_CHARS',
    'MAX_REQUEST_NOTE_LENGTH',
    'MAX_POSTED_NOTE_LENGTH',
    'MAX_OVERRIDE_REASON_CHARS',
  ]);
  expect(found.filter((name) => !notReasons.has(name)).sort()).toEqual(['AUDIT_REASON_MAX']);
});
