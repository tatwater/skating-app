/**
 * A request's decision — the rows it closes, the audit each gets, and the bay helpers (D179, D201).
 *
 * In `lib/` rather than in `corpusRequests.ts` because `subAreas.createFromChord` approves a bay
 * ask from the drawing that answers it, and `corpusRequests` reaches `waterBodies`, which reaches
 * `subAreas`: a helper that lived on the module would close a three-module import cycle that only
 * works while nothing in it is evaluated at load time. Shared code lives where the other shared
 * helpers do.
 */

import {
  haversineMeters,
  type LandmarkAsk,
  type LatLng,
  landmarkAnswersAsk,
  landmarkAskLookalikes,
  landmarkAsksAreSamePlace,
  landmarkNamesMeet,
  requestNameKey,
  requestNameKeyFor,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { liveLandmarksForBody } from './landmarkRows';
import { literals } from './validators';

/** Cap on the moderator queue read — and the page a decision drains siblings by. */
export const QUEUE_CAP = 200;

/**
 * Up to `limit` of the other open asks that share this one's question: the same kind on the same
 * body, or — for an `admit` — the same catalog feature (Greptile, PR #63: admits have no body to
 * group by, and two taps on one pond were two independent decisions). An unresolved admit has no
 * siblings yet. Those index ranges are exactly the sibling set, so `capped` means there are more,
 * not that a filter ate the page (second pass).
 *
 * A landmark ask is the exception: its siblings are the asks for the same *place*, and a place is a
 * name and a spot (`landmarkAsksAreSamePlace`) — two Long Points on one lake are two questions
 * (Greptile P1 on #84). No index range is a place, so it pages through the lake's open landmark
 * asks by cursor and filters each page; `capped` then comes with the `cursor` to resume from, since
 * the asks a filter left open would otherwise fill the next page again, forever.
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
  answer: {
    /**
     * For an approved bay ask: the sub-area that answered it. Its name *and* aliases are the
     * question then — the moderator who saved "Northwest Bay" with the alias "NW Bay" has answered
     * the "NW Bay" ask too, which no name fold could join (Greptile, PR #76).
     */
    subArea?: Pick<Doc<'waterBodySubAreas'>, 'name' | 'aliases'> | null;
    /** For an approved landmark ask: the landmark that answered it — every ask it is the place of. */
    landmark?: Doc<'bodyLandmarks'> | null;
    /** For a landmark ask: where the last page ended. */
    cursor?: string;
  } = {},
): Promise<{ rows: Doc<'waterBodyRequests'>[]; capped: boolean; cursor?: string }> {
  const none = { rows: [], capped: false };
  let rows: Doc<'waterBodyRequests'>[];
  if (request.kind === 'name_landmark') {
    const waterBodyId = request.waterBodyId;
    if (waterBodyId === undefined) return none;
    const page = await ctx.db
      .query('waterBodyRequests')
      .withIndex('by_water_body', (q) =>
        q
          .eq('waterBodyId', waterBodyId)
          .eq('kind', 'name_landmark')
          .eq('status', 'open')
          .lte('_creationTime', asOf),
      )
      .paginate({ numItems: limit, cursor: answer.cursor ?? null });
    const asked = landmarkAskOf(request);
    const { landmark } = answer;
    const same = page.page.filter(
      (r) =>
        r._id !== request._id &&
        (landmarkAsksAreSamePlace(asked, landmarkAskOf(r)) ||
          (landmark != null && landmarkAnswersAsk(landmark, landmarkAskOf(r)))),
    );
    return page.isDone
      ? { rows: same, capped: false }
      : { rows: same, capped: true, cursor: page.continueCursor };
  }
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
    // A bay's siblings are the asks for the *same bay* — every name the answer carries when there
    // is one, else the ask's own — each an exact range on the stored key.
    const waterBodyId = request.waterBodyId;
    const kind = request.kind;
    if (waterBodyId === undefined) return none;
    const keys = new Set([requestKeyOf(request)]);
    for (const n of answer.subArea ? bayNames(answer.subArea) : []) {
      keys.add(requestNameKeyFor(kind, n));
    }
    rows = [];
    for (const key of keys) {
      rows.push(
        ...(await ctx.db
          .query('waterBodyRequests')
          .withIndex('by_water_body_name', (q) =>
            q
              .eq('waterBodyId', waterBodyId)
              .eq('kind', kind)
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

/** A `name_landmark` ask as core's same-place rule reads it: its names and the spot marked. */
export function landmarkAskOf(
  r: Pick<Doc<'waterBodyRequests'>, 'name' | 'aliases' | 'coord'>,
): LandmarkAsk {
  return { names: requestNames(r), coord: r.coord };
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
  landmarkId: v.optional(v.id('bodyLandmarks')),
  /** A landmark decision's drain: where the last page of the lake's asks ended (`openSiblings`). */
  cursor: v.optional(v.string()),
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
  /** For an approved `name_landmark`: the landmark that answered it (D202). */
  landmarkId?: Id<'bodyLandmarks'>;
  /** Where the drain of a landmark decision resumes — set only on its scheduled pages. */
  cursor?: string;
};

export async function closeRow(
  ctx: MutationCtx,
  row: Doc<'waterBodyRequests'>,
  { requestId, status, actorId, now, note, admittedWaterBodyId, subAreaId, landmarkId }: Decision,
): Promise<void> {
  await ctx.db.patch(row._id, {
    status,
    decidedAt: now,
    decidedByUserId: actorId,
    ...(note ? { decisionNote: note } : {}),
    ...(admittedWaterBodyId ? { admittedWaterBodyId } : {}),
    ...(landmarkId ? { landmarkId } : {}),
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
      ...(landmarkId ? { landmarkId } : {}),
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
 * the range ends at `decision.now`, so the drain converges on the group the moderator saw. A
 * landmark decision's pages leave the other places' asks open, so it resumes from a cursor instead.
 */
export async function closeSiblingPage(
  ctx: MutationCtx,
  request: Doc<'waterBodyRequests'>,
  decision: Decision,
): Promise<void> {
  const { rows, capped, cursor } = await openSiblings(ctx, request, QUEUE_CAP, decision.now, {
    subArea: decision.subAreaId ? await ctx.db.get(decision.subAreaId) : null,
    landmark: decision.landmarkId ? await ctx.db.get(decision.landmarkId) : null,
    ...(decision.cursor !== undefined ? { cursor: decision.cursor } : {}),
  });
  for (const row of rows) await closeRow(ctx, row, decision);
  if (capped) {
    await ctx.scheduler.runAfter(0, internal.corpusRequests.closeSiblings, {
      ...decision,
      ...(cursor !== undefined ? { cursor } : {}),
    });
  }
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
  landmarkId?: Id<'bodyLandmarks'>,
): Promise<void> {
  const decision: Decision = {
    requestId: request._id,
    status,
    actorId,
    now,
    ...(note !== undefined ? { note } : {}),
    ...(admittedWaterBodyId !== undefined ? { admittedWaterBodyId } : {}),
    ...(subAreaId !== undefined ? { subAreaId } : {}),
    ...(landmarkId !== undefined ? { landmarkId } : {}),
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
export function requestKeyOf(
  r: Pick<Doc<'waterBodyRequests'>, 'kind' | 'nameKey' | 'name'>,
): string {
  return r.nameKey ?? requestNameKeyFor(r.kind, r.name ?? '');
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

// ── Landmarks (D202) ───────────────────────────────────────────────────────────────────────────

/**
 * The live landmark among `rows` that answers this ask — its name *and* its place
 * (`landmarkAnswersAsk`) — if any, for callers holding the rows. The nearest wins when two do.
 */
export function matchLandmark(
  rows: readonly Doc<'bodyLandmarks'>[],
  ask: LandmarkAsk,
): Doc<'bodyLandmarks'> | null {
  let best: { row: Doc<'bodyLandmarks'>; meters: number } | null = null;
  for (const row of rows) {
    if (row.removedAt !== undefined || !landmarkAnswersAsk(row, ask)) continue;
    const meters = haversineMeters(row.point, ask.coord);
    if (!best || meters < best.meters) best = { row, meters };
  }
  return best?.row ?? null;
}

/**
 * The landmark a moderator named as a landmark ask's answer, whatever the distance — this lake's own,
 * live, and carrying the asked-for name (as its name or a spelling). Refused otherwise: "it's Grand
 * Isle" answers a "Grand Isle" ask, never a "Long Point" one.
 */
export async function namedByModerator(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  request: Doc<'waterBodyRequests'>,
  landmarkId: Id<'bodyLandmarks'>,
  /**
   * What the moderator saw — the name and point their *Same place* dialog showed. A landmark moved or
   * renamed since is refused: the answer must be the landmark they checked, as they checked it
   * (Greptile P1 on #88). Compared here, at the write, because no client watch sees every way a row
   * changes.
   */
  seen: { name: string; point: LatLng },
): Promise<Doc<'bodyLandmarks'>> {
  const landmark = await ctx.db.get(landmarkId);
  if (!landmark || landmark.waterBodyId !== waterBodyId) {
    throw new ConvexError('That landmark is not on this lake');
  }
  // Taken off the map since the row was drawn (a colleague's removal, a merge's fold) — say so,
  // rather than "not on this lake" for the landmark the moderator is looking at on it.
  if (landmark.removedAt !== undefined) {
    throw new ConvexError(
      `"${landmark.name}" has been taken off the map — it answers nothing now.`,
    );
  }
  if (landmark.point.lat !== seen.point.lat || landmark.point.lng !== seen.point.lng) {
    throw new ConvexError(
      `"${landmark.name}" has moved since you looked at it. Cancel and look again.`,
    );
  }
  if (landmark.name !== seen.name) {
    throw new ConvexError(
      `"${seen.name}" has been renamed "${landmark.name}" since you looked at it. Cancel and look again.`,
    );
  }
  if (!landmarkNamesMeet(requestNames(request), [landmark.name, ...landmark.aliases])) {
    throw new ConvexError(
      `"${landmark.name}" doesn't carry the name that was asked for ("${request.name}").`,
    );
  }
  // A landmark now answers the ask at its own spot (added without the request attached, or by a
  // catalog run) — one the dialog never showed, since a row offers *Same place* only while none does.
  // That one is the answer; the far one the dialog named is no longer the question.
  const here = await namedLandmark(ctx, waterBodyId, landmarkAskOf(request));
  if (here && here._id !== landmark._id) {
    throw new ConvexError(
      `"${here.name}" now stands at this spot — cancel, and approve the proposal with it instead.`,
    );
  }
  return landmark;
}

/** A landmark proposal as a moderator's row shows it (D202) — the queue's and the lake editor's. */
export interface LandmarkProposalView {
  /** The live landmark that already answers it — the row offers "approve" rather than "add". */
  existingLandmarkId?: Id<'bodyLandmarks'>;
  /** Possible duplicates, while nothing answers it (`landmarkLookalikesView`). */
  similarLandmark?: {
    landmarkId: Id<'bodyLandmarks'>;
    name: string;
    point: LatLng;
    meters: number;
  };
  similarProposal?: {
    requestId: Id<'waterBodyRequests'>;
    name: string;
    coord: LatLng;
    meters: number;
  };
}

/**
 * What a moderator's row says of a landmark proposal: the landmark that already answers it, or —
 * while none does — what it may duplicate. A possible duplicate only matters while the proposal is
 * not already answered. `others` are the other open asks the moderator sees as rows.
 */
export function landmarkProposalView(
  ask: LandmarkAsk,
  landmarks: readonly Doc<'bodyLandmarks'>[],
  others: readonly Doc<'waterBodyRequests'>[],
): LandmarkProposalView {
  const existing = matchLandmark(landmarks, ask);
  return existing
    ? { existingLandmarkId: existing._id }
    : landmarkLookalikesView(ask, landmarks, others);
}

/**
 * A proposal's possible duplicates, as the moderator's rows show them (`landmarkAskLookalikes`): the
 * nearest live landmark and the nearest other proposal that share a name with it at another place —
 * by any of the other's names, as the ask is matched by any of its own.
 */
function landmarkLookalikesView(
  ask: LandmarkAsk,
  landmarks: readonly Doc<'bodyLandmarks'>[],
  others: readonly Doc<'waterBodyRequests'>[],
): Pick<LandmarkProposalView, 'similarLandmark' | 'similarProposal'> {
  const found = landmarkAskLookalikes(
    ask,
    landmarks.filter((l) => l.removedAt === undefined),
    others.map((o) => ({
      requestId: o._id,
      name: o.name ?? '',
      coord: o.coord,
      names: requestNames(o),
    })),
  );
  return {
    ...(found.landmark
      ? {
          similarLandmark: {
            landmarkId: found.landmark.item._id,
            name: found.landmark.item.name,
            point: found.landmark.item.point,
            meters: Math.round(found.landmark.meters),
          },
        }
      : {}),
    ...(found.ask
      ? {
          similarProposal: {
            requestId: found.ask.item.requestId,
            name: found.ask.item.name,
            coord: found.ask.item.coord,
            meters: Math.round(found.ask.meters),
          },
        }
      : {}),
  };
}

/** The live landmark on this body that answers a `name_landmark` ask, if one exists. */
export async function namedLandmark(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  ask: LandmarkAsk,
): Promise<Doc<'bodyLandmarks'> | null> {
  return matchLandmark(await liveLandmarksForBody(ctx, waterBodyId), ask);
}

/**
 * Approve a `name_landmark` ask by the landmark a moderator just added for it — and every open ask
 * for the same place with it. The landmark must answer to the asked-for name (as its name or an
 * alias): "same place, better spelling" is an alias, and a landmark by another name answers
 * nothing. Decided elsewhere in the meantime, the landmark stands and the ask keeps its answer.
 */
export async function approveNamedLandmarkRequest(
  ctx: MutationCtx,
  requestId: Id<'waterBodyRequests'>,
  waterBodyId: Id<'waterBodies'>,
  actor: Doc<'profiles'>,
  landmarkId: Id<'bodyLandmarks'>,
): Promise<'approved' | 'already_decided'> {
  const request = await ctx.db.get(requestId);
  if (request?.kind !== 'name_landmark' || request.waterBodyId !== waterBodyId) {
    throw new ConvexError('That request is not a landmark request on this lake');
  }
  const landmark = await ctx.db.get(landmarkId);
  if (
    !landmark ||
    !landmarkNamesMeet(requestNames(request), [landmark.name, ...landmark.aliases])
  ) {
    throw new ConvexError(
      `This landmark doesn't carry the name that was asked for ("${request.name}"). Keep that name, add it as another spelling, or save without the request.`,
    );
  }
  if (request.status !== 'open') return 'already_decided';
  await decide(
    ctx,
    request,
    'approved',
    actor._id,
    Date.now(),
    undefined,
    undefined,
    undefined,
    landmarkId,
  );
  return 'approved';
}
