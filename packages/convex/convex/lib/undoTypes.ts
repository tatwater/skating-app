/**
 * The shapes every undo handler file shares (D226, B01 §11). Kept apart from the handler maps so the
 * per-area handler files (`undoHandlersBody.ts`, `undoHandlersCorpus.ts`) can import them without an
 * import cycle through `undoHandlers.ts`.
 */

import type { Doc, Id, TableNames } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { PersonWrite } from './peopleCan';
import type { RowKind, WaveCost } from './readBudget';

/**
 * A refusal's read of one row: the document, or `null` when it is gone — charged to the reservation
 * its row was admitted with, and read once a query however many lines ask.
 */
export type UndoRead = <T extends TableNames>(kind: RowKind, id: Id<T>) => Promise<Doc<T> | null>;

export interface UndoCall {
  ctx: MutationCtx;
  actor: Doc<'profiles'>;
  row: Doc<'moderationActions'>;
  reason: string;
}

/**
 * Who is asking — enough to refuse a self-targeting undo before it is offered, to read a per-person
 * grant a capability needs (D227), and to see an operator on their way out (D62).
 */
export type UndoViewer = Pick<
  Doc<'profiles'>,
  '_id' | 'role' | 'canEditLedger' | 'deletionRequestedAt'
>;

export interface UndoHandler {
  /** Why this row can't be undone — by anyone, or (when it depends on who asks) by `viewer`. */
  blocked?: (row: Doc<'moderationActions'>, viewer?: UndoViewer) => string | null;
  undoTakesAway: (row: Doc<'moderationActions'>) => boolean;
  /**
   * For an undo on a person: the write it runs (the previous state, put back), so its refusal is the
   * one the forward write of that state gives (`lib/peopleCan.writeRefusal`) — what History offers is
   * what the write accepts. The handler's `run` makes this same write.
   */
  personWrite?: (row: Doc<'moderationActions'>) => PersonWrite;
  /**
   * Why running this undo now would be refused, read from the row as it stands (B01-3d): the same
   * refusal the forward write of the recorded state gives, so History never offers an undo the write
   * turns down — after an un-audited change (an import, a loader, a merge's moves) as after any other.
   */
  refusal?: (
    ctx: QueryCtx | MutationCtx,
    row: Doc<'moderationActions'>,
    read: UndoRead,
  ) => Promise<string | null>;
  /**
   * What `refusal` reads at worst, through `read` — reserved before it runs (B01-3h,
   * `ReadBudget.waves`). Absent: one row of a document's weight.
   */
  refusalCost?: WaveCost;
  run: (call: UndoCall) => Promise<void>;
}

// biome-ignore lint/suspicious/noExplicitAny: metadata is `v.any()` in the schema; each handler reads its own shape.
export type Meta = Record<string, any>;
export const meta = (row: Doc<'moderationActions'>): Meta => (row.metadata ?? {}) as Meta;

export const PREDATES = 'This was done before undo existed, and nothing records what it replaced.';

/** The undo for each shared verb (`hide`, `remove`, `restore`) on one kind of target. */
export type TargetUndo = Partial<Record<'hide' | 'remove' | 'restore', UndoHandler>>;
