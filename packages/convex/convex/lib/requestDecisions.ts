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
import { ConvexError, getDocumentSize, v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { composed, writeAudit } from './audit';
import {
  batchHasRoom,
  CLOSER_RESERVE,
  decideItem,
  inboxBatch,
  inboxPending,
  itemToDecide,
  LANDMARK_SCAN,
  refreshCost,
  requestSource,
  type TxCost,
} from './inboxItems';
import {
  ALONGSIDE_UNCHECKED,
  type AlongsideAnswer,
  assertInboxVerb,
  OWN_FILING_REFUSAL,
} from './inboxRules';
import { liveLandmarksForBody } from './landmarkRows';
import { ReadBudget, ROW_MAX } from './readBudget';
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
    /**
     * The bytes the read may spend (PR #170): an ask can carry a catalog polygon near the document
     * limit, so rows are taken one at a time — the next started only while its worst case still fits
     * — and a page the room ends early says `capped`, as one past its row limit does. Absent:
     * unbounded on bytes, for a caller whose rows are bounded otherwise.
     */
    room?: number;
  } = {},
): Promise<{ rows: Doc<'waterBodyRequests'>[]; capped: boolean; cursor?: string }> {
  const none = { rows: [], capped: false };
  let rows: Doc<'waterBodyRequests'>[];
  let short = false;
  const room = answer.room ?? Number.POSITIVE_INFINITY;
  let spent = 0;
  /** Up to `n` rows of `q`, each started only while a whole ask still fits the room. */
  const within = async (
    q: AsyncIterable<Doc<'waterBodyRequests'>>,
    n: number,
  ): Promise<Doc<'waterBodyRequests'>[]> => {
    const out: Doc<'waterBodyRequests'>[] = [];
    const it = q[Symbol.asyncIterator]();
    while (out.length < n) {
      if (spent + ROW_MAX.waterBodyRequest > room && (out.length > 0 || spent > 0)) {
        short = true;
        break;
      }
      const next = await it.next();
      if (next.done) break;
      spent += getDocumentSize(next.value);
      out.push(next.value);
    }
    return out;
  };
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
      .paginate({
        numItems: limit,
        cursor: answer.cursor ?? null,
        ...(answer.room !== undefined
          ? { maximumBytesRead: Math.max(ROW_MAX.waterBodyRequest, answer.room) }
          : {}),
      });
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
    rows = await within(
      ctx.db
        .query('waterBodyRequests')
        .withIndex('by_candidate_external_id', (q) =>
          q
            .eq('candidateExternalId', request.candidateExternalId)
            .eq('status', 'open')
            .lte('_creationTime', asOf),
        ),
      limit + 2,
    );
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
        ...(await within(
          ctx.db
            .query('waterBodyRequests')
            .withIndex('by_water_body_name', (q) =>
              q
                .eq('waterBodyId', waterBodyId)
                .eq('kind', kind)
                .eq('status', 'open')
                .eq('nameKey', key)
                .lte('_creationTime', asOf),
            ),
          limit + 2,
        )),
      );
    }
  } else {
    if (request.waterBodyId === undefined) return none;
    rows = await within(
      ctx.db
        .query('waterBodyRequests')
        .withIndex('by_water_body', (q) =>
          q
            .eq('waterBodyId', request.waterBodyId)
            .eq('kind', request.kind)
            .eq('status', 'open')
            .lte('_creationTime', asOf),
        ),
      limit + 2,
    );
  }
  // +2: one for the request itself if it is still open, one to learn whether there are more.
  const others = rows.filter((r) => r._id !== request._id);
  return { rows: others.slice(0, limit), capped: others.length > limit || short };
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
  /**
   * The audit row the approval's body-side act wrote (`activate_body`, `restore`, `remove`,
   * `set_public_access`, `set_included_by_request`), recorded on the primary request's row so its
   * undo (`reopen_request`) can undo the act through the engine first. Absent when the act wrote no
   * row (the body was already as asked) and on every decline.
   */
  bodyActionId: v.optional(v.id('moderationActions')),
  /**
   * The primary request's own `approve_request` / `decline_request` row: every sibling's Inbox member
   * is closed by it, so the decision's undo (`reopen_request`) finds them all, across the drain's
   * pages. Set by `decide` once the primary is closed.
   */
  actionId: v.optional(v.id('moderationActions')),
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
  /** The approval's body-side audit row, recorded on the primary request's row (`decisionArgs`). */
  bodyActionId?: Id<'moderationActions'>;
  /** The primary request's decision row, which closes every sibling's Inbox member (`decisionArgs`). */
  actionId?: Id<'moderationActions'>;
};

