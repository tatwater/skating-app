/**
 * **The rows an undo's refusal reads** (B01-3d; B01-3h) — whether an undo would be refused depends,
 * for a few verbs, on the row as it stands now (a body's depth candidates and outline, a launch, a
 * feature, a landmark), and History asks that of every line it draws. A page's refusals run in
 * `lib/undo`'s `undoStates`, in page order, in waves over the request's budget (`ReadBudget.waves`):
 * each reserves its declared worst case (`refusalCost`) before it reads, reads through the reader
 * made here (a query reads each row once however many lines ask), and hands back what it didn't
 * weigh. The rows past what the budget can reserve answer {@link UNDO_CHECKED_ELSEWHERE}, never a
 * read past the transaction's limit — the same rows for the same data, whatever order reads settle
 * in. (A refusal's other reads — a snapshot, a body's hidden launches — are not charged here.)
 */
import type { Doc, Id, TableNames } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { RowKind, Share } from './readBudget';
import type { UndoRead, UndoScope } from './undoTypes';

/** Why an undo could not be checked on this page: its rows are past what the page may read. */
export const UNDO_CHECKED_ELSEWHERE =
  'This page has too much to check this undo here — open what it changed to undo it.';

const SEEN = new WeakMap<object, Map<string, Promise<unknown>>>();

/**
 * The reads a refusal is handed: a query reads each row once however many lines ask (a sibling's read
 * in flight, or an earlier wave's, costs nothing more); every other read is charged to the share its
 * row was admitted with (`ReadBudget.waves`). A mutation reads afresh.
 */
export function undoReader(ctx: QueryCtx | MutationCtx, share: Share, scope: UndoScope): UndoRead {
  const isQuery = !('insert' in ctx.db);
  return {
    scope,
    row: <T extends TableNames>(kind: RowKind, id: Id<T>) => {
      const seen = isQuery ? (SEEN.get(ctx) ?? new Map<string, Promise<unknown>>()) : null;
      const known = seen?.get(id);
      if (known) return known as Promise<Doc<T> | null>;
      const read = share.read(kind, () => ctx.db.get(id) as Promise<Doc<T> | null>);
      if (seen) {
        seen.set(id, read);
        SEEN.set(ctx, seen);
      }
      return read;
    },
    snapshot: async <P>(kind: RowKind, actionId: Id<'moderationActions'>) => {
      const first = await share.read(kind, () =>
        ctx.db
          .query('auditSnapshots')
          .withIndex('by_action', (q) => q.eq('actionId', actionId))
          .first(),
      );
      if (!first) return null;
      const payload = first.payload as { chunk?: unknown } | null;
      return typeof payload === 'object' && payload !== null && typeof payload.chunk === 'string'
        ? 'parts'
        : (first.payload as P);
    },
    take: (kind, n, read) => share.take(kind, n, read),
    bodyNames: (waterBodyId) => {
      // Keyed apart from a row's id: the list is read by its body, through its index.
      const key = `bodyNames:${waterBodyId}`;
      const seen = isQuery ? (SEEN.get(ctx) ?? new Map<string, Promise<unknown>>()) : null;
      const known = seen?.get(key);
      if (known) return known as Promise<Doc<'bodyNameLists'> | null>;
      const read = share.read('bodyNames', () =>
        ctx.db
          .query('bodyNameLists')
          .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId))
          .first(),
      );
      if (seen) {
        seen.set(key, read);
        SEEN.set(ctx, seen);
      }
      return read;
    },
  };
}
