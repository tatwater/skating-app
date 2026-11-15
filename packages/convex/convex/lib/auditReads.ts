/**
 * The audit log's reads, one rule each. {@link auditRowsOn} — one target's rows, newest first
 * (`moderation.listActions`): with a verb, the `by_target_action` range, so the filter is in the index
 * rather than over a page already capped; without one, `by_target`. {@link auditLinksOnBody} — the
 * rows that concern one body (`bodyConsole.history`), through `auditBodyLinks`; its body-only rows
 * are the ones `auditRowsOn` reads for that `waterbody` target. {@link auditTargetLabel} — the name a
 * row's target goes by, for the feed.
 */
import { SCOPE_ALL } from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import type { ModerationAction, ModerationTargetType } from './audit';
import { personRowOf, rowlessProfile } from './peopleRows';

/**
 * **The name an audit row's target goes by**, for the feed (S5): a body's from its stored library
 * row (one indexed read; never the body document, whose outline is the cost), a person's display
 * name. `null` for every other kind, and for a body or person no longer there.
 */
export async function auditTargetLabel(
  ctx: QueryCtx,
  targetType: ModerationTargetType,
  targetId: string,
): Promise<string | null> {
  const light = await lightLabel(ctx, targetType, targetId);
  return typeof light === 'object' && light !== null ? rowlessLabel(ctx, light.rowless) : light;
}

/** A target's label from its light row — or, for a person with no People row yet, whose profile. */
async function lightLabel(
  ctx: QueryCtx,
  targetType: ModerationTargetType,
  targetId: string,
): Promise<string | null | { rowless: Id<'profiles'> }> {
  if (targetType === 'waterbody') {
    const id = ctx.db.normalizeId('waterBodies', targetId);
    if (id === null) return null;
    const row = await ctx.db
      .query('bodyLibraryRows')
      .withIndex('by_body', (q) => q.eq('waterBodyId', id).eq('scope', SCOPE_ALL))
      .first();
    return row?.name ?? null;
  }
  if (targetType === 'user') {
    // The person's light People row, never their profile: a feed or History names a person once a
    // row, and a profile can weigh a whole document.
    const id = ctx.db.normalizeId('profiles', targetId);
    if (id === null) return null;
    const row = await personRowOf(ctx, id);
    return row ? row.displayName.trim() || row.username : { rowless: id };
  }
  return null;
}

/**
 * Someone with no People row yet (before the backfill) is read in full while the request's profile
 * budget lasts, then left unnamed. `rowlessProfile` charges as it starts.
 */
async function rowlessLabel(ctx: QueryCtx, id: Id<'profiles'>): Promise<string | null> {
  const person = await rowlessProfile(ctx, id);
  return person ? person.displayName.trim() || person.username : null;
}

/**
 * **Every row's target label, one read per distinct target** — the page's rows share them, so a feed
 * of 100 rows on a dozen bodies makes a dozen reads, and 100 rows on 100 targets at most 100 (B01-3c:
 * a read per row cost an unfiltered 100-row page 315 ms on dev). Kinds with no label read nothing.
 * Keyed `targetType\u0001targetId`; `null` where the target has no label or is gone.
 *
 * The light reads go all at once (B01-3h): a page of 100 targets is one round, not 100. The profiles
 * of people with no row yet, charged to the request's budget, are read only once `after` settles
 * (the page's other charges: its undo states), and started in page order — so which people the
 * budget reaches is the same every time, whatever order anything settled in.
 */
export async function auditTargetLabels(
  ctx: QueryCtx,
  rows: readonly { targetType: ModerationTargetType; targetId: string }[],
  after?: Promise<unknown>,
): Promise<Map<string, string | null>> {
  const distinct = new Map<string, { targetType: ModerationTargetType; targetId: string }>();
  for (const row of rows) distinct.set(targetKey(row), row);
  const keys = [...distinct.keys()];
  const light = await Promise.all(
    [...distinct.values()].map((row) => lightLabel(ctx, row.targetType, row.targetId)),
  );
  await after;
  const labels = await Promise.all(
    light.map((l) => (typeof l === 'object' && l !== null ? rowlessLabel(ctx, l.rowless) : l)),
  );
  return new Map(keys.map((key, i) => [key, labels[i] ?? null]));
}

/** The key {@link auditTargetLabels} files a target under. */
export function targetKey(row: { targetType: ModerationTargetType; targetId: string }): string {
  return `${row.targetType}\u0001${row.targetId}`;
}

export function auditRowsOn(
  ctx: QueryCtx,
  target: { targetType: ModerationTargetType; targetId: string; action?: ModerationAction },
  take: number,
): Promise<Doc<'moderationActions'>[]> {
  const { targetType, targetId, action } = target;
  return action === undefined
    ? ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
        .order('desc')
        .take(take)
    : ctx.db
        .query('moderationActions')
        .withIndex('by_target_action', (q) =>
          q.eq('targetType', targetType).eq('targetId', targetId).eq('action', action),
        )
        .order('desc')
        .take(take);
}

/**
 * The audit rows that concern one body, newest first, as their links (`auditBodyLinks`) — **one rule
 * for every reader** of a body's history: `bodyConsole.history` reads it once per body in the merge
 * chain, and with `bodyOnly` it holds the rows `moderation.listActions` reads for that `waterbody`
 * target (tested to agree). With a verb, its index range; with `bodyOnly`, the rows on the body
 * itself — never a filter over a page already capped.
 */
export function auditLinksOnBody(
  ctx: QueryCtx,
  body: { waterBodyId: Id<'waterBodies'>; action?: ModerationAction; bodyOnly?: boolean },
  take: number,
): Promise<Doc<'auditBodyLinks'>[]> {
  const { waterBodyId, action, bodyOnly } = body;
  if (action !== undefined && bodyOnly === true) {
    return ctx.db
      .query('auditBodyLinks')
      .withIndex('by_body_self_action_time', (q) =>
        q.eq('waterBodyId', waterBodyId).eq('self', true).eq('action', action),
      )
      .order('desc')
      .take(take);
  }
  if (action !== undefined) {
    return ctx.db
      .query('auditBodyLinks')
      .withIndex('by_body_action_time', (q) =>
        q.eq('waterBodyId', waterBodyId).eq('action', action),
      )
      .order('desc')
      .take(take);
  }
  if (bodyOnly === true) {
    return ctx.db
      .query('auditBodyLinks')
      .withIndex('by_body_self_time', (q) => q.eq('waterBodyId', waterBodyId).eq('self', true))
      .order('desc')
      .take(take);
  }
  return ctx.db
    .query('auditBodyLinks')
    .withIndex('by_body_time', (q) => q.eq('waterBodyId', waterBodyId))
    .order('desc')
    .take(take);
}
