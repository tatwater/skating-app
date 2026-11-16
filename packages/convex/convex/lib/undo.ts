/**
 * The undo engine (D226, B01 §11).
 *
 * `lib/undoPolicy.ts` says what undoes each verb; this decides whether *this* row can be undone by
 * *this* person right now, and runs it:
 *
 * - **Already undone** — a row whose `undoesActionId` points at it exists.
 * - **Overtaken** — a later row on the same target exists ("a later write means no undo", the
 *   founder's call): History links to what overtook it instead of offering Undo.
 * - **Capability** — the undoer must hold the inverse's capability (D217); it is never offered
 *   otherwise.
 * - **Reason** — asked only when the value the undo puts back takes something away from skaters.
 *
 * The undo itself runs the inverse verb's own helper inside {@link asUndoOf}, so its side effects run
 * and every row it writes is tagged as the undo.
 */

import { isLeaving } from '@skating/core';
import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { asUndoOf, composed, fitComposed } from './audit';
import { hasCapability } from './auth';
import { authorDeletedRefusal, contentFactsOn } from './authorDeletion';
import { seesLedgerGrants } from './ledgerEditors';
import { ownContentRefusal } from './ownContent';
import { type PersonWrite, refusalFor, writeRefusal } from './peopleCan';
import { factsOfRow, personRowOf, rowlessProfile } from './peopleRows';
import { ROW_MAX, requestBudget } from './readBudget';
import { UNDO_HANDLERS } from './undoHandlers';
import { UNDO_POLICY, type UndoRule, undoCapability, WORKSTREAM_MODE } from './undoPolicy';
import { UNDO_CHECKED_ELSEWHERE, undoReader } from './undoReads';
import { meta, type UndoHandler, type UndoScope, type UndoViewer } from './undoTypes';

/** How long after acting the toast offers its undo (D226). History has no limit. */
export const TOAST_UNDO_MS = 10_000;

export type UndoState =
  | { state: 'available'; needsReason: boolean }
  | { state: 'undone'; byActionId: Id<'moderationActions'> }
  | { state: 'overtaken'; byActionId: Id<'moderationActions'> }
  | { state: 'unavailable'; why: string };

/** The handler for a row, if its verb is undoable in this build. */
function handlerFor(row: Doc<'moderationActions'>): UndoHandler | null {
  return UNDO_HANDLERS[row.action] ?? null;
}

/**
 * How many rows tagged with one undo are read to find that undo's own row. An undo tags every row it
 * writes (`asUndoOf`): a Post's undo writes a row per member it moves (at most ten), then the Post's
 * own, so this covers the largest undo with room to spare.
 */
const UNDO_TAG_READ = 16;

/**
 * The row that undid `row`, if one did: **the undo's own row on the same target**, not the first row
 * the undo happened to write. An undo writes its cascade first (a Post's undo moves its members, each
 * with a row tagged as undoing the Post's), and its own row last, so the newest tagged row on the
 * target is the one. With no tagged row on the target in the read, the newest tagged row stands in:
 * it still says the row was undone, which is what the state decides. `lib/undoChains` follows a
 * chain of undos link by link through this.
 */
export async function undoRowOf(
  ctx: QueryCtx | MutationCtx,
  row: Doc<'moderationActions'>,
): Promise<Doc<'moderationActions'> | null> {
  const tagged = await ctx.db
    .query('moderationActions')
    .withIndex('by_undoes', (q) => q.eq('undoesActionId', row._id))
    .order('desc')
    .take(UNDO_TAG_READ);
  return (
    tagged.find((r) => r.targetType === row.targetType && r.targetId === row.targetId) ??
    tagged[0] ??
    null
  );
}

const NEWEST = new WeakMap<object, Map<string, Promise<Doc<'moderationActions'> | null>>>();

/**
 * The newest audit row on a target — read once a query however many History lines ask (a mutation
 * reads afresh: its own writes move it).
 */
function newestOnTarget(
  ctx: QueryCtx | MutationCtx,
  targetType: Doc<'moderationActions'>['targetType'],
  targetId: string,
): Promise<Doc<'moderationActions'> | null> {
  const read = () =>
    ctx.db
      .query('moderationActions')
      .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
      .order('desc')
      .first();
  if ('insert' in ctx.db) return read();
  const seen = NEWEST.get(ctx) ?? new Map<string, Promise<Doc<'moderationActions'> | null>>();
  NEWEST.set(ctx, seen);
  const key = `${targetType}\u0001${targetId}`;
  let found = seen.get(key);
  if (found === undefined) {
    found = read();
    seen.set(key, found);
  }
  return found;
}

