/**
 * A request's decision — the rows it closes, the audit each gets, and the bay helpers (D179, D201).
 *
 * In `lib/` rather than in `corpusRequests.ts` because `subAreas.createFromChord` approves a bay
 * ask from the drawing that answers it, and `corpusRequests` reaches `waterBodies`, which reaches
 * `subAreas`: a helper that lived on the module would close a three-module import cycle that only
 * works while nothing in it is evaluated at load time. Shared code lives where the other shared
 * helpers do.
 */

import { requestNameKey } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { literals } from './validators';

/** Cap on the moderator queue read — and the page a decision drains siblings by. */
export const QUEUE_CAP = 200;

/** How many open bay asks on one lake a decision reads through to find the same bay's siblings. */
export const BAY_SIBLING_SCAN = 1_000;

/**
 * Up to `limit` of the other open asks that share this one's question: the same kind on the same
 * body, or — for an `admit` — the same catalog feature (Greptile, PR #63: admits have no body to
 * group by, and two taps on one pond were two independent decisions). An unresolved admit has no
 * siblings yet. Both index ranges are exactly the sibling set, so `capped` means there are more,
 * not that a filter ate the page (second pass).
 *
 * `asOf` bounds the range to rows that existed then, on the index's implicit `_creationTime` tail:
 * a decision closes the group *as it stood when the moderator answered*, and an ask filed while
 * the pages were draining is a new question, left open for the next answer (fourth pass).
 */
export async function openSiblings(
  ctx: QueryCtx,
  request: Doc<'waterBodyRequests'>,
  limit: number,
  asOf: number = Number.POSITIVE_INFINITY,
  /**
   * For an approved bay ask: the sub-area that answered it. Its name *and* aliases are the
   * question then — the moderator who saved "Northwest Bay" with the alias "NW Bay" has answered
   * the "NW Bay" ask too, which no name fold could join (Greptile, PR #76).
   */
  answeredBy?: Doc<'waterBodySubAreas'> | null,
): Promise<{ rows: Doc<'waterBodyRequests'>[]; capped: boolean }> {
  const none = { rows: [], capped: false };
  let rows: Doc<'waterBodyRequests'>[];
  if (request.kind === 'admit') {
    if (request.candidateExternalId === undefined) return none;
    rows = await ctx.db
      .query('waterBodyRequests')
      .withIndex('by_candidate_external_id', (q) =>
        q
          .eq('candidateExternalId', request.candidateExternalId)
          .eq('status', 'open')
          .lte('_creationTime', asOf),
      )
      .take(limit + 2);
  } else {
    if (request.waterBodyId === undefined) return none;
    // A bay's siblings are the asks for the *same bay*: the index ranges over every open bay ask
    // on the lake and the name key narrows it. The other bays' rows stay open, so a page-full
    // signal could never converge (every next page would read them again); instead the scan is
    // wider than a page and bounded — past `BAY_SIBLING_SCAN` open bay asks on one lake a sibling
    // could sit beyond it, still open and still in the queue for a moderator to answer by hand.
    const scan = request.kind === 'name_bay' ? BAY_SIBLING_SCAN : limit + 2;
    rows = await ctx.db
      .query('waterBodyRequests')
      .withIndex('by_water_body', (q) =>
        q
          .eq('waterBodyId', request.waterBodyId)
          .eq('kind', request.kind)
          .eq('status', 'open')
          .lte('_creationTime', asOf),
      )
      .take(scan);
    if (request.kind === 'name_bay') {
      const keys = new Set([requestNameKey(request.name ?? '')]);
      for (const n of answeredBy ? bayNames(answeredBy) : []) keys.add(requestNameKey(n));
      rows = rows.filter((r) => keys.has(requestNameKey(r.name ?? '')));
    }
  }
  // +2: one for the request itself if it is still open, one to learn whether there are more.
  const others = rows.filter((r) => r._id !== request._id);
  return { rows: others.slice(0, limit), capped: others.length > limit };
}

/** What a decision writes on every row it closes — carried to the continuation unchanged. */
export const decisionArgs = {
  requestId: v.id('waterBodyRequests'),
  status: literals(['approved', 'declined'] as const),
  actorId: v.id('profiles'),
  now: v.number(),
  note: v.optional(v.string()),
  admittedWaterBodyId: v.optional(v.id('waterBodies')),
  subAreaId: v.optional(v.id('waterBodySubAreas')),
};
export type Decision = {
  requestId: Id<'waterBodyRequests'>;
  status: 'approved' | 'declined';
  actorId: Id<'profiles'>;
  now: number;
  note?: string;
  admittedWaterBodyId?: Id<'waterBodies'>;
  /** For an approved `name_bay`: the sub-area that answered it. */
  subAreaId?: Id<'waterBodySubAreas'>;
};

export async function closeRow(
  ctx: MutationCtx,
  row: Doc<'waterBodyRequests'>,
  { requestId, status, actorId, now, note, admittedWaterBodyId, subAreaId }: Decision,
): Promise<void> {
  await ctx.db.patch(row._id, {
    status,
    decidedAt: now,
    decidedByUserId: actorId,
    ...(note ? { decisionNote: note } : {}),
    ...(admittedWaterBodyId ? { admittedWaterBodyId } : {}),
  });
  await ctx.db.insert('moderationActions', {
    actorId,
    action: status === 'approved' ? 'approve_request' : 'decline_request',
    targetType: 'waterBodyRequest',
    targetId: row._id,
    reason: note || `${status === 'approved' ? 'Approved' : 'Declined'} a ${row.kind} request`,
    metadata: {
      kind: row.kind,
      ...(row.waterBodyId ? { waterBodyId: row.waterBodyId } : {}),
      ...(admittedWaterBodyId ? { admittedWaterBodyId } : {}),
      ...(subAreaId ? { subAreaId } : {}),
      ...(row._id !== requestId ? { withRequestId: requestId } : {}),
    },
    createdAt: now,
  });
}

