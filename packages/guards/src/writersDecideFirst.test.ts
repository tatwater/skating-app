/**
 * **A person or record writer decides before it writes the log** (D270, B01-4f). A write that is
 * refused leaves no audit row — Convex rolls a thrown mutation back — but a writer that audited and
 * *then* decided (a refusal, or "nothing changed, return") is one edit away from leaving a row for
 * a write that never happened. So in every function and mutation handler of the People and record
 * writers, nothing that refuses or turns back may come after its first audit call.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const CONVEX = resolve(__dirname, '../../convex/convex');
/**
 * Where the person writes, the record sheet's writes and the alert pin live — and the Corpus tasks'
 * decisions (B01-6a), whose rule must refuse before the domain write's or the settle's row.
 */
const WRITERS = [
  'moderation.ts',
  'admin.ts',
  'ledger.ts',
  'accessAlerts.ts',
  join('lib', 'ledgerEditors.ts'),
  'corpusWrites.ts',
];

/** A call that writes the audit log — `capturingAudit` runs a domain write that does (B01-6a). */
const AUDIT = /\b(?:auditUser|writePersonAudit|writeAudit|takeLedgerGrant|capturingAudit)\(/;
/** What decides a write: a refusal, a refusal helper, or an early "nothing changed". */
const DECIDES =
  /throw new ConvexError|\bassertWrite\(|\bloadModeratableUser\(|\brecordRefusal\(|\brecordActorRefusal\(|\bownContentRefusal\(|\bassertCorpusVerb\(|\bnamePickRefusal\(|return unchanged\(/g;

const count = (text: string, char: string) => text.split(char).length - 1;

/** The `{ … }` block that opens at or after `from`. */
function blockAt(text: string, from: number): string {
  const open = text.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

/** Each named function's and each mutation handler's body. */
function bodies(text: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const fn = /(?:async )?function (\w+)\s*(?:<[^>]*>)?\(/g;
  for (let m = fn.exec(text); m; m = fn.exec(text)) {
    // Past the parameter list, to the body: the first brace that ends its line once the return type
    // is closed — `Promise<{` on a line of its own opens the type, not the body.
    let depth = 0;
    let i = text.indexOf('(', m.index);
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) break;
    }
    const typeClosed = (to: number) => {
      const sig = text.slice(i, to).replace(/=>/g, '');
      return count(sig, '<') === count(sig, '>') && count(sig, '{') === count(sig, '}');
    };
    let open = text.indexOf('{', i);
    while (open > 0 && (text[open + 1] !== '\n' || !typeClosed(open))) {
      open = text.indexOf('{', open + 1);
    }
    out.push({ name: m[1] as string, body: blockAt(text, open) });
  }
  const handler = /export const (\w+) = (?:internalMutation|mutation)\(\{[\s\S]*?handler:[^=]*=>/g;
  for (let m = handler.exec(text); m; m = handler.exec(text)) {
    out.push({ name: m[1] as string, body: blockAt(text, m.index + m[0].length) });
  }
  return out;
}

/** The writers that decide something after their first audit call, with what they decide. */
function decidesAfterAudit(text: string): string[] {
  const late: string[] = [];
  for (const { name, body } of bodies(text)) {
    const at = body.search(AUDIT);
    if (at < 0) continue;
    const after = body.slice(at).match(DECIDES);
    if (after) late.push(`${name}: ${[...new Set(after)].join(', ')}`);
  }
  return late;
}

test.each(WRITERS)('every writer in %s decides before it writes the log', (file) => {
  expect(decidesAfterAudit(readFileSync(join(CONVEX, file), 'utf8'))).toEqual([]);
});

test('the guard sees a refusal, or a "nothing changed", after the audit call', () => {
  expect(
    decidesAfterAudit(`export async function banImpl(ctx, actor) {
  const id = await auditUser(ctx, actor._id, 'ban');
  if (bad) throw new ConvexError('no');
  return id;
}`),
  ).toEqual(['banImpl: throw new ConvexError']);
  expect(
    decidesAfterAudit(`export const keep = mutation({
  args: {},
  handler: async (ctx, args) => {
    await writeAudit(ctx, row);
    if (same) return unchanged(args.userId);
  },
});`),
  ).toEqual(['keep: return unchanged(']);
  expect(
    decidesAfterAudit(`async function fine(ctx) {
  if (bad) throw new ConvexError('no');
  await writePersonAudit(ctx, row);
}`),
  ).toEqual([]);
  // A return type that opens a brace at the end of its line is the type, not the body.
  expect(
    decidesAfterAudit(`export async function setStatus(
  ctx: MutationCtx,
): Promise<{
  targetId: Id<'reports'>;
}> {
  await writeAudit(ctx, row);
  const own = recordActorRefusal(actor, facts);
}`),
  ).toEqual(['setStatus: recordActorRefusal(']);
});
