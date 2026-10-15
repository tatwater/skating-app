/**
 * The one writer of `moderationActions` (B01 §11, D226).
 *
 * Every operator action — and every machine action an operator should be able to check — leaves one
 * audit row. They used to be written by 51 direct inserts across 16 files; they all come through here
 * now, so the row's shape is decided once: who (absent when the system acted), what, on what, why,
 * what it replaced, and — for an undo — which row it undoes. `auditWriters.test.ts` (core) holds the
 * sources to this file being the only writer.
 */

import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
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
  const undoesActionId = row.undoesActionId ?? UNDOING.get(ctx);
  return ctx.db.insert('moderationActions', {
    ...row,
    ...(undoesActionId !== undefined ? { undoesActionId } : {}),
    createdAt: createdAt ?? Date.now(),
  });
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
