/**
 * Writing down what a posted sign says (N6e).
 *
 * One mutation for all three targets — water body, put-in, parking area — because it is one claim
 * wearing three hats. Three near-identical copies split across `waterBodies.ts` and `accessPoints.ts`
 * would be three places to fix the next validation rule, and the target union costs a `switch`.
 *
 * **Moderator-only, and deliberately not a community surface.** Everything else in the access layer is
 * a claim anybody can make and anybody can vote down (`accessAlerts`), which is right for a locked
 * gate: being wrong costs a wasted drive, and the crowd corrects it within a season. A posted rule is
 * a legal restriction — being wrong in the permissive direction sends a stranger somewhere they are
 * not allowed to be, and no vote makes that safe. So it follows the `setDepth` / `setReferenceLinks`
 * shape instead: one operator, one audit row, `prev` recorded so the change is reversible.
 */

import { describePostedAccess, type PostedAccess, postedAccessError } from '@skating/core';
import { ConvexError, type Infer, v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { mutation } from './_generated/server';
import { requireContributorRole } from './lib/auth';
import { postedAccess as postedAccessValidator } from './lib/validators';

/** The three things a sign can be nailed to. Literals match `MODERATION_TARGET_TYPES`. */
const postedAccessTarget = v.union(
  v.object({ type: v.literal('waterbody'), id: v.id('waterBodies') }),
  v.object({ type: v.literal('putIn'), id: v.id('putIns') }),
  v.object({ type: v.literal('parkingArea'), id: v.id('parkingAreas') }),
);
type PostedAccessTarget = Infer<typeof postedAccessTarget>;

// The validator and the core type must stay structurally identical — assert it at compile time so
// drift in either is a build error rather than a silent DB/runtime mismatch (the `weatherSinceSummary`
// guard, applied to the shape three tables now share).
const _assertPostedForward: PostedAccess = null as unknown as Infer<typeof postedAccessValidator>;
const _assertPostedReverse: Infer<typeof postedAccessValidator> = null as unknown as PostedAccess;
void _assertPostedForward;
void _assertPostedReverse;

const NOT_FOUND: Record<PostedAccessTarget['type'], string> = {
  waterbody: 'Water body not found',
  putIn: 'Put-in not found',
  parkingArea: 'Parking area not found',
};

/**
 * Fetch and patch, switched on the target rather than cast.
 *
 * A single `ctx.db.get(id as Id<'waterBodies'>)` would work at runtime — a Convex id knows its own
 * table — and would tell the type system that a put-in is a water body, so the next person to add a
 * field to one of these tables could patch it onto another and find out in production.
 */
async function getTarget(
  ctx: MutationCtx,
  target: PostedAccessTarget,
): Promise<Doc<'waterBodies'> | Doc<'putIns'> | Doc<'parkingAreas'> | null> {
  switch (target.type) {
    case 'waterbody':
      return await ctx.db.get(target.id);
    case 'putIn':
      return await ctx.db.get(target.id);
    case 'parkingArea':
      return await ctx.db.get(target.id);
  }
}

async function patchTarget(
  ctx: MutationCtx,
  target: PostedAccessTarget,
  next: PostedAccess | undefined,
): Promise<void> {
  switch (target.type) {
    case 'waterbody':
      return await ctx.db.patch(target.id, { postedAccess: next });
    case 'putIn':
      return await ctx.db.patch(target.id, { postedAccess: next });
    case 'parkingArea':
      return await ctx.db.patch(target.id, { postedAccess: next });
  }
}

/**
 * Moderator: set (or clear, with `null`) the posted rule on a body, put-in, or lot.
 *
 * `null` clears — there is deliberately no separate delete mutation for a single optional object, the
 * same call `setReferenceLinks` makes with an empty array.
 *
 * **The validator runs here as well as in the editor, and that is not redundant.** The client check
 * exists so an operator sees the error without a round trip; this one exists because a mutation is the
 * trust boundary and a client check is a suggestion.
 */
export const setPostedAccess = mutation({
  args: {
    target: postedAccessTarget,
    postedAccess: v.union(postedAccessValidator, v.null()),
  },
  handler: async (ctx, { target, postedAccess }) => {
    const actor = await requireContributorRole(ctx, 'moderator');

    const doc = await getTarget(ctx, target);
    if (!doc) throw new ConvexError(NOT_FOUND[target.type]);

    let next: PostedAccess | undefined;
    if (postedAccess !== null) {
      const error = postedAccessError(postedAccess);
      if (error) throw new ConvexError(error);
      next = normalize(postedAccess);
    }

    const prev = doc.postedAccess;
    await patchTarget(ctx, target, next);

    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'set_posted_access',
      targetType: target.type,
      targetId: target.id,
      reason: describeChange(next),
      // `prev` alongside the new value (the F1 convention): an audit row that records only what a
      // field *became* can answer "who changed this" and never "changed it from what", which is most
      // of what someone reading a wrong closure back would want.
      metadata: { postedAccess: next ?? null, prev: { postedAccess: prev ?? null } },
      createdAt: Date.now(),
    });

    return target.id;
  },
});

/**
 * Drop a whitespace-only note so it stores as absent rather than as an empty citation.
 *
 * The same treatment `depthSourceNote` gets, and for the same reason: an empty string renders as a
 * blank line under the rule, which reads as a citation nobody filled in.
 */
function normalize(rule: PostedAccess): PostedAccess {
  const note = rule.note?.trim();
  return {
    ...rule,
    ...(note ? { note } : { note: undefined }),
  };
}

/**
 * The audit line.
 *
 * The rule itself goes in the reason, not just on the row: the moderation log is where you look to ask
 * "who claimed this and on what basis", and a reason reading only "Set posted rules" makes you go and
 * diff the document to learn what was actually posted.
 */
function describeChange(rule: PostedAccess | undefined): string {
  if (!rule) return 'Cleared the posted rules';
  const described = describePostedAccess(rule);
  const note = rule.note ? ` (${rule.note})` : '';
  return described ? `Set posted rules: ${described}${note}` : `Set posted rules${note}`;
}
