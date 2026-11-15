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