/**
 * One page of siblings closed with the decision; the next page scheduled if there is one. The page
 * is the transaction's bound — `QUEUE_CAP` patches plus as many audit rows — so a sibling group of
 * any size drains in bounded steps instead of one mutation that grows until it cannot commit
 * (Greptile, PR #63, third pass). Each page comes back empty of the rows the last one closed, and
 * the range ends at `decision.now`, so the drain converges on the group the moderator saw.
 */
export async function closeSiblingPage(
  ctx: MutationCtx,
  request: Doc<'waterBodyRequests'>,
  decision: Decision,
): Promise<void> {
  const answeredBy = decision.subAreaId ? await ctx.db.get(decision.subAreaId) : null;
  const { rows, capped } = await openSiblings(ctx, request, QUEUE_CAP, decision.now, answeredBy);
  for (const row of rows) await closeRow(ctx, row, decision);
  if (capped) await ctx.scheduler.runAfter(0, internal.corpusRequests.closeSiblings, decision);
}

/**
 * Close the request and every open sibling, with one audit row each. Siblings share the decision
 * because they share the question — and *every* sibling: the first page closes with the request,
 * and the rest follow in scheduled pages. Nothing is left open past a page boundary (Greptile,
 * PR #63).
 */
export async function decide(
  ctx: MutationCtx,
  request: Doc<'waterBodyRequests'>,
  status: 'approved' | 'declined',
  actorId: Id<'profiles'>,
  now: number,
  note: string | undefined,
  admittedWaterBodyId?: Id<'waterBodies'>,
  subAreaId?: Id<'waterBodySubAreas'>,
): Promise<void> {
  const decision: Decision = {
    requestId: request._id,
    status,
    actorId,
    now,
    ...(note !== undefined ? { note } : {}),
    ...(admittedWaterBodyId !== undefined ? { admittedWaterBodyId } : {}),
    ...(subAreaId !== undefined ? { subAreaId } : {}),
  };
  await closeRow(ctx, request, decision);
  await closeSiblingPage(ctx, request, decision);
}

// ── Bays (D201) ────────────────────────────────────────────────────────────────────────────────

/** Every name a bay answers to — the one it is shown by and its aliases. */
export function bayNames(bay: Pick<Doc<'waterBodySubAreas'>, 'name' | 'aliases'>): string[] {
  return [bay.name, ...(bay.aliases ?? [])];
}

/**
 * The listed sub-area on `waterBodyId` that answers a bay ask by name — its name or an alias folds
 * to the same key. Bounded by the handful of bays one lake has.
 */
export async function drawnBay(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  name: string,
): Promise<Doc<'waterBodySubAreas'> | null> {
  const key = requestNameKey(name);
  if (!key) return null;
  const bays = await ctx.db
    .query('waterBodySubAreas')
    .withIndex('by_parent', (q) => q.eq('waterBodyId', waterBodyId))
    .collect();
  return (
    bays.find(
      (bay) => bay.removedAt === undefined && bayNames(bay).some((n) => requestNameKey(n) === key),
    ) ?? null
  );
}

/**
 * Approve a `name_bay` request from the drawing that answers it (`subAreas.createFromChord`). The
 * request must be a bay ask on the lake the bay was drawn on — a request id the editor attached
 * that turns out to be someone else's is a bug to see, not a row to leave open — and every open
 * ask for the same bay closes with it.
 */
export async function approveNamedBayRequest(
  ctx: MutationCtx,
  requestId: Id<'waterBodyRequests'>,
  waterBodyId: Id<'waterBodies'>,
  actor: Doc<'profiles'>,
  subAreaId: Id<'waterBodySubAreas'>,
): Promise<'approved' | 'already_decided'> {
  const request = await ctx.db.get(requestId);
  if (request?.kind !== 'name_bay' || request.waterBodyId !== waterBodyId) {
    throw new ConvexError('That request is not a bay request on this lake');
  }
  // The drawing answers the ask only if it is the bay asked for. The editor prefills the name
  // but leaves it editable, and a renamed save must not mark "Keeler Bay" answered by a bay
  // called something else (Greptile, PR #76). The asked-for name as an alias is enough — that is
  // how a moderator says "same bay, better spelling".
  const bay = await ctx.db.get(subAreaId);
  const asked = requestNameKey(request.name ?? '');
  if (!bay || !bayNames(bay).some((n) => requestNameKey(n) === asked)) {
    throw new ConvexError(
      `This bay doesn't carry the name that was asked for ("${request.name}"). Keep that name, add it as an alias, or save without the request.`,
    );
  }
  // Decided while the moderator was drawing (declined in another tab, approved by a colleague):
  // the drawing is still right, and refusing it would roll the bay back for a row that is
  // already answered. The bay stands; the ask keeps the answer it got.
  if (request.status !== 'open') return 'already_decided';
  await decide(ctx, request, 'approved', actor._id, Date.now(), undefined, undefined, subAreaId);
  return 'approved';
}
