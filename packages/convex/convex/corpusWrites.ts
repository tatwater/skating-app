/**
 * **The Corpus tasks' decisions** (B01-6a): each one mutation — the rule first, then the domain write
 * through its existing impl, then the settle with that write's audit row — so a decision can't
 * half-land.
 *
 * - **The rule first** (`lib/corpusRules`, the one `corpusTasks`' `can` asks): the capability, the
 *   lock, the body merged or removed, the verb's precondition, then what the argument names. Nothing
 *   refuses after the first audit row (D270): `writersDecideFirst.test.ts` holds this file to it.
 * - **The domain write through its own impl** — `setWaterBodyNameImpl`, `setClassImpl` — so its
 *   guards, side effects and audit row are the Body console's, and its undo is the one it has.
 *   That row, captured as written (`capturingAudit`), is the decision's: the task's
 *   `decisionActionId` and the toast's *Undo*. A *Keep* changes nothing on the body, so its row is
 *   the settle's own, `settle_review_reason`.
 * - **The settle** (`lib/corpusTasks.settleReason`): the reason off the body, recorded as settled on
 *   today's evidence (D306), the task decided — in the same transaction, so a decision that throws
 *   anywhere leaves nothing behind.
 *
 * The undo needs nothing here: one hook in `lib/undo.ts` reopens the task any undone row decided.
 * No `decideContested` in 6a: it lands with the Contested lane in 6b (D307).
 */

import { WATER_BODY_CLASSES } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type MutationCtx, mutation } from './_generated/server';
import {
  type CapturedAuditRow,
  capturingAudit,
  composed,
  type ModerationAction,
  writeAudit,
} from './lib/audit';
import { requireCapability } from './lib/auth';
import {
  assertCorpusVerb,
  CORPUS_VERB_CAPABILITY,
  type CorpusVerb,
  namePickRefusal,
} from './lib/corpusRules';
import { NO_SUCH_TASK, reasonOfLane, settleReason } from './lib/corpusTasks';
import { type CorpusDecisionResult, corpusDecisionResult } from './lib/decisionResult';
import { literals } from './lib/validators';
import { setClassImpl, setWaterBodyNameImpl } from './waterBodies';

/** `decideName`'s `pick` for *Keep*: the name shown stays, and the question is settled. */
export const SHOWN_PICK = 'shown';

/**
 * The caller, gated on `verb`'s capability — the rule's own map (`CORPUS_VERB_CAPABILITY`), spelled
 * out as one literal gate a capability so the capability guard sees each (D217).
 */
async function actorFor(ctx: MutationCtx, verb: CorpusVerb): Promise<Doc<'profiles'>> {
  switch (CORPUS_VERB_CAPABILITY[verb]) {
    case 'corpus.intake':
      return requireCapability(ctx, 'corpus.intake');
    case 'body.identity':
      return requireCapability(ctx, 'body.identity');
  }
}

/**
 * The task and its body as they stand (`null`: the body is gone, which the rule refuses). Read
 * plainly rather than through `taskToDecide`, whose lock would answer before the capability: the
 * rule's order is the capability first, and `settleReason` asks `taskToDecide` again as it writes.
 */
async function taskAndBody(
  ctx: MutationCtx,
  taskId: Id<'corpusTasks'>,
): Promise<{ task: Doc<'corpusTasks'>; body: Doc<'waterBodies'> | null }> {
  const task = await ctx.db.get(taskId);
  if (!task) throw new ConvexError(NO_SUCH_TASK);
  return { task, body: await ctx.db.get(task.waterBodyId) };
}

/**
 * The audit row the domain write wrote for `action` — the last such row, the write's own. Its impl
 * always writes one on the paths the rule lets through; a missing row is a broken invariant, never a
 * refusal.
 */
function decisionRowOf(
  rows: readonly CapturedAuditRow[],
  action: ModerationAction,
): Id<'moderationActions'> {
  const row = [...rows].reverse().find((r) => r.action === action);
  if (!row) throw new Error(`corpusWrites: the domain write recorded no ${action} row`);
  return row.actionId;
}

