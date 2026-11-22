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
 *   verdicts of their own. On an access alert the one verdict is a moderator's retraction recorded
 *   on an alert its author already retracted (`accessAlerts.retract`).
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
 * item's erasure clock (`lib/eraseClock`) — and the item's withdrawal row's `held`
 * (`lib/withdrawals.refreshWithdrawalHold`), which sends it from the Deleted list to Standing and back.
 *
 * {@link replayStep} is the same rules over an item's audit history, a row at a time, for the
 * backfill (`contentRecord.replayVerdictHistory`). An undo's undone row is the one before it on the
 * item — undo is only ever offered on an item's newest row, and a member a Post's undo moves is moved
 * only while the Post's row is still the newest on it.
 *
 * Staff-only, and never reputation: nothing here feeds a skater-facing read or a score.
 */
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { holdMoved } from './eraseClock';
export { VERDICT_TABLE } from './verdictTargets';
import { refreshWithdrawalHold } from './withdrawals';

export type VerdictTargetType = Doc<'contentVerdicts'>['targetType'];
type ContentDoc =
  | Doc<'reports'>
  | Doc<'posts'>
  | Doc<'comments'>
  | Doc<'hazards'>
  | Doc<'accessAlerts'>
  | Doc<'photos'>;

/** Whose content a moderated item is: an author, a filer, or a photo's uploader. */
export function subjectOf(targetType: VerdictTargetType, target: ContentDoc): Id<'profiles'> {
  if (targetType === 'photo') return (target as Doc<'photos'>).uploaderId;
  return targetType === 'hazard' || targetType === 'accessAlert'
    ? (target as Doc<'hazards'> | Doc<'accessAlerts'>).createdByUserId
    : (target as Doc<'reports'> | Doc<'posts'> | Doc<'comments'>).authorId;
}

/** The verdict a moderator's audit row puts on the record, by its action. */
export function verdictKindOf(action: string): 'hidden' | 'removed' | 'retracted' {
  return action === 'hide' ? 'hidden' : action === 'retract_access_alert' ? 'retracted' : 'removed';
}

/** A person's standing verdicts counted at most, for the People page's Hidden content row. */
export const VERDICT_COUNT_CAP = 500;

/** Each kind's count, every one zero — the record's counts by kind start here. */
export function zeroByKind(): Record<VerdictTargetType, number> {
  return { report: 0, post: 0, comment: 0, hazard: 0, accessAlert: 0, photo: 0 };
}

/**
 * How much of a person's content stands under a verdict, by kind — the People page's *Hidden
 * content* row ("5 items · 2 reports · 2 comments"). Read from the same range `personVerdicts` pages
 * through (`by_subject_standing`), so the counts and the list agree; `capped` past
 * {@link VERDICT_COUNT_CAP}, when each count is a floor.
 */
export async function readVerdictCounts(
  ctx: QueryCtx,
  subjectUserId: Id<'profiles'>,
): Promise<{ total: number; byKind: Record<VerdictTargetType, number>; capped: boolean }> {
  const rows = await ctx.db
    .query('contentVerdicts')
    .withIndex('by_subject_standing', (q) =>
      q.eq('subjectUserId', subjectUserId).eq('standing', true),
    )
    .take(VERDICT_COUNT_CAP + 1);
  const counted = rows.slice(0, VERDICT_COUNT_CAP);
  const byKind = zeroByKind();
  for (const row of counted) byKind[row.targetType]++;
  return { total: counted.length, byKind, capped: rows.length > VERDICT_COUNT_CAP };
}

/** Standing verdicts read per page — the writers keep at most one standing on an item. */
const STANDING_PAGE = 16;

/** The standing verdicts on one item, a page of them (the writers keep at most one). */
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
    .take(STANDING_PAGE);
}

/**
 * The kind of the decision standing on one item, or `null` with none — what the record's rule reads
 * as `heldAs` (`lib/recordRules`). One row: the writers keep at most one standing on an item.
 */
