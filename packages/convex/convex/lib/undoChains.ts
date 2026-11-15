/**
 * What an undo chain comes to — one rule for every reader of the audit log's undos (B01 §11, D226).
 *
 * An undo is a row that names the row it undoes (`undoesActionId`), and an undo can itself be undone
 * (the engine offers undo on any newest row, an undo's included), so a chain is change → undo →
 * undo of the undo → … . Its net effect: **pairs cancel from the newest end.** The newest undo still
 * standing cancels the row it undoes and itself; a row an already-cancelled undo named stands. So a
 * change undone once is gone, and undone twice is back, with its own time.
 *
 * Every People read that asks "did this stand?" asks here: a staffer's tenure (`people.staffTenure`),
 * "later undone by someone else" and "overturned" (`people.staffStats`).
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';

type Row = Pick<Doc<'moderationActions'>, '_id' | 'undoesActionId' | 'createdAt' | '_creationTime'>;

/**
 * Of `rows`, the ones a standing undo cancelled — the undone rows and the undos that undid them —
 * pairing from the newest undo back. An undo of a row not among `rows` cancels nothing it can see and
 * is cancelled by nothing but a later undo of it.
 */
export function cancelledRows(rows: readonly Row[]): Set<string> {
  const byId = new Set<string>(rows.map((r) => r._id));
  const newestFirst = [...rows].sort(
    (a, b) => b.createdAt - a.createdAt || b._creationTime - a._creationTime,
  );
  const cancelled = new Set<string>();
  for (const row of newestFirst) {
    if (cancelled.has(row._id) || row.undoesActionId === undefined) continue;
    if (!byId.has(row.undoesActionId)) continue;
    cancelled.add(row._id);
    cancelled.add(row.undoesActionId);
  }
  return cancelled;
}

/** How deep a chain is followed: undo of undo of … — far past any a person makes. */
const CHAIN_DEPTH = 8;
/** Undos read per link (an undo writes a row per member it moves, then its own). */
const UNDOS_PER_LINK = 16;

/**
 * The undo that stands on `row` — its own row on the same target, not cancelled by an undo of it —
 * or `null` when nothing undid it, or what undid it was itself undone. Reads the chain from `row`
 * forward, a link at a time, and decides by {@link cancelledRows}.
 */
export async function standingUndoOf(
  ctx: QueryCtx,
  row: Doc<'moderationActions'>,
): Promise<Doc<'moderationActions'> | null> {
  const chain: Doc<'moderationActions'>[] = [row];
  let link: Doc<'moderationActions'> | null = row;
  for (let depth = 0; link !== null && depth < CHAIN_DEPTH; depth++) {
    const at: Doc<'moderationActions'> = link;
    const undos = await ctx.db
      .query('moderationActions')
      .withIndex('by_undoes', (q) => q.eq('undoesActionId', at._id as Id<'moderationActions'>))
      .take(UNDOS_PER_LINK);
    // The undo's own row on the same target (a cascade tags its member rows too).
    const own: Doc<'moderationActions'> | undefined =
      undos.find((u) => u.targetType === at.targetType && u.targetId === at.targetId) ?? undos[0];
    if (own === undefined) break;
    chain.push(own);
    link = own;
  }
  const cancelled = cancelledRows(chain);
  return cancelled.has(row._id) ? (chain[1] ?? null) : null;
}