/**
 * The newest audit row on a water body, by id — read before and after an approval's body-side act,
 * so the row the act wrote is known without the act's helpers having to return it (`activateBody`,
 * `restoreBodyImpl`, `removeBodyImpl`, `setPublicAccessImpl` each write exactly one row on the body,
 * or none when the body was already as asked).
 */
export async function newestBodyAction(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<Id<'moderationActions'> | null> {
  const row = await ctx.db
    .query('moderationActions')
    .withIndex('by_target', (q) => q.eq('targetType', 'waterbody').eq('targetId', waterBodyId))
    .order('desc')
    .first();
  return row?._id ?? null;
}

/**
 * The row an approval's act wrote on the body: the newest row there now, when it is not the one that
 * was newest before the act. `null` when the act wrote none.
 */
export async function bodyActionSince(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  before: Id<'moderationActions'> | null,
): Promise<Id<'moderationActions'> | undefined> {
  const after = await newestBodyAction(ctx, waterBodyId);
  return after !== null && after !== before ? after : undefined;
}

export async function closeRow(
  ctx: MutationCtx,
  row: Doc<'waterBodyRequests'>,
  {
    requestId,
    status,
    actorId,
    now,
    note,
    admittedWaterBodyId,
    subAreaId,
    landmarkId,
    bodyActionId,
    actionId: primaryActionId,
  }: Decision,
): Promise<Id<'moderationActions'>> {
  await ctx.db.patch(row._id, {
    status,
    decidedAt: now,
    decidedByUserId: actorId,
    ...(note ? { decisionNote: note } : {}),
    ...(admittedWaterBodyId ? { admittedWaterBodyId } : {}),
    ...(landmarkId ? { landmarkId } : {}),
  });
  const actionId = await writeAudit(ctx, {
    actorId,
    action: status === 'approved' ? 'approve_request' : 'decline_request',
    targetType: 'waterBodyRequest',
    targetId: row._id,
    reason:
      note || composed`${status === 'approved' ? 'Approved' : 'Declined'} a ${row.kind} request`,
    metadata: {
      kind: row.kind,
      // When it was filed, for a staffer's time to decide (People).
      filedAt: row.createdAt,
      ...(row.waterBodyId ? { waterBodyId: row.waterBodyId } : {}),
      ...(admittedWaterBodyId ? { admittedWaterBodyId } : {}),
      ...(subAreaId ? { subAreaId } : {}),
      ...(landmarkId ? { landmarkId } : {}),
      ...(row._id !== requestId ? { withRequestId: requestId } : {}),
      // Only the primary row names the act: the siblings closed with it share it through the primary.
      // `bodySide` is written on every primary approval — `null` when the act wrote no row — so its
      // undo can tell "nothing to undo on the body" from a row written before the act was recorded.
      ...(row._id === requestId && status === 'approved'
        ? { bodySide: bodyActionId ?? null, ...(bodyActionId ? { bodyActionId } : {}) }
        : {}),
    },
    createdAt: now,
  });
  // Its Inbox member closes, stamped with the primary's row — the one every sibling shares, so the
  // decision's undo reopens them all — and the item is decided with its last open member.
  await decideItem(ctx, requestSource(row._id), {
    now,
    actorId,
    decision: status,
    ...((row._id === requestId ? actionId : primaryActionId) !== undefined
      ? {
          actionId: (row._id === requestId ? actionId : primaryActionId) as Id<'moderationActions'>,
        }
      : {}),
  });
  return actionId;
}

/**
 * **Whether a drain page's decision still stands** (B01-5, the drain race): the primary request is
 * still closed by it — the same status at the same instant. A `reopen_request` landing between two
 * pages reopens the primary, so the next page finds it open and stops, rather than closing more rows
 * the undo meant to leave open; a re-decision since has another instant, and its own drain.
 */
export function decisionStands(
  primary: Pick<Doc<'waterBodyRequests'>, 'status' | 'decidedAt'> | null,
  decision: Pick<Decision, 'status' | 'now'>,
): boolean {
  return primary?.status === decision.status && primary.decidedAt === decision.now;
}

/** What answers a decision, when it isn't the ask alone: an approval's bay or landmark. */
export type DecisionAnswer = {
  subArea?: Pick<Doc<'waterBodySubAreas'>, 'name' | 'aliases'> | null;
  landmark?: Doc<'bodyLandmarks'> | null;
};

/** The most of a person's own open asks read to find one a decision would close. */
export const OWN_ASKS_READ = QUEUE_CAP;

/**
 * Whether `other` is one of the asks a decision on `request` closes with it — `openSiblings`'
 * selection, one row at a time: open and filed by the decision's `asOf`, the same kind, and the same
 * question (the same catalog feature for an admit; for a bay, a name key of the ask's or of its
 * answer's names; for a landmark ask, the same place, or one the answering landmark answers; else the
 * same body).
 */
export function closesWith(
  request: Doc<'waterBodyRequests'>,
  other: Doc<'waterBodyRequests'>,
  answer: DecisionAnswer,
  asOf: number,
): boolean {
  if (other._id === request._id || other.status !== 'open' || other._creationTime > asOf) {
    return false;
  }
  if (other.kind !== request.kind) return false;
  if (request.kind === 'admit') {
    return (
      request.candidateExternalId !== undefined &&
      other.candidateExternalId === request.candidateExternalId
    );
  }
  if (request.waterBodyId === undefined || other.waterBodyId !== request.waterBodyId) return false;
  if (request.kind === 'name_bay') {
    const keys = new Set([requestKeyOf(request)]);
    for (const n of answer.subArea ? bayNames(answer.subArea) : []) {
      keys.add(requestNameKeyFor('name_bay', n));
    }
    return other.nameKey !== undefined && keys.has(other.nameKey);
  }
  if (request.kind === 'name_landmark') {
    const theirs = landmarkAskOf(other);
    return (
      landmarkAsksAreSamePlace(landmarkAskOf(request), theirs) ||
      (answer.landmark != null && landmarkAnswersAsk(answer.landmark, theirs))
    );
  }
  return true;
}

/** A decision's reach past its own ask: the item keys its drain closes, or a body's landmark items. */
type Reach = { keys: Set<string>; landmarkPrefix: string | null };

/** What a decision on `request` closes, as the items its siblings are keyed into (`openSiblings`). */
function reachOf(request: Doc<'waterBodyRequests'>, answer: DecisionAnswer): Reach {
  const keys = new Set<string>();
  const body = request.waterBodyId;
  if (request.kind === 'admit') {
    if (request.candidateExternalId !== undefined) keys.add(`admit:${request.candidateExternalId}`);
    return { keys, landmarkPrefix: null };
  }
  if (body === undefined) return { keys, landmarkPrefix: null };
  if (request.kind === 'name_landmark') return { keys, landmarkPrefix: `landmark:${body}:` };
  if (request.kind === 'name_bay') {
    const names = new Set([requestKeyOf(request)]);
    for (const n of answer.subArea ? bayNames(answer.subArea) : []) {
      names.add(requestNameKeyFor('name_bay', n));
    }
    for (const k of names) keys.add(`bay:${body}:${k}`);
    return { keys, landmarkPrefix: null };
  }
  keys.add(`${request.kind}:${body}`);
  return { keys, landmarkPrefix: null };
}

/**
 * The actor's own open asks, as far as the check could read them: the members they filed (the Inbox
 * ready) or their ask rows (the Inbox still pending) — or `unchecked`, when the read couldn't finish
 * inside its budget.
 */
export type OwnAsks =
  | { by: 'members'; members: Doc<'inboxItemMembers'>[] }
  | { by: 'rows'; rows: Doc<'waterBodyRequests'>[] }
  | 'unchecked';

/**
 * **The actor's own open asks, from small rows** (D289, PR #170). With the Inbox ready every open ask
 * a person filed is the open member of its item (the writer's invariant; a script's asks have none),
 * so the actor's member rows say it all: one indexed read (`by_filer_source_status`) of at most
 * {@link OWN_ASKS_READ} + 1 member rows of 1 KiB, charged at their worst before the read — 201 KiB.
 * While the Inbox is pending, asks the backfill hasn't reached have no member, so their rows are read
 * instead (`by_requester_status_origin`), one at a time: each started only while a whole ask still
 * fits the budget and charged what it weighs (an admit ask carries its catalog polygon, up to the
 * document limit), stopping `unchecked` the moment one doesn't fit. Never past the budget, never a
 * throw; the writers cap a person at 30 open asks, so past {@link OWN_ASKS_READ} it is `unchecked`.
 */
export async function ownAsks(
  ctx: QueryCtx,
  viewerId: Id<'profiles'>,
  budget: ReadBudget,
  pending: boolean,
): Promise<OwnAsks> {
  if (!pending) {
    if (!budget.affordsRead('inboxMember', OWN_ASKS_READ + 1)) return 'unchecked';
    const members = await budget.take('inboxMember', OWN_ASKS_READ + 1, (n) =>
      ctx.db
        .query('inboxItemMembers')
        .withIndex('by_filer_source_status', (q) =>
          q
            .eq('filedByUserId', viewerId)
            .eq('sourceTable', 'waterBodyRequests')
            .eq('status', 'open'),
        )
        .take(n),
    );
    return members.length > OWN_ASKS_READ ? 'unchecked' : { by: 'members', members };
  }
  const rows: Doc<'waterBodyRequests'>[] = [];
  const asks = ctx.db
    .query('waterBodyRequests')
    .withIndex('by_requester_status_origin', (q) =>
      q.eq('requesterId', viewerId).eq('status', 'open').eq('origin', undefined),
    )
    [Symbol.asyncIterator]();
  for (;;) {
    if (rows.length > OWN_ASKS_READ || !budget.affordsRead('waterBodyRequest')) return 'unchecked';
    const next = await asks.next();
    if (next.done) return { by: 'rows', rows };
    budget.reserveCalls(0, 1);
    budget.spend(getDocumentSize(next.value));
    rows.push(next.value);
  }
}

/**
 * **Whether a decision on `request` would close one of the actor's own asks** — `own`, `clear`, or
 * `unchecked` (the check couldn't finish in its budget: the decision is refused with a plain sentence,
 * never decided unseen, and a read still returns its item, `can` carrying the refusal). From members,
 * the drain's reach is compared by item key ({@link reachOf}) — an item row of the member's, read as
 * it weighs — with an ask row read only for a landmark item on the body, whose place is the question
 * ({@link closesWith}), each started only while it fits. From rows, {@link closesWith} directly.
 */
export async function alongsideAnswer(
  ctx: QueryCtx,
  mine: OwnAsks,
  request: Doc<'waterBodyRequests'>,
  answer: DecisionAnswer,
  asOf: number,
  budget: ReadBudget,
): Promise<AlongsideAnswer> {
  if (mine === 'unchecked') return 'unchecked';
  if (mine.by === 'rows') {
    return mine.rows.some((r) => closesWith(request, r, answer, asOf)) ? 'own' : 'clear';
  }
  const reach = reachOf(request, answer);
  for (const m of mine.members) {
    if (m.sourceId === request._id || m.filedAt > asOf) continue;
    const item = await budget.measured('small', () => ctx.db.get(m.itemId));
    if (item === undefined) return 'unchecked';
    if (!item) continue;
    if (reach.keys.has(item.key)) return 'own';
    if (reach.landmarkPrefix !== null && item.key.startsWith(reach.landmarkPrefix)) {
      const id = ctx.db.normalizeId('waterBodyRequests', m.sourceId);
      const ask = id ? await budget.measured('waterBodyRequest', () => ctx.db.get(id)) : null;
      if (ask === undefined) return 'unchecked';
      if (ask && closesWith(request, ask, answer, asOf)) return 'own';
    }
  }
  return 'clear';
}

/**
 * The check's budget in a deciding mutation: what the transaction has left on Convex's byte limit,
 * less the room the decision's own first page needs after it — never more than the check can use.
 */
async function checkBudget(ctx: MutationCtx): Promise<ReadBudget> {
  const m = await ctx.meta.getTransactionMetrics();
  return new ReadBudget(Math.max(0, Math.min(CHECK_BYTES, m.bytesRead.remaining - CHECK_BYTES)));
}

/** At most this much of a deciding transaction's bytes go to the own-filing check. */
const CHECK_BYTES = 4 * 1024 * 1024;

/**
 * **D289 at the decision** — one rule for every caller that decides an ask (the queue's approve and
 * decline, the old editor's bay drawing and landmark add): the Inbox's own rule
 * (`lib/inboxRules.assertInboxVerb`) on the item that holds the ask, so the staffer who filed it is
 * refused in the rule's words, as is a decision on a decided item — and over **every** ask the
 * decision will close (PR #170): one of the actor's own among its siblings, in any item, refuses the
 * whole decision with the own-filing sentence, before anything is written (a decision that silently
 * left the actor's ask open would leave it with no visible reason). An ask a script filed
 * (`origin: 'seed'`) is never an item and is exempt — but only itself: its app-filed siblings are
 * still held to the rule. An ask the backfill hasn't reached is filed first (`itemToDecide`), so it
 * gets the same answer.
 */
export async function assertMayDecide(
  ctx: MutationCtx,
  request: Doc<'waterBodyRequests'>,
  actorId: Id<'profiles'>,
  status: 'approved' | 'declined',
  answer: DecisionAnswer & { asOf?: number } = {},
): Promise<void> {
  const viewer = await ctx.db.get(actorId);
  if (!viewer) throw new ConvexError('Your profile was not found');
  const budget = await checkBudget(ctx);
  const mine = await ownAsks(ctx, actorId, budget, await inboxPending(ctx));
  const alongside = await alongsideAnswer(
    ctx,
    mine,
    request,
    answer,
    answer.asOf ?? Number.POSITIVE_INFINITY,
    budget,
  );
  if (request.origin === 'seed') {
    if (alongside === 'own') throw new ConvexError(OWN_FILING_REFUSAL);
    if (alongside === 'unchecked') throw new ConvexError(ALONGSIDE_UNCHECKED);
    return;
  }
  const item = await itemToDecide(ctx, requestSource(request._id));
  const verb = status === 'approved' ? 'approve' : 'decline';
  if (item) {
    await assertInboxVerb(ctx, viewer, item, verb, {
      requestKind: request.kind,
      hasCandidate: request.candidate !== undefined,
      askedAlongside: { [verb]: alongside },
    });
  } else if (alongside !== 'clear') {
    throw new ConvexError(alongside === 'own' ? OWN_FILING_REFUSAL : ALONGSIDE_UNCHECKED);
  }
}

/**
 * What closing one sibling costs beyond the batch's reconcile: the row read again (twice — the
 * reconcile reads its facts, and a filing reads them again), the audit row's chain and the asker's
 * verdict message, for a landmark ask the body's open asks its place is compared with, its patch, its
 * audit row and its member. Held above what a decline is measured to read per sibling
 * (`inboxBatch.test.ts`), so `batchHasRoom` never budgets less than a sibling reads.
 */
export function siblingCost(row: Doc<'waterBodyRequests'>): TxCost {
  const size = getDocumentSize(row);
  const place = row.kind === 'name_landmark' ? LANDMARK_SCAN * ROW_MAX.waterBodyRequest : 0;
  return {
    // Read again by the reconcile and by a filing, and once more by its own patch, which reads the
    // row it merges into (an ask can carry a catalog polygon near the document limit).
    bytesRead: 3 * size + 4 * ROW_MAX.small + place,
    documentsRead: 14 + (row.kind === 'name_landmark' ? 2 * LANDMARK_SCAN : 0),
    databaseQueries: 8 + (row.kind === 'name_landmark' ? 2 * LANDMARK_SCAN : 0),
    documentsWritten: 6,
    // The patch writes it back whole; its audit row, its member, the asker's message.
    bytesWritten: size + 4 * ROW_MAX.small,
  };
}

/**
 * One page of siblings closed with the decision; the next page scheduled if there is one. The page
 * is one Inbox batch (`inboxBatch`: each item they belong to recounted once, not once per sibling) and
 * is sized against the transaction's live budget (`batchHasRoom`): a sibling starts only while it and
 * every refresh the batch owes still fit, so a group of any size — 500 asks in one item — drains in
 * bounded steps instead of one mutation that grows until it cannot commit (Greptile, PR #63, third
 * pass; PR #170). A page always closes one at least, so the drain advances. Each page comes back empty
 * of the rows the last one closed, and the range ends at `decision.now`, so the drain converges on the
 * group the moderator saw. A landmark decision's pages leave the other places' asks open, so it
 * resumes from a cursor instead — from the same one when the budget, not the page, ended this one.
 */
export async function closeSiblingPage(
  ctx: MutationCtx,
  request: Doc<'waterBodyRequests'>,
  decision: Decision,
): Promise<void> {
  // A page scheduled before an undo reopened the decision closes nothing more (the drain race).
  if (!decisionStands(await ctx.db.get(decision.requestId), decision)) return;
  // The page's read is held to what the transaction can still spend on the rows it reads, then
  // closes (each read three times more and written back once — `siblingCost`), past the refresh
  // the batch owes and the closer's headroom: an ask can weigh near the document limit.
  const m = await ctx.meta.getTransactionMetrics();
  const spare = Math.max(
    0,
    Math.min(
      m.bytesRead.remaining - refreshCost().bytesRead - CLOSER_RESERVE.bytesRead,
      m.bytesWritten.remaining - CLOSER_RESERVE.bytesWritten,
    ),
  );
  const { rows, capped, cursor } = await openSiblings(ctx, request, QUEUE_CAP, decision.now, {
    subArea: decision.subAreaId ? await ctx.db.get(decision.subAreaId) : null,
    landmark: decision.landmarkId ? await ctx.db.get(decision.landmarkId) : null,
    ...(decision.cursor !== undefined ? { cursor: decision.cursor } : {}),
    room: spare / 4,
  });
  let closed = 0;
  await inboxBatch(ctx, async () => {
    for (const row of rows) {
      if (closed > 0 && !(await batchHasRoom(ctx, siblingCost(row)))) break;
      // The decision refused itself over any of the actor's own asks it could see (`assertMayDecide`);
      // one past its scan's bound is left open here, never decided by its own filer (D289).
      if (row.requesterId !== decision.actorId || row.origin === 'seed') {
        await closeRow(ctx, row, decision);
      }
      closed++;
    }
  });
  const cut = closed < rows.length;
  if (cut || capped) {
    const resume = cut ? decision.cursor : cursor;
    const { cursor: _last, ...rest } = decision;
    await ctx.scheduler.runAfter(0, internal.corpusRequests.closeSiblings, {
      ...rest,
      ...(resume !== undefined ? { cursor: resume } : {}),
    });
  }
}

/** What closing one ask costs a page before it is read: {@link siblingCost} at the document limit. */
export const WORST_ASK_COST = (): TxCost => {
  const worst = { kind: 'name_bay' } as Doc<'waterBodyRequests'>;
  const c = siblingCost(worst);
  return {
    ...c,
    bytesRead: c.bytesRead + 3 * ROW_MAX.waterBodyRequest,
    bytesWritten: c.bytesWritten + ROW_MAX.waterBodyRequest,
  };
};

/**
 * **Named asks closed under one decision, a page at a time** (PR #170) — a re-decline closing what a
 * reopen reopened: each read only while the transaction holds one more at its worst
 * ({@link WORST_ASK_COST}) and every refresh the batch owes, always one at least; closed if still open,
 * as one batch; the rest in `inboxWrites.closeRequestsRest`, which stops once the decision is undone.
 */
export async function closeRequestPage(
  ctx: MutationCtx,
  ids: readonly Id<'waterBodyRequests'>[],
  decision: Decision,
): Promise<void> {
  let done = 0;
  await inboxBatch(ctx, async () => {
    for (const id of ids) {
      if (done > 0 && !(await batchHasRoom(ctx, WORST_ASK_COST()))) break;
      done++;
      const row = await ctx.db.get(id);
      if (row?.status === 'open') await closeRow(ctx, row, decision);
    }
  });
  const rest = ids.slice(done);
  if (rest.length > 0 && decision.actionId !== undefined) {
    await ctx.scheduler.runAfter(0, internal.inboxWrites.closeRequestsRest, {
      ...decision,
      ids: [...rest],
    });
  }
}

/** A later page of {@link closeRequestPage}: stopped once the decision it closes under is undone. */
export async function closeRequestsRestPage(
  ctx: MutationCtx,
  args: Decision & { ids: Id<'waterBodyRequests'>[] },
): Promise<void> {
  const { ids, ...decision } = args;
  if (decision.actionId === undefined) return;
  const lead = decision.actionId;
  const undone = await ctx.db
    .query('moderationActions')
    .withIndex('by_undoes', (q) => q.eq('undoesActionId', lead))
    .first();
  if (undone !== null) return;
  await closeRequestPage(ctx, ids, decision);
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
  bodyActionId?: Id<'moderationActions'>,
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
    ...(bodyActionId !== undefined ? { bodyActionId } : {}),
  };
  await assertMayDecide(ctx, request, actorId, status, {
    subArea: subAreaId ? await ctx.db.get(subAreaId) : null,
    landmark: landmarkId ? await ctx.db.get(landmarkId) : null,
    asOf: now,
  });
  // The primary and its first page, one batch: their items recounted once at its end.
  await inboxBatch(ctx, async () => {
    const actionId = await closeRow(ctx, request, decision);
    await closeSiblingPage(ctx, request, { ...decision, actionId });
  });
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