/**
 * Whether `row` can be undone by `viewer`, and if not, why — {@link undoStates} for one row. `list`
 * unless the caller says the row is the one in view (`one`: the toast, `runUndo`) — so a page that
 * still asks row by row (People's) never runs a refusal only a single view can afford.
 */
export async function undoState(
  ctx: QueryCtx | MutationCtx,
  viewer: UndoViewer,
  row: Doc<'moderationActions'>,
  scope: UndoScope = 'list',
  /** `write`: the undo itself, whose refusal says why in full (the write's own words, D252). */
  audience: Audience = 'read',
): Promise<UndoState> {
  return (await undoStates(ctx, viewer, [row], scope, audience))[0] as UndoState;
}

/** Who reads a refusal: a page (`read`), or the undo's own write, which says why in full. */
type Audience = 'read' | 'write';

/**
 * A person-rule refusal as `viewer` may read it: the last-editor sentence names who holds the ledger,
 * a holder's to read (as on the person page) — or the undo's own write, which keeps its words.
 */
function personRefusalFor(why: string, viewer: UndoViewer, audience: Audience): string {
  return refusalFor(why, audience === 'write' || seesLedgerGrants(viewer));
}

/**
 * **Whether each row of a page can be undone by `viewer`, and if not, why** (B01-3h) — the one
 * reading every History, feed and People page takes for its rows, in a handful of rounds whatever the
 * page's length:
 *
 * 1. Every row at once, up to its refusal: the policy and the handler (no read), then the undoing
 *    row and the target's newest together (the newest once a query per target), the blocked rule,
 *    an author's deletion, a person's write rule, the viewer's capability and leaving. A person with
 *    no People row yet has their profile read from the request's budget **in page order**, after
 *    every row's first step, so which ones the budget reaches never depends on settling order.
 * 2. The rows still standing whose verb checks the row as it stands, **in page order**, in waves
 *    over the request's budget (`ReadBudget.waves`): each refusal reserves its declared worst case
 *    before it reads; the rows past what the budget can reserve say "check elsewhere"
 *    ({@link UNDO_CHECKED_ELSEWHERE}). Which ones depends only on the data, never on which promise
 *    settles first — the same page every time.
 */
export async function undoStates(
  ctx: QueryCtx | MutationCtx,
  viewer: UndoViewer,
  rows: readonly Doc<'moderationActions'>[],
  /** `one` where a single target is in view (its refusals may read more); a page is a `list`. */
  scope: UndoScope = 'list',
  audience: Audience = 'read',
): Promise<UndoState[]> {
  const before = await Promise.all(
    rows.map((row) => stateBeforeRefusal(ctx, viewer, row, audience)),
  );
  // Started in page order, all at once: `rowlessProfile` charges as it starts, so the same page
  // reads the same people whatever order the first step's reads settled in.
  const first = await Promise.all(
    before.map((state) =>
      'rowless' in state ? afterRowlessProfile(ctx, viewer, state, audience) : state,
    ),
  );
  const out = new Array<UndoState>(rows.length);
  const pending: { index: number; row: Doc<'moderationActions'>; handler: UndoHandler }[] = [];
  first.forEach((state, index) => {
    const row = rows[index] as Doc<'moderationActions'>;
    if ('handler' in state) {
      if (state.handler.refusal) pending.push({ index, row, handler: state.handler });
      else out[index] = { state: 'available', needsReason: undoNeedsReason(row) };
    } else out[index] = state;
  });
  const checked = await requestBudget(ctx).waves(
    pending,
    ({ handler }) => handler.refusalCost?.(scope) ?? { bytes: ROW_MAX.waterBody, reads: 1 },
    async ({ row, handler }, share): Promise<UndoState> => {
      const why = (await handler.refusal?.(ctx, row, undoReader(ctx, share, scope))) ?? null;
      return why
        ? { state: 'unavailable', why }
        : { state: 'available', needsReason: undoNeedsReason(row) };
    },
    (): UndoState => ({ state: 'unavailable', why: UNDO_CHECKED_ELSEWHERE }),
  );
  pending.forEach(({ index }, k) => {
    out[index] = checked[k] as UndoState;
  });
  return out;
}

