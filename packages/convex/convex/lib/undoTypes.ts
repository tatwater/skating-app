/**
 * The shapes every undo handler file shares (D226, B01 §11). Kept apart from the handler maps so the
 * per-area handler files (`undoHandlersBody.ts`, `undoHandlersCorpus.ts`) can import them without an
 * import cycle through `undoHandlers.ts`.
 */

import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

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
  run: (call: UndoCall) => Promise<void>;
}

// biome-ignore lint/suspicious/noExplicitAny: metadata is `v.any()` in the schema; each handler reads its own shape.
export type Meta = Record<string, any>;
export const meta = (row: Doc<'moderationActions'>): Meta => (row.metadata ?? {}) as Meta;

export const PREDATES = 'This was done before undo existed, and nothing records what it replaced.';

/** The undo for each shared verb (`hide`, `remove`, `restore`) on one kind of target. */
export type TargetUndo = Partial<Record<'hide' | 'remove' | 'restore', UndoHandler>>;
