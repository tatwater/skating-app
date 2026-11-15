/**
 * **The rows an undo's refusal reads** (B01-3d) — whether an undo would be refused depends, for a few
 * verbs, on the row as it stands now (a body's depth candidates and outline, a launch, a feature, a
 * landmark), and History asks that of every line it draws. Those reads are a body's outline at worst,
 * so each one is read **as it really weighs** against the request's budget (`requestBudget`, shared
 * with the profiles History reads for the same page), and a query reads each row once however many
 * lines ask. Once the budget is spent the answer is {@link UNDO_CHECKED_ELSEWHERE}, never a read past
 * the transaction's limit. A mutation reads afresh.
 */
import type { Doc, Id, TableNames } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { type RowKind, requestBudget } from './readBudget';

/** Why an undo could not be checked on this page: its rows are past what the page may read. */
export const UNDO_CHECKED_ELSEWHERE =
  'This page has too much to check this undo here — open what it changed to undo it.';

const SEEN = new WeakMap<object, Map<string, Promise<unknown>>>();

/**
 * One row for an undo's refusal: the document, `null` when it is gone, or `undefined` when the
 * request's budget can't afford its worst case (the caller answers {@link UNDO_CHECKED_ELSEWHERE}).
 */
export async function undoRead<T extends TableNames>(
  ctx: QueryCtx | MutationCtx,
  kind: RowKind,
  id: Id<T>,
): Promise<Doc<T> | null | undefined> {
  const isQuery = !('insert' in ctx.db);
  const seen = isQuery ? (SEEN.get(ctx) ?? new Map<string, Promise<unknown>>()) : null;
  const known = seen?.get(id);
  if (known) return known as Promise<Doc<T> | null | undefined>;
  const read = requestBudget(ctx).measured(kind, () => ctx.db.get(id) as Promise<Doc<T> | null>);
  if (seen) {
    seen.set(id, read);
    SEEN.set(ctx, seen);
  }
  return read;
}