export async function heldKindOn(
  ctx: QueryCtx,
  targetType: VerdictTargetType,
  targetId: string,
): Promise<Doc<'contentVerdicts'>['kind'] | null> {
  const standing = await ctx.db
    .query('contentVerdicts')
    .withIndex('by_target_standing', (q) =>
      q.eq('targetType', targetType).eq('targetId', targetId).eq('standing', true),
    )
    .first();
  return standing?.kind ?? null;
}

/**
 * End **every** standing verdict on an item, without touching its clock (the callers below do). Read
 * a page at a time until none is left — each one ended leaves the range, so this ends — never "the
 * first few": a verdict a reversal missed would stay on the person's record. `superseded`: ended by a
 * later verdict (it leaves the record sheet), or by a reversal (it is the item's newest, Reversed).
 */
async function endStanding(
  ctx: MutationCtx,
  targetType: VerdictTargetType,
  targetId: string,
  { actionId, at }: { actionId: Id<'moderationActions'>; at: number },
  superseded: boolean,
): Promise<number> {
  let ended = 0;
  for (;;) {
    const standing = await standingVerdictsOn(ctx, targetType, targetId);
    if (standing.length === 0) return ended;
    for (const verdict of standing) {
      await ctx.db.patch(verdict._id, {
        standing: false,
        endedAt: at,
        endedByActionId: actionId,
        superseded,
      });
    }
    ended += standing.length;
  }
}

/**
 * Whether an ended verdict shows on the record sheet's Reversed list — **the one predicate** (D267): a
 * decision a moderator ended, shown once, as the item's newest decision. A hide that later became a
 * removal is the removal, and never also a Reversed hide; an item restored, hidden again and restored
 * again shows its last restore. `contentRecord`'s Reversed reads take exactly these rows by index
 * (`by_subject_reversed`, `by_subject_reversed_type`), and `recordSheet.test.ts` holds every row the
 * range yields to this predicate and every row it holds to the range. Showing superseded decisions
 * too (the founder's open question) changes this predicate and that range together — over every
 * ended verdict, which wants a kind index of its own.
 */
export function isReversed(
  verdict: Pick<Doc<'contentVerdicts'>, 'standing' | 'endedAt' | 'superseded'>,
): boolean {
  if (verdict.standing || verdict.endedAt === undefined) return false;
  return verdict.superseded === false;
}

/**
 * Mark an item's newest verdict — standing or ended — superseded, as a later one is about to be
 * minted: the writers keep at most one unsuperseded verdict on an item, so a page at a time until
 * none is left (each one marked leaves the range).
 */
async function supersedeNewest(
  ctx: MutationCtx,
  targetType: VerdictTargetType,
  targetId: string,
): Promise<void> {
  for (;;) {
    const newest = await ctx.db
      .query('contentVerdicts')
      .withIndex('by_target_superseded', (q) =>
        q.eq('targetType', targetType).eq('targetId', targetId).eq('superseded', false),
      )
      .take(STANDING_PAGE);
    if (newest.length === 0) return;
    for (const verdict of newest) await ctx.db.patch(verdict._id, { superseded: true });
  }
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
  const count = await endStanding(ctx, targetType, targetId, ended, false);
  if (count > 0) {
    await holdMoved(ctx, targetType, targetId, ended.at);
    // Nothing holds it on the record now: a withdrawn item goes back to Deleted (`lib/withdrawals`).
    await refreshWithdrawalHold(ctx, targetType, targetId);
  }
  return count;
}

export interface VerdictEntry {
  subjectUserId: Id<'profiles'>;
  targetType: VerdictTargetType;
  targetId: string;
  actionId: Id<'moderationActions'>;
  kind: 'hidden' | 'removed' | 'retracted';
  at: number;
}

