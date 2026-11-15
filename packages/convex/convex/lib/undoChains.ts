/**
 * What an undo chain comes to — one rule for every reader of the audit log's undos (B01 §11, D226).
 *
 * An undo can itself be undone (the engine offers undo on any newest row, an undo's included, and
 * each row is undone at most once), so a chain is a line: change → undo → undo of the undo → … .
 * Its net effect: **the undos above a row cancel in pairs** — a change undone once is gone, undone
 * twice is back, with its own time. The chain's place is kept at the write (`lib/audit.ts`): every
 * undo row carries its chain's first row (`undoRoot`) and its depth (`undoDepth`), and the first row
 * carries the newest depth (`undoTop`) and who wrote it (`undoTopActorId`). So no read walks a chain:
 * a row and its chain's first row decide it, at any length.
 *
 * Every People read that asks "did this stand?" asks here: a staffer's tenure, "later undone by
 * someone else" (`people.staffStats`) and "overturned" (`people.staffSeason`). Rows written before
 * the facts existed get them from `peopleJobs.backfillUndoChains`; until it has run
 * (`ready:undoChains`) those figures say they may be short.
 */

import type { Doc, Id } from '../_generated/dataModel';

type ChainRow = Pick<
  Doc<'moderationActions'>,
  '_id' | 'undoesActionId' | 'undoRoot' | 'undoDepth' | 'undoTop' | 'undoTopActorId'
>;

/** The id of the chain's first row a row belongs to (itself, when it is no undo). */
export function chainRootId(row: ChainRow): Id<'moderationActions'> {
  return row.undoRoot ?? row._id;
}

/** Whether `row` stands: the undos above it in its chain are even in number. `root` is its chain's first row. */
export function stands(row: ChainRow, root: ChainRow): boolean {
  return ((root.undoTop ?? 0) - (row.undoDepth ?? 0)) % 2 === 0;
}

/**
 * Who took `row`'s effect away for good — the writer of its chain's newest undo — or `null` when the
 * row stands. `undefined` when the system did (an actorless undo).
 */
export function undoneBy(row: ChainRow, root: ChainRow): Id<'profiles'> | undefined | null {
  return stands(row, root) ? null : root.undoTopActorId;
}

/**
 * Whether `row` is a change in its own right that stands: no undo, and not undone on net. An undo
 * not yet placed (written before chains were kept) is still an undo — never a change of its own.
 */
export function isStandingChange(row: ChainRow, root: ChainRow): boolean {
  return row.undoRoot === undefined && row.undoesActionId === undefined && stands(row, root);
}