/**
 * A *Keep*: no domain write. The settle is the decision, recorded as `settle_review_reason` on the
 * body, which its undo (`unsettle_review_reason`) reverses.
 */
async function keep(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  task: Doc<'corpusTasks'>,
  body: Doc<'waterBodies'>,
): Promise<CorpusDecisionResult> {
  const actionId = await writeAudit(ctx, {
    actorId: actor._id,
    action: 'settle_review_reason',
    targetType: 'waterbody',
    targetId: body._id,
    reason:
      task.lane === 'nameConflicts'
        ? composed`Kept the name "${body.name}"`
        : composed`Kept the class ${body.type}`,
    metadata: {
      taskId: task._id,
      lane: task.lane,
      reviewReason: reasonOfLane(task.lane),
      decision: 'kept',
      // What the settle takes off the body, for History; the undo puts it back through the writer.
      prev: { reviewReasons: body.reviewReasons ?? [], reviewReason: body.reviewReason ?? null },
    },
  });
  await settleReason(ctx, { task, decision: 'kept', actionId, actorId: actor._id });
  return corpusDecisionResult(ctx, actor._id, task._id, actionId);
}

/**
 * `pickName`: `pick` one of the body's catalog name claims → `setWaterBodyNameImpl`, decision
 * `renamed` (`body.identity`); the refused name stays a claim, and searchable. `keepName`:
 * `pick: 'shown'` → no domain write, `settle_review_reason`, `kept` (`corpus.intake`).
 */
export const decideName = mutation({
  args: { taskId: v.id('corpusTasks'), pick: v.string() },
  handler: async (ctx, { taskId, pick }): Promise<CorpusDecisionResult> => {
    const verb: CorpusVerb = pick === SHOWN_PICK ? 'keepName' : 'pickName';
    const { task, body } = await taskAndBody(ctx, taskId);
    const actor = await actorFor(ctx, verb);
    await assertCorpusVerb(ctx, actor, task, body, verb);
    // The rule refuses a body that is gone, so from here it stands.
    const live = body as Doc<'waterBodies'>;
    if (verb === 'keepName') return keep(ctx, actor, task, live);
    const picked = namePickRefusal(live, pick);
    if ('refused' in picked) throw new ConvexError(picked.refused);
    const { rows } = await capturingAudit(ctx, () =>
      setWaterBodyNameImpl(ctx, actor, { waterBodyId: live._id, name: picked.claim.value }),
    );
    const actionId = decisionRowOf(rows, 'set_water_body_name');
    await settleReason(ctx, { task, decision: 'renamed', actionId, actorId: actor._id });
    return corpusDecisionResult(ctx, actor._id, taskId, actionId);
  },
});

/**
 * `setClass`: a class not the body's → `setClassImpl`, `reclassed` (`body.identity`). `keepClass`:
 * the body's own class → `settle_review_reason`, `kept` (`corpus.intake`). Which one is the body's
 * call, not the client's: the class it shows now is *Keep*, whatever the button said.
 */
export const decideClass = mutation({
  args: { taskId: v.id('corpusTasks'), bodyClass: literals(WATER_BODY_CLASSES) },
  handler: async (ctx, { taskId, bodyClass }): Promise<CorpusDecisionResult> => {
    const { task, body } = await taskAndBody(ctx, taskId);
    const verb: CorpusVerb = body?.type === bodyClass ? 'keepClass' : 'setClass';
    const actor = await actorFor(ctx, verb);
    await assertCorpusVerb(ctx, actor, task, body, verb);
    // The rule refuses a body that is gone, so from here it stands.
    const live = body as Doc<'waterBodies'>;
    if (verb === 'keepClass') return keep(ctx, actor, task, live);
    const { rows } = await capturingAudit(ctx, () =>
      setClassImpl(ctx, actor, { waterBodyId: live._id, bodyClass }),
    );
    const actionId = decisionRowOf(rows, 'set_class');
    await settleReason(ctx, { task, decision: 'reclassed', actionId, actorId: actor._id });
    return corpusDecisionResult(ctx, actor._id, taskId, actionId);
  },
});