/** Put a moderator's hide or remove on the person's record, superseding any standing verdict. */
export async function recordVerdict(ctx: MutationCtx, entry: VerdictEntry): Promise<void> {
  await endStanding(
    ctx,
    entry.targetType,
    entry.targetId,
    { actionId: entry.actionId, at: entry.at },
    true,
  );
  // An earlier decision a moderator reversed is no longer the item's newest either.
  await supersedeNewest(ctx, entry.targetType, entry.targetId);
  await ctx.db.insert('contentVerdicts', { ...entry, standing: true, superseded: false });
  await holdMoved(ctx, entry.targetType, entry.targetId, entry.at);
  // A decision holds it now: a withdrawn item is Standing's, not Deleted's (`lib/withdrawals`).
  await refreshWithdrawalHold(ctx, entry.targetType, entry.targetId);
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
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  // An alert's only verdict on the record: a moderator's retraction of one its author had already
  // retracted, kept as evidence. Their retraction of a live alert is their call on the claim, as
  // before, and not on the person's record.
  if (row.action === 'retract_access_alert') return meta.onAuthorWithdrawn === true;
  if (!['hide', 'remove', 'restore', 'overturn_verdict'].includes(row.action)) return false;
  if (meta.derivedFromReportId !== undefined) return false;
  return meta.cascadedFromPostId === undefined || meta.chosen === true;
}

/** One verdict as a replay of the item's history leaves it. */
export interface ReplayedVerdict {
  actionId: Id<'moderationActions'>;
  kind: 'hidden' | 'removed' | 'retracted';
  at: number;
  standing: boolean;
  endedAt?: number;
  endedByActionId?: Id<'moderationActions'>;
  /** A later verdict on the item was minted (see the schema's `superseded`). */
  superseded: boolean;
}

/** The item's newest verdict when a moderator reversed it: ended, and not yet superseded. */
export interface ReplayReversed {
  actionId: Id<'moderationActions'>;
  kind: 'hidden' | 'removed' | 'retracted';
  at: number;
  endedAt: number;
  endedByActionId: Id<'moderationActions'>;
}

/**
 * Where a replay stands between two audit rows: the one verdict standing (a moving row ends every
 * standing verdict and mints at most one, so there is never more than one), and whether the row just
 * replayed ended one — what an undo taking the item back down asks of the row before it. Small and
 * fixed-size, so a replay can carry it from one transaction to the next.
 */
export interface ReplayState {
  standing: {
    actionId: Id<'moderationActions'>;
    kind: 'hidden' | 'removed' | 'retracted';
    at: number;
  } | null;
  previousEnded: boolean;
  /**
   * The item's newest verdict when a moderator reversed it — never beside a standing one — so the row
   * that mints the next verdict can mark it superseded. Absent in a state carried from before the
   * flag existed: read as none.
   */
  reversed?: ReplayReversed | null;
}

export const REPLAY_START: ReplayState = { standing: null, previousEnded: false, reversed: null };

/**
 * What one audit row does to the replay: the verdict it ends, the one it mints, an earlier reversed
 * verdict it supersedes (written again, marked), and the state after.
 */
export function replayStep(
  state: ReplayState,
  row: Doc<'moderationActions'>,
): {
  state: ReplayState;
  ended: ReplayedVerdict | null;
  minted: boolean;
  superseding: ReplayedVerdict | null;
} {
  if (!movesVerdict(row))
    return {
      state: { ...state, previousEnded: false },
      ended: null,
      minted: false,
      superseding: null,
    };
  const takedown =
    row.action === 'hide' || row.action === 'remove' || row.action === 'retract_access_alert';
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const forward = row.undoesActionId === undefined && meta.cascadedFromPostId === undefined;
  const minted = takedown && (forward || state.previousEnded);
  const ended: ReplayedVerdict | null = state.standing
    ? {
        ...state.standing,
        standing: false,
        endedAt: row.createdAt,
        endedByActionId: row._id,
        superseded: minted,
      }
    : null;
  const reversed = state.reversed ?? null;
  const superseding: ReplayedVerdict | null =
    minted && reversed ? { ...reversed, standing: false, superseded: true } : null;
  return {
    state: {
      standing: minted
        ? { actionId: row._id, kind: verdictKindOf(row.action), at: row.createdAt }
        : null,
      previousEnded: ended !== null,
      reversed: minted
        ? null
        : ended
          ? {
              actionId: ended.actionId,
              kind: ended.kind,
              at: ended.at,
              endedAt: row.createdAt,
              endedByActionId: row._id,
            }
          : reversed,
    },
    ended,
    minted,
    superseding,
  };
}