/** A row's undo state up to its refusal check: decided, or its handler, still to check. */
type Standing = UndoState | { handler: UndoHandler };
/** A person with no People row yet: their write rule waits on their profile; past it, `rest`. */
interface RowlessPending {
  rowless: Id<'profiles'>;
  write: () => PersonWrite;
  rest: Standing;
}

/** A rowless person's write rule, on their profile read from the request's budget. */
async function afterRowlessProfile(
  ctx: QueryCtx | MutationCtx,
  viewer: UndoViewer,
  pending: RowlessPending,
  audience: Audience,
): Promise<Standing> {
  const target = await rowlessProfile(ctx, pending.rowless);
  // Once a page of such rows has spent the budget, the rest say so rather than read past the limit.
  if (target === undefined) return { state: 'unavailable', why: UNDO_NEEDS_ROWS };
  if (!target) return { state: 'unavailable', why: 'This account no longer exists.' };
  const why = await writeRefusal(ctx, viewer, target, pending.write());
  return why !== null
    ? { state: 'unavailable', why: personRefusalFor(why, viewer, audience) }
    : pending.rest;
}

/** A row's undo state up to its refusal check, or up to a rowless person's profile read. */
async function stateBeforeRefusal(
  ctx: QueryCtx | MutationCtx,
  viewer: UndoViewer,
  row: Doc<'moderationActions'>,
  audience: Audience,
): Promise<Standing | RowlessPending> {
  const rule = UNDO_POLICY[row.action];
  if (rule.undo.kind === 'none') return { state: 'unavailable', why: rule.undo.why };
  if (rule.undo.kind === 'later') {
    return {
      state: 'unavailable',
      why: `Undo for this arrives with ${WORKSTREAM_MODE[rule.undo.workstream]}.`,
    };
  }
  const handler = handlerFor(row);
  if (!handler) return { state: 'unavailable', why: 'Undo for this is not built yet.' };

  // Both reads at once, and a target's newest row once a query, however many lines share it (B01-3h).
  const [undoneBy, newest] = await Promise.all([
    undoRowOf(ctx, row),
    newestOnTarget(ctx, row.targetType, row.targetId),
  ]);
  if (undoneBy) return { state: 'undone', byActionId: undoneBy._id };
  if (newest && newest._id !== row._id && newest._creationTime > row._creationTime) {
    return { state: 'overtaken', byActionId: newest._id };
  }

  const blocked = handler.blocked?.(row, viewer) ?? null;
  if (blocked) return { state: 'unavailable', why: blocked };
  // Content its author deleted stays as the deletion left it (D248). The author's own row usually
  // overtakes the takedown above; a withdrawal stamped with no row of its own (a backfill) doesn't,
  // so the undo would be offered and then refused — read the stamp, and give the refusal here. The
  // same read says who wrote it: an undo is a decision on it, never its author's (D269) — rows
  // from before that rule, where a moderator acted on their own content, included.
  const content = await contentFactsOn(ctx, row.targetType, row.targetId);
  if (content.authorDeletedAt !== undefined) {
    return { state: 'unavailable', why: authorDeletedRefusal(meta(row).priorStatus, true) };
  }
  const own = ownContentRefusal(viewer, content.authorId);
  if (own !== null) return { state: 'unavailable', why: own };
  // A change to a person is refused through the same rule its forward write uses (`lib/peopleCan`):
  // an account being deleted, or deleted, can't be disciplined back or forth — so History never
  // offers an undo the write would turn down. Someone with no People row yet is decided after
  // every row's first step, in page order (`undoStates`); what follows stands once they pass.
  const person = await personUndoRefusal(ctx, viewer, row, handler);
  if (typeof person === 'string') {
    return { state: 'unavailable', why: personRefusalFor(person, viewer, audience) };
  }
  const rest = afterPersonRule(viewer, rule, row, handler);
  return person === null ? rest : { ...person, rest };
}

