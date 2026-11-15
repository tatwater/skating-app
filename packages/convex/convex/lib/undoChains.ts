/**
 * What an undo chain comes to — one rule for every reader of the audit log's undos (B01 §11, D226).
 *
 * An undo is a row that names the row it undoes (`undoesActionId`), and an undo can itself be undone
 * (the engine offers undo on any newest row, an undo's included), so a chain is change → undo →
 * undo of the undo → … . Its net effect: **pairs cancel from the newest end.** An undo stands unless
 * an undo of it stands; a standing undo cancels the row it undoes and itself. So a change undone once
 * is gone, and undone twice is back, with its own time. Decided by the chain's links, never by the
 * rows' times.
 *
 * Every People read that asks "did this stand?" asks here: a staffer's tenure (`people.staffTenure`),
 * "later undone by someone else" and "overturned" (`people.staffStats`).
 */

import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { undoRowOf } from './undo';

type Row = Pick<Doc<'moderationActions'>, '_id' | 'undoesActionId'>;

/**
 * Of `rows`, the ones a standing undo canceled — the undone rows and the undos that undid them. An
 * undo of a row not among `rows` cancels nothing it can see and is canceled by nothing but an undo
 * of it.
 */
export function canceledRows(rows: readonly Row[]): Set<string> {
  const byId = new Set<string>(rows.map((r) => r._id));
  const undosOf = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.undoesActionId === undefined || !byId.has(r.undoesActionId)) continue;
    undosOf.set(r.undoesActionId, [...(undosOf.get(r.undoesActionId) ?? []), r]);
  }
  const standing = new Map<string, boolean>();
  const stands = (r: Row): boolean => {
    const known = standing.get(r._id);
    if (known !== undefined) return known;
    // Provisionally standing, so a malformed cycle ends rather than recursing forever.
    standing.set(r._id, true);
    const result = !(undosOf.get(r._id) ?? []).some(stands);
    standing.set(r._id, result);
    return result;
  };
  const canceled = new Set<string>();
  for (const r of rows) {
    if (r.undoesActionId === undefined || !byId.has(r.undoesActionId) || !stands(r)) continue;
    canceled.add(r._id);
    canceled.add(r.undoesActionId);
  }
  return canceled;
}

/** How deep a chain is followed: undo of undo of … — far past any a person makes. */
const CHAIN_DEPTH = 8;

/**
 * The undo that stands on `row` — its own row on the same target, not canceled by an undo of it —
 * or `null` when nothing undid it, or what undid it was itself undone. Reads the chain from `row`
 * forward a link at a time, each link the engine's own "what undid this" (`lib/undo.undoRowOf`), and
 * decides by {@link canceledRows}.
 */
export async function standingUndoOf(
  ctx: QueryCtx,
  row: Doc<'moderationActions'>,
): Promise<Doc<'moderationActions'> | null> {
  const chain: Doc<'moderationActions'>[] = [row];
  for (let depth = 0; depth < CHAIN_DEPTH; depth++) {
    const next = await undoRowOf(ctx, chain[chain.length - 1] as Doc<'moderationActions'>);
    if (next === null) break;
    chain.push(next);
  }
  return canceledRows(chain).has(row._id) ? (chain[1] ?? null) : null;
}
