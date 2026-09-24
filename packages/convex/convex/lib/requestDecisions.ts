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
  } else if (request.kind === 'name_bay') {
    // A bay's siblings are the asks for the *same bay* — every name the answering bay carries
    // when there is one, else the ask's own — each an exact index range on the stored key.
    const waterBodyId = request.waterBodyId;
    if (waterBodyId === undefined) return none;
    const keys = new Set([requestKeyOf(request)]);
    for (const n of answeredBy ? bayNames(answeredBy) : []) keys.add(requestNameKey(n));
    rows = [];
    for (const key of keys) {
      rows.push(
        ...(await ctx.db
          .query('waterBodyRequests')
          .withIndex('by_water_body_name', (q) =>
            q
              .eq('waterBodyId', waterBodyId)
              .eq('kind', 'name_bay')
              .eq('status', 'open')
              .eq('nameKey', key)
              .lte('_creationTime', asOf),
          )
          .take(limit + 2)),
      );
    }
  } else {
    if (request.waterBodyId === undefined) return none;
    rows = await ctx.db
      .query('waterBodyRequests')
      .withIndex('by_water_body', (q) =>
        q
          .eq('waterBodyId', request.waterBodyId)
          .eq('kind', request.kind)
          .eq('status', 'open')
          .lte('_creationTime', asOf),
      )
      .take(limit + 2);
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

/** A bay ask's question — the stored key, folded from the name for any row that predates it. */
export function requestKeyOf(r: Pick<Doc<'waterBodyRequests'>, 'nameKey' | 'name'>): string {
  return r.nameKey ?? requestNameKey(r.name ?? '');
}

/** Every name a bay ask goes by — the name and the spellings the seed filed with it. */
export function requestNames(r: Pick<Doc<'waterBodyRequests'>, 'name' | 'aliases'>): string[] {
  return [r.name ?? '', ...(r.aliases ?? [])].filter((n) => n.trim().length > 0);
}

/**
 * **The one rule for "the same bay"** — any name of one folds to any name of the other. The queue's
 * drawn-bay match, the name check on a new or renamed bay, and a merge's collision all ask it, so
 * they cannot disagree about whether "NW Bay" and "Northwest Bay" (joined by an alias) are one bay.
 */
export function namesMeet(a: readonly string[], b: readonly string[]): boolean {
  const keys = new Set(a.map(requestNameKey).filter((k) => k.length > 0));
  return b.some((n) => keys.has(requestNameKey(n)));
}

/** A lake's listed bays — read once per body, for as many matches as a query needs. */
export async function listedBaysOf(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<Doc<'waterBodySubAreas'>[]> {
  const bays = await ctx.db
    .query('waterBodySubAreas')
    .withIndex('by_parent', (q) => q.eq('waterBodyId', waterBodyId))
    .collect();
  return bays.filter((bay) => bay.removedAt === undefined);
}

/** The bay among `bays` that answers an ask going by any of `names`. */
export function matchBay(
  bays: readonly Doc<'waterBodySubAreas'>[],
  names: readonly string[],
): Doc<'waterBodySubAreas'> | null {
  return bays.find((bay) => namesMeet(names, bayNames(bay))) ?? null;
}

/**
 * The listed sub-area on `waterBodyId` that answers a bay ask by any of its names. Bounded by the
 * handful of bays one lake has; a query matching many asks should read `listedBaysOf` once and
 * call `matchBay` per ask instead.
 */
export async function drawnBay(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  names: readonly string[],
): Promise<Doc<'waterBodySubAreas'> | null> {
  return matchBay(await listedBaysOf(ctx, waterBodyId), names);
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
  if (!bay || !namesMeet(requestNames(request), bayNames(bay))) {
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
