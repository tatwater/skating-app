/**
 * The one writer of `moderationActions` (B01 §11, D226).
 *
 * Every operator action — and every machine action an operator should be able to check — leaves one
 * audit row. They used to be written by 51 direct inserts across 16 files; they all come through here
 * now, so the row's shape is decided once: who (absent when the system acted), what, on what, why,
 * what it replaced, and — for an undo — which row it undoes. `auditWriters.test.ts` (guards) holds the
 * sources to this file being the only writer.
 */

import { AUDIT_REASON_MAX, AUDIT_REASON_TOO_LONG, isAuditVia } from '@skating/core';
import { ConvexError } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { noteAuditedAction } from './bodyLibrary';
import type { MODERATION_ACTIONS, MODERATION_TARGET_TYPES } from './enums';

export type ModerationAction = (typeof MODERATION_ACTIONS)[number];
export type ModerationTargetType = (typeof MODERATION_TARGET_TYPES)[number];

export interface AuditEntry {
  /** The operator who acted; absent when the system did (A05c / D80). */
  actorId?: Id<'profiles'>;
  action: ModerationAction;
  targetType: ModerationTargetType;
  targetId: string;
  /** Required: accountability for appeals and reversals. */
  reason: string;
  /** Prior and new state, and whatever the verb's undo needs (B01 §11). */
  metadata?: Record<string, unknown>;
  /** Set when this row is the undo of an earlier one (D226). */
  undoesActionId?: Id<'moderationActions'>;
  /** Defaults to now; pass the mutation's own `now` when other rows share it. */
  createdAt?: number;
}

export async function writeAudit(
  ctx: MutationCtx,
  entry: AuditEntry,
): Promise<Id<'moderationActions'>> {
  const { createdAt, ...row } = entry;
  // The one place a reason enters the log (D261): past the cap the whole write is refused, so no
  // writer — a lever, an undo, a script, a job — can store a longer one.
  if (row.reason.length > AUDIT_REASON_MAX) throw new ConvexError(AUDIT_REASON_TOO_LONG);
  const undoesActionId = row.undoesActionId ?? UNDOING.get(ctx);
  const at = createdAt ?? Date.now();
  const via = row.actorId !== undefined ? await viaOf(ctx) : undefined;
  // An undo's place in its chain, and the chain's newest depth on its first row (`lib/undoChains`).
  const chain =
    undoesActionId !== undefined ? await placeInUndoChain(ctx, undoesActionId, row.actorId) : {};
  const id = await ctx.db.insert('moderationActions', {
    ...row,
    ...(undoesActionId !== undefined ? { undoesActionId } : {}),
    ...chain,
    ...(via !== undefined ? { via } : {}),
    createdAt: at,
  });
  // The Bodies library (B01-3): an action on a body, or on something that belongs to one, refreshes
  // that body's library row in this transaction — and a moderator's stamps *Changed*.
  await noteAuditedAction(ctx, {
    actionId: id,
    action: row.action,
    ...(row.actorId !== undefined ? { actorId: row.actorId } : {}),
    targetType: row.targetType,
    targetId: row.targetId,
    createdAt: at,
  });
  return id;
}

/** How many unplaced undos (from before chains were kept) one write places above the row it undoes. */
const LEGACY_HOPS = 32;

/**
 * An undo of `undoneId`: its chain's first row and its depth, and the first row stamped with the
 * chain's new newest depth and who wrote it — two point reads at most, one patch. Every row an undo
 * writes is tagged with the row it undoes (a cascade's member rows too), so they share the depth and
 * the stamp is written once.
 *
 * An undone row that is itself an undo written before chains were kept, and not yet placed by
 * `peopleJobs.backfillUndoChains`, is placed first (its own undone row the same way, up to
 * {@link LEGACY_HOPS}): otherwise it would be taken for a chain's first row, and since the backfill
 * passes over a row already placed, this row's place would stay wrong once the backfill had run.
 */
async function placeInUndoChain(
  ctx: MutationCtx,
  undoneId: Id<'moderationActions'>,
  actorId: Id<'profiles'> | undefined,
  legacyHops = LEGACY_HOPS,
): Promise<{ undoRoot?: Id<'moderationActions'>; undoDepth?: number }> {
  let undone = await ctx.db.get(undoneId);
  if (!undone) return {};
  if (undone.undoesActionId !== undefined && undone.undoRoot === undefined && legacyHops > 0) {
    const place = await placeInUndoChain(
      ctx,
      undone.undoesActionId,
      undone.actorId,
      legacyHops - 1,
    );
    if (place.undoRoot !== undefined) {
      await ctx.db.patch(undone._id, place);
      undone = { ...undone, ...place };
    }
  }
  const rootId = undone.undoRoot ?? undone._id;
  const depth = (undone.undoDepth ?? 0) + 1;
  const root = rootId === undone._id ? undone : await ctx.db.get(rootId);
  if (root && (root.undoTop ?? 0) < depth) {
    await ctx.db.patch(rootId, { undoTop: depth, undoTopActorId: actorId });
  }
  return { undoRoot: rootId, undoDepth: depth };
}

