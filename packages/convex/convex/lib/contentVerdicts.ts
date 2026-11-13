/**
 * A moderator's verdicts, kept with the person whose content they judged (D248, the founder's
 * ruling of 2026-11-13): "if a user was being rude and their post/comment got restricted by a
 * moderator, they shouldn't be able to delete their comment and thereby remove evidence of their bad
 * behavior, which would influence future penalties."
 *
 * The rules, in one place, so every writer agrees:
 *
 * - **A verdict is a top-level hide or remove by a moderator** — on content still up, or on content
 *   its author already deleted (then the content stays as the deletion left it, and the verdict is
 *   the record). A Post's cascade onto its members and a derived Post hide are consequences, not
 *   verdicts of their own.
 * - **It stands until a moderator reverses it** — a restore (a Post's restore that brings back a
 *   Report the moderator chose included), an undo, or (on content its author has since deleted) an
 *   overturn. The author deleting the content does not clear it.
 * - **A later verdict on the same item supersedes the earlier**, so an item counts once on the
 *   record (a hide that became a remove is one verdict, the remove).
 * - **An undo puts the record back where it was.** Undoing a takedown ends its verdict; an undo that
 *   takes an item back down records a verdict only if the action it undoes had ended one — an item
 *   that was down by a Post's cascade or a derived hide was never on the record.
 *
 * A standing verdict also holds withdrawn content back from erasure, so every write here moves the
 * item's erasure clock (`lib/eraseClock`).
 *
 * {@link replayVerdicts} is the same rules over an item's audit history, for the backfill.
 *
 * Staff-only, and never reputation: nothing here feeds a skater-facing read or a score.
 */
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { holdMoved } from './eraseClock';

export type VerdictTargetType = Doc<'contentVerdicts'>['targetType'];
type ContentDoc = Doc<'reports'> | Doc<'posts'> | Doc<'comments'> | Doc<'hazards'>;

/** Whose content a moderated item is. */
export function subjectOf(targetType: VerdictTargetType, target: ContentDoc): Id<'profiles'> {
  return targetType === 'hazard'
    ? (target as Doc<'hazards'>).createdByUserId
    : (target as Doc<'reports'> | Doc<'posts'> | Doc<'comments'>).authorId;
}

/** The standing verdicts on one item — at most a couple; bounded anyway. */
export function standingVerdictsOn(
  ctx: QueryCtx,
  targetType: VerdictTargetType,
  targetId: string,
): Promise<Doc<'contentVerdicts'>[]> {
  return ctx.db
    .query('contentVerdicts')
    .withIndex('by_target_standing', (q) =>
      q.eq('targetType', targetType).eq('targetId', targetId).eq('standing', true),
    )
    .take(10);
}

/** End every standing verdict on an item, without touching its clock (the callers below do). */
async function endStanding(
  ctx: MutationCtx,
  targetType: VerdictTargetType,
  targetId: string,
  { actionId, at }: { actionId: Id<'moderationActions'>; at: number },
): Promise<number> {
  const standing = await standingVerdictsOn(ctx, targetType, targetId);
  for (const verdict of standing) {
    await ctx.db.patch(verdict._id, { standing: false, endedAt: at, endedByActionId: actionId });
  }
  return standing.length;
}

/**
 * End every standing verdict on an item — reversed by a restore, an undo or an overturn — and let
 * its erasure clock run again if nothing else holds it.
 */
export async function endVerdicts(
  ctx: MutationCtx,
  targetType: VerdictTargetType,
  targetId: string,
  ended: { actionId: Id<'moderationActions'>; at: number },
): Promise<number> {
  const count = await endStanding(ctx, targetType, targetId, ended);
  if (count > 0) await holdMoved(ctx, targetType, targetId, ended.at);
  return count;
}

export interface VerdictEntry {
  subjectUserId: Id<'profiles'>;
  targetType: VerdictTargetType;
  targetId: string;
  actionId: Id<'moderationActions'>;
  kind: 'hidden' | 'removed';
  at: number;
}

/** Put a moderator's hide or remove on the person's record, superseding any standing verdict. */
export async function recordVerdict(ctx: MutationCtx, entry: VerdictEntry): Promise<void> {
  await endStanding(ctx, entry.targetType, entry.targetId, {
    actionId: entry.actionId,
    at: entry.at,
  });
  await ctx.db.insert('contentVerdicts', { ...entry, standing: true });
  await holdMoved(ctx, entry.targetType, entry.targetId, entry.at);
}

/**
 * An undo taking an item back down (to `entry.kind`): the undone action's own verdict ends, and a
 * verdict is recorded only if the undone action had ended one — undoing a restore of a Post that
 * was hidden because its Reports were, or a removal of a Report its Post's hide took down, puts
 * nothing on the record that no moderator decided.
 */
export async function recordUndoneVerdict(
  ctx: MutationCtx,
  entry: VerdictEntry,
  undoneActionId: Id<'moderationActions'>,
): Promise<void> {
  const endedOne = await ctx.db
    .query('contentVerdicts')
    .withIndex('by_ended_by', (q) => q.eq('endedByActionId', undoneActionId))
    .first();
  if (endedOne) await recordVerdict(ctx, entry);
  else await endVerdicts(ctx, entry.targetType, entry.targetId, entry);
}

/**
 * Whether an audit row moves an item's verdict: a moderator's own hide, remove, restore or overturn
 * of it — or a Post's restore bringing back a member the moderator chose, and that choice's undo.
 * A Post's plain cascade, a derived Post change, the system's rows and the author's own are not.
 */
export function movesVerdict(row: Doc<'moderationActions'>): boolean {
  if (row.actorId === undefined) return false;
  if (!['hide', 'remove', 'restore', 'overturn_verdict'].includes(row.action)) return false;
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  if (meta.derivedFromReportId !== undefined) return false;
  return meta.cascadedFromPostId === undefined || meta.chosen === true;
}

/** One verdict as a replay of the item's history leaves it. */
export interface ReplayedVerdict {
  actionId: Id<'moderationActions'>;
  kind: 'hidden' | 'removed';
  at: number;
  standing: boolean;
  endedAt?: number;
  endedByActionId?: Id<'moderationActions'>;
}

/**
 * The live writers' rules over one item's audit rows, oldest first: what verdicts its history
 * makes, and which still stand. An undo's undone row is the one before it on the item — undo is
 * only ever offered on an item's newest row, and a member a Post's undo moves is moved only while
 * the Post's row is still the newest on it.
 */
export function replayVerdicts(rows: Doc<'moderationActions'>[]): ReplayedVerdict[] {
  const verdicts: ReplayedVerdict[] = [];
  const endedSomething = new Set<string>();
  let previous: Doc<'moderationActions'> | undefined;
  for (const row of rows) {
    if (movesVerdict(row)) {
      const takedown = row.action === 'hide' || row.action === 'remove';
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const forward = row.undoesActionId === undefined && meta.cascadedFromPostId === undefined;
      const mints =
        takedown &&
        (forward || (previous !== undefined && endedSomething.has(previous._id as string)));
      for (const verdict of verdicts) {
        if (!verdict.standing) continue;
        verdict.standing = false;
        verdict.endedAt = row.createdAt;
        verdict.endedByActionId = row._id;
        endedSomething.add(row._id as string);
      }
      if (mints) {
        verdicts.push({
          actionId: row._id,
          kind: row.action === 'hide' ? 'hidden' : 'removed',
          at: row.createdAt,
          standing: true,
        });
      }
    }
    previous = row;
  }
  return verdicts;
}