/** The checks after a person's write rule: the viewer's capability and leaving, then the refusal. */
function afterPersonRule(
  viewer: UndoViewer,
  rule: UndoRule,
  row: Doc<'moderationActions'>,
  handler: UndoHandler,
): Standing {
  if (!hasCapability(viewer, undoCapability(rule, row.targetType))) {
    return { state: 'unavailable', why: 'Undoing this takes a role you do not hold.' };
  }
  // Every undo is a write, and a write is refused to an operator on their way out (D62) — so it is
  // never offered to one either, or History would draw a button the server turns down.
  if (isLeaving(viewer)) {
    return {
      state: 'unavailable',
      why: 'Your account is being deleted, so you can no longer undo.',
    };
  }
  // The row as it stands now may refuse this write (B01-3d) — asked last, in the page's waves
  // (`undoStates`): it reads a body's outline at worst, from the page's shared budget, which a line
  // this viewer could never undo anyway should not spend.
  return { handler };
}

/**
 * Whether undoing `row` will ask a reason (D226): the undo of a give-back takes something away, so it
 * asks; the undo of a take-away gives back, so it doesn't. The one rule — `undoStates` (so
 * `undo.latestOwn` and `undo.run`) answers by it, and every person write returns it beside its row,
 * so the console's toast needs no lookup. `false` for a row with no undo.
 */
export function undoNeedsReason(row: Doc<'moderationActions'>): boolean {
  const kind = UNDO_POLICY[row.action].undo.kind;
  if (kind === 'none' || kind === 'later') return false;
  return handlerFor(row)?.undoTakesAway(row) ?? false;
}

/** Why an undo on someone without a People row can't be checked on this page (before the backfill). */
export const UNDO_NEEDS_ROWS =
  'This can be checked once the People rows are built; open the person to undo it.';

/**
 * Why an undo on a person can't run now: the refusal the forward write of the state it puts back
 * would give (`writeRefusal`, on the handler's own `personWrite`) — one rule, never a parallel list.
 * The person's facts come from their light People row (a profile can weigh a whole document, and
 * History asks once a line); a person with no row yet is read in full — not here, but by
 * {@link afterRowlessProfile}, in page order, so the profiles a page's budget reaches are the same
 * every time.
 */
async function personUndoRefusal(
  ctx: QueryCtx | MutationCtx,
  viewer: UndoViewer,
  row: Doc<'moderationActions'>,
  handler: UndoHandler,
): Promise<string | null | Omit<RowlessPending, 'rest'>> {
  const personWrite = handler.personWrite;
  if (row.targetType !== 'user' || personWrite === undefined) return null;
  const id = ctx.db.normalizeId('profiles', row.targetId);
  if (!id) return 'This account no longer exists.';
  const light = await personRowOf(ctx, id);
  // Someone with no row yet (before the rows backfill) is read in full, charged to the request's
  // budget; a query reads each such person once, however many rows name them.
  if (!light) return { rowless: id, write: () => personWrite(row) };
  return writeRefusal(ctx, viewer, factsOfRow(light), personWrite(row));
}

/** Undo `actionId` as `actor` (already gated by the caller), with `reason` when one is needed. */
export async function runUndo(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  actionId: Id<'moderationActions'>,
  reason: string | undefined,
): Promise<void> {
  const row = await ctx.db.get(actionId);
  if (!row) throw new ConvexError('That action no longer exists');
  const state = await undoState(ctx, actor, row, 'one', 'write');
  switch (state.state) {
    case 'undone':
      throw new ConvexError('That action has already been undone');
    case 'overtaken':
      throw new ConvexError('Something changed this since; open its history to see what');
    case 'unavailable':
      throw new ConvexError(state.why);
  }
  const trimmed = reason?.trim() ?? '';
  if (state.needsReason && trimmed.length === 0) {
    throw new ConvexError('Undoing this takes something away from skaters, so it needs a reason');
  }
  const handler = handlerFor(row);
  if (!handler) throw new ConvexError('Undo for this is not built yet');
  // The default quotes the row's own reason — stored text, up to the cap (or past it, on a row from
  // before D261) — so it is composed and fitted here: an undo nobody typed a reason for never fails
  // on the length of the reason it quotes. A reason the person typed is theirs, held to the cap as is.
  const why =
    trimmed.length > 0
      ? trimmed
      : fitComposed(composed`Undid ${row.action.replace(/_/g, ' ')}: ${row.reason}`);
  await asUndoOf(ctx, actionId, () => handler.run({ ctx, actor, row, reason: why }));
}