/**
 * The script or agent the caller made this write through (D256), from the `via` claim on their
 * identity, when it passes `isAuditVia`; anything else is dropped, never stored.
 *
 * **Why a claim and not an argument.** A script calls public mutations as a person with
 * `convex run --identity`, which needs the deployment's admin credentials, and puts `via` beside the
 * `subject` there (`@skating/run-log`'s `convexRun`). No mutation takes it as an argument, so no
 * client can pass it, and a signed-in session's token carries only the claims its issuer writes.
 * Even a forged one could do no more than relabel the forger's own row: the actor is still the
 * signed-in person, and nothing reads `via` to decide anything.
 */
async function viaOf(ctx: MutationCtx): Promise<string | undefined> {
  const claim = (await ctx.auth.getUserIdentity())?.via;
  return isAuditVia(claim) ? claim : undefined;
}

/**
 * The undo an in-flight mutation is performing, keyed by its context. An undo runs the inverse verb's
 * own helper, which writes its own audit rows the ordinary way; every row written while `fn` runs is
 * tagged with the row it undoes, so a cascade (a Post's restore bringing back its reports) is tagged
 * too, with no helper having to thread the id through.
 */
const UNDOING = new WeakMap<object, Id<'moderationActions'>>();

export async function asUndoOf<T>(
  ctx: MutationCtx,
  actionId: Id<'moderationActions'>,
  fn: () => Promise<T>,
): Promise<T> {
  UNDOING.set(ctx, actionId);
  try {
    return await fn();
  } finally {
    UNDOING.delete(ctx);
  }
}

// ── Snapshots: what an action replaced, when it is too big for the audit row ─────────────────────

/**
 * Characters of serialized payload per `auditSnapshots` row. A document holds 1 MiB and a character
 * can take up to four bytes in UTF-8, so a fifth of that keeps any part under the limit.
 */
export const SNAPSHOT_PART_CHARS = 200_000;

/**
 * Record what `actionId` replaced (D226, B01 §11): a sub-area's previous outline, a body's previous
 * weather grid, a merge's moved rows. Written in the same mutation as the audit row and read by that
 * row's undo (or, for a merge, by the unmerge §4 owes).
 *
 * A payload that fits is stored as itself, so the dashboard shows it; a bigger one (a merge of a busy
 * body) is serialized and split across ordered `part`s. Either way {@link readSnapshot} returns the
 * payload as written. A stored field may not start with `_` — pass documents through
 * {@link snapshotDoc}. Returns how many parts were written.
 */
export async function writeSnapshot(
  ctx: MutationCtx,
  actionId: Id<'moderationActions'>,
  payload: unknown,
): Promise<number> {
  const json = JSON.stringify(payload);
  const createdAt = Date.now();
  if (json.length <= SNAPSHOT_PART_CHARS) {
    await ctx.db.insert('auditSnapshots', { actionId, part: 0, payload, createdAt });
    return 1;
  }
  const parts = Math.ceil(json.length / SNAPSHOT_PART_CHARS);
  for (let part = 0; part < parts; part++) {
    await ctx.db.insert('auditSnapshots', {
      actionId,
      part,
      payload: {
        chunk: json.slice(part * SNAPSHOT_PART_CHARS, (part + 1) * SNAPSHOT_PART_CHARS),
        of: parts,
      },
      createdAt,
    });
  }
  return parts;
}

type Chunk = { chunk: string; of: number };
const isChunk = (payload: unknown): payload is Chunk =>
  typeof payload === 'object' &&
  payload !== null &&
  typeof (payload as { chunk?: unknown }).chunk === 'string';

/** The payload {@link writeSnapshot} recorded for `actionId`, or `null` when there is none. */
export async function readSnapshot<T = unknown>(
  ctx: QueryCtx | MutationCtx,
  actionId: Id<'moderationActions'>,
): Promise<T | null> {
  const rows = await ctx.db
    .query('auditSnapshots')
    .withIndex('by_action', (q) => q.eq('actionId', actionId))
    .collect();
  const first = rows[0];
  if (!first) return null;
  if (!isChunk(first.payload)) return first.payload as T;
  if (rows.length !== first.payload.of) {
    throw new Error(`auditSnapshots: ${actionId} has ${rows.length} of ${first.payload.of} parts`);
  }
  return JSON.parse(rows.map((row) => (row.payload as Chunk).chunk).join('')) as T;
}

/** A document as a snapshot stores it: a stored field may not start with `_`, so the two are renamed. */
export function snapshotDoc<T extends { _id: string; _creationTime: number }>(
  doc: T,
): Omit<T, '_id' | '_creationTime'> & { id: T['_id']; creationTime: number } {
  const { _id, _creationTime, ...rest } = doc;
  return { ...rest, id: _id, creationTime: _creationTime };
}
