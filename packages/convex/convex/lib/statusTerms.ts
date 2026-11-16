/**
 * **When a person's status terms were set, and by which write** (B01-4f, the founder's call on a
 * repeat ban). A person's terms are their status, its reason and a suspension's end
 * (`lib/peopleCan.StatusTerms`). A write that sets the terms they already have changes nothing and,
 * since D270, writes nothing; one whose reason or end differs is a real change — audited, and what
 * the person's page and their list row then show. So both answer one question the same way: the
 * newest write that set the terms as they stand.
 *
 * - **The person's page** (`people.person`'s status note): its date, who and through what are that
 *   write's, read here ({@link readTermsSet}); its reason is the one on file — that write's own,
 *   except an undo's, which puts back the reason of the terms it restores and audits its own.
 * - **The list row** (`peopleRows.statusSince`): stamped when a status write lands (the writers pass
 *   `termsSet`), and, for rows written before this rule, by the rows backfill
 *   ({@link stampStatusTerms}) from the same reading.
 *
 * Rows written before D270 that set the terms they found (a repeat that changed nothing) are passed
 * over (`lib/stateSince`).
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { type StatusTerms, statusTermsOf } from './peopleCan';
import { personRowOf } from './peopleRows';
import { DOC_MAX, ReadBudget } from './readBudget';
import { startOfCurrentState } from './stateSince';

type Audit = Doc<'moderationActions'>;

/** A status verb's rows the reading walks back at most, newest first, and their real weight at most. */
export const STATUS_ROWS = 10;
export const STATUS_ROWS_BYTES = DOC_MAX;

/** The terms a ban, suspension or lift row set. */
export function termsSetBy(row: Audit): StatusTerms {
  if (row.action === 'unban') return { status: 'active', statusReason: null, suspendedUntil: null };
  // The reason it put on file, where it says (an undo puts back the prior one and audits its own);
  // else the row's own, as every ban and suspension kept before.
  const onFile = (row.metadata as { statusReason?: string | null } | undefined)?.statusReason;
  return {
    status: row.action === 'ban' ? 'banned' : 'suspended',
    statusReason: onFile !== undefined ? onFile : row.reason,
    suspendedUntil:
      row.action === 'suspend'
        ? (((row.metadata as { suspendedUntil?: number } | undefined)?.suspendedUntil ?? null) as
            | number
            | null)
        : null,
  };
}

/** The terms a row found, as it recorded them (`prev`); `undefined` on a row from before `prev`. */
function termsFoundBy(row: Audit): StatusTerms | undefined {
  const prev = (row.metadata as { prev?: Partial<StatusTerms> } | undefined)?.prev;
  if (prev?.status === undefined) return undefined;
  return {
    status: prev.status,
    statusReason: prev.statusReason ?? null,
    suspendedUntil: prev.suspendedUntil ?? null,
  };
}

const keyOf = (terms: StatusTerms) =>
  JSON.stringify([terms.status, terms.statusReason, terms.suspendedUntil]);

/**
 * **The write that set `person`'s current terms** — for a suspended or banned person, the newest row
 * of the verb that set them that changed something; `row: null` with `capped` when the rows read
 * ended before one (more were unread), or when the record and the person disagree (`capped: false`,
 * "not recorded"). A few rows, newest first, each read as it weighs, held to
 * {@link STATUS_ROWS_BYTES}.
 */
export async function readTermsSet(
  ctx: QueryCtx | MutationCtx,
  budget: ReadBudget,
  person: Doc<'profiles'>,
): Promise<{ row: Audit | null; at: number | null; capped: boolean }> {
  if (person.status !== 'suspended' && person.status !== 'banned') {
    return { row: null, at: null, capped: false };
  }
  const verb = person.status === 'banned' ? 'ban' : 'suspend';
  const current = keyOf(statusTermsOf(person));
  const seen: Audit[] = [];
  let complete = false;
  let before = Number.POSITIVE_INFINITY;
  const walkFrom = budget.bytes;
  for (let i = 0; i < STATUS_ROWS; i++) {
    // Held to its weight too: past it, the answer is "can't say", never the budget's last bytes.
    if (walkFrom - budget.bytes >= STATUS_ROWS_BYTES) break;
    const next = await budget.measured('moderationAction', () =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target_action', (q) =>
          q
            .eq('targetType', 'user')
            .eq('targetId', person._id)
            .eq('action', verb)
            .lt('_creationTime', before),
        )
        .order('desc')
        .first(),
    );
    if (next === undefined) break;
    if (next === null) {
      complete = true;
      break;
    }
    seen.push(next);
    before = next._creationTime;
    // A real change ends the walk — the test `startOfCurrentState` makes below.
    const found = termsFoundBy(next);
    if (found === undefined || keyOf(found) !== keyOf(termsSetBy(next))) break;
  }
  const set = startOfCurrentState(
    seen,
    (r) => {
      const found = termsFoundBy(r);
      return {
        at: r.createdAt,
        after: keyOf(termsSetBy(r)),
        before: found === undefined ? undefined : keyOf(found),
      };
    },
    current,
    complete,
  );
  return { row: set.row, at: set.since, capped: set.capped };
}

/** What a stamp may read: the walk at its worst, and the row. */
const STAMP_BUDGET = STATUS_ROWS_BYTES + 2 * DOC_MAX;
/** A stamp's whole work, as a caller's budget charges it. */
export const TERMS_STAMP_WORK = STAMP_BUDGET + 16 * 1024;

/**
 * Stamp a suspended or banned person's row with when their terms were set ({@link readTermsSet}) —
 * the rows backfill's step for rows written before this rule. A reading that can't say leaves the
 * row as it is; one that finds nothing on record stamps 0, "not recorded", as the note says. Returns
 * whether it moved the date.
 */
export async function stampStatusTerms(ctx: MutationCtx, userId: Id<'profiles'>): Promise<boolean> {
  const person = await ctx.db.get(userId);
  if (!person || (person.status !== 'suspended' && person.status !== 'banned')) return false;
  const row = await personRowOf(ctx, userId);
  if (!row) return false;
  const set = await readTermsSet(ctx, new ReadBudget(STAMP_BUDGET), person);
  // "Can't say" leaves the row as it was; "not recorded" is 0 — the row's own word for it, as the
  // page's note says `null` — so the two never disagree.
  if (set.capped) return false;
  const at = set.at ?? 0;
  if (at === row.statusSince) return false;
  await ctx.db.patch(row._id, { statusSince: at });
  return true;
}
