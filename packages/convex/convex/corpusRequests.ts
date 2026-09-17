/**
 * Corpus requests (N7b PR 2 / D106–D108, D179) — a skater asks for a lake; a moderator answers.
 *
 * Five kinds (`REQUEST_KINDS` in `@skating/core`'s `corpusRequests.ts`, which also says why five):
 * `activate` a dormant body, `admit` water the corpus does not hold, `restore` a removed body,
 * `contest_access` a no-public-access ruling, and a landowner's `takedown`. The client offers exactly
 * the kinds the body's standing admits (`requestKindsFor`) and `create` refuses the rest, so the two
 * cannot disagree.
 *
 * **The `admit` resolver is an action against the live catalogue** (D106, order inverted from the
 * plan — see the core module). `create` schedules it; it fetches the 3DHP waterbody under the point
 * and attaches the polygon with its provenance. A moderator approves geometry that already exists in
 * a catalogue, never a drawing.
 *
 * **Approving a request performs the body-side act through the verb that already exists** —
 * `activateBody`, `restore`, `remove`, `setPublicAccess` — so the audit log reads the same whether a
 * moderator acted from the lake editor or from the queue, and the request row records only the
 * decision on the ask.
 */

import {
  ADMIT_KNOWN_WATER_MARGIN_M,
  catalogueQueryUrl,
  isActive,
  MAX_REQUEST_NOTE_LENGTH,
  nearestBodyForPoint,
  parseCatalogueResponse,
  REQUEST_KINDS,
  type RequestKind,
  requestKindsFor,
  searchTextFor,
  standingOf,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server';
import { resolvePlaceForCoord } from './adminAreas';
import {
  getCurrentProfile,
  requireContributor,
  requireContributorRole,
  requireRole,
} from './lib/auth';
import { publicAuthor } from './lib/authorView';
import { syncWaterBodyCells } from './lib/cellIndex';
import { isListed } from './lib/listing';
import { scoreFields } from './lib/scoring';
import { activateBody, registerWeatherMembership } from './lib/standing';
import { latLng, literals } from './lib/validators';
import { listedBodiesNearCoord } from './waterBodies';

// ── Limits ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Open requests one person may hold at once. The plan's open question — *"one tap per pond is fine;
 * a thousand taps is a moderation queue nobody clears"* — answered with a cap rather than a rate: a
 * skater who has ten unanswered asks has said what they have to say until a moderator catches up.
 */
const MAX_OPEN_REQUESTS_PER_USER = 10;

/** Cap on the moderator queue read. Past this the queue is a backlog, not a list. */
const QUEUE_CAP = 200;

// ── Create ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Member: ask for a lake.
 *
 * For every kind but `admit`, `waterBodyId` names the body and the kind must be one its standing
 * admits. For `admit`, `coord` is the ask, and it is refused when a body we already hold contains
 * the point — with that body's id and standing, so the client can turn the tap into the right
 * request on the right lake instead of minting a second one.
 */
export const create = mutation({
  args: {
    kind: literals(REQUEST_KINDS),
    coord: latLng,
    waterBodyId: v.optional(v.id('waterBodies')),
    activityId: v.optional(v.id('gpsActivities')),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { kind, coord, waterBodyId, activityId, note }) => {
    const profile = await requireContributor(ctx);
    const now = Date.now();
    const trimmedNote = note?.trim();
    if (trimmedNote && trimmedNote.length > MAX_REQUEST_NOTE_LENGTH) {
      throw new ConvexError(`Keep the note under ${MAX_REQUEST_NOTE_LENGTH} characters.`);
    }

    const open = await ctx.db
      .query('waterBodyRequests')
      .withIndex('by_requester_status', (q) =>
        q.eq('requesterId', profile._id).eq('status', 'open'),
      )
      .take(MAX_OPEN_REQUESTS_PER_USER);
    if (open.length >= MAX_OPEN_REQUESTS_PER_USER) {
      throw new ConvexError(
        'You have a few requests waiting on a moderator already — give them a chance to catch up.',
      );
    }

    if (activityId !== undefined) {
      const activity = await ctx.db.get(activityId);
      if (!activity || activity.userId !== profile._id) {
        throw new ConvexError('That skate is not yours');
      }
    }

    if (kind === 'admit') {
      if (waterBodyId !== undefined) {
        throw new ConvexError('An admit request names a place, not a body');
      }
      // Reachable, not merely active (N7b): a dormant or removed body under the tap is the body the
      // skater means, and the right ask is about *it*.
      const body = await bodyUnder(ctx, coord);
      if (body) {
        throw new ConvexError({
          code: 'known_water',
          message: `We already know this water${body.name ? ` — ${body.name}` : ''}.`,
          waterBodyId: body._id,
          standing: standingOf(body),
        });
      }
      const requestId = await ctx.db.insert('waterBodyRequests', {
        kind,
        status: 'open',
        requesterId: profile._id,
        coord,
        ...(activityId !== undefined ? { activityId } : {}),
        ...(trimmedNote ? { note: trimmedNote } : {}),
        createdAt: now,
      });
      // The catalogue lookup cannot happen in a mutation (D106): schedule it.
      await ctx.scheduler.runAfter(0, internal.corpusRequests.resolveAdmit, { requestId });
      return requestId;
    }

    if (waterBodyId === undefined) throw new ConvexError('Which lake?');
    const body = await ctx.db.get(waterBodyId);
    if (!body || !isListed(body)) throw new ConvexError('Water body not found');
    const allowed = requestKindsFor(standingOf(body));
    if (!allowed.includes(kind)) {
      throw new ConvexError(
        kind === 'activate' && isActive(body)
          ? 'This lake is already on the active map.'
          : 'That is not something that can be asked of this lake right now.',
      );
    }
    // One open ask per person per lake per kind: the count of *distinct people* is the signal, and
    // a second row from the same person would inflate it.
    const dupe = (
      await ctx.db
        .query('waterBodyRequests')
        .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId).eq('status', 'open'))
        .collect()
    ).find((r) => r.requesterId === profile._id && r.kind === kind);
    if (dupe) throw new ConvexError('You have already asked — it is with the moderators.');

    return await ctx.db.insert('waterBodyRequests', {
      kind,
      status: 'open',
      requesterId: profile._id,
      coord,
      waterBodyId,
      ...(activityId !== undefined ? { activityId } : {}),
      ...(trimmedNote ? { note: trimmedNote } : {}),
      createdAt: now,
    });
  },
});

// ── The resolver ───────────────────────────────────────────────────────────────────────────────

/**
 * Ask the catalogue what water sits under an `admit` request's coordinate (D106).
 *
 * One HTTP call to the live 3DHP waterbody layer; the parsing is `parseCatalogueResponse` in core,
 * where it is tested against the service's shapes. A miss and a failure are both recorded on the
 * request rather than thrown: the queue shows a moderator "the catalogue has nothing here" or "the
 * service was down" as a row they can act on, and a re-resolve is one button.
 */
export const resolveAdmit = internalAction({
  args: { requestId: v.id('waterBodyRequests') },
  handler: async (ctx, { requestId }): Promise<{ resolved: 'found' | 'none' | 'error' }> => {
    const request = await ctx.runQuery(internal.corpusRequests.getForResolve, { requestId });
    if (!request) return { resolved: 'error' };
    const now = Date.now();
    let json: unknown;
    try {
      const res = await fetch(catalogueQueryUrl(request.coord));
      if (!res.ok) throw new Error(`service returned ${res.status} ${res.statusText}`);
      json = await res.json();
    } catch (err) {
      await ctx.runMutation(internal.corpusRequests.recordResolution, {
        requestId,
        resolvedAt: now,
        resolveError: err instanceof Error ? err.message : String(err),
      });
      return { resolved: 'error' };
    }
    const resolution = parseCatalogueResponse(json, request.coord, now);
    try {
      await ctx.runMutation(internal.corpusRequests.recordResolution, {
        requestId,
        resolvedAt: now,
        ...(resolution.kind === 'found' ? { candidate: resolution.candidate } : {}),
        ...(resolution.kind === 'error' ? { resolveError: resolution.message } : {}),
        ...(resolution.kind === 'none' ? { resolveError: 'No catalogue water at this point' } : {}),
      });
    } catch (err) {
      // A candidate the row cannot hold (a Champlain-sized polygon against the document limit) must
      // not leave the request "waiting" forever: record the failure without the polygon.
      await ctx.runMutation(internal.corpusRequests.recordResolution, {
        requestId,
        resolvedAt: now,
        resolveError: `could not store the catalogue answer: ${err instanceof Error ? err.message : String(err)}`,
      });
      return { resolved: 'error' };
    }
    return { resolved: resolution.kind };
  },
});

export const getForResolve = internalQuery({
  args: { requestId: v.id('waterBodyRequests') },
  handler: async (ctx, { requestId }) => {
    const request = await ctx.db.get(requestId);
    if (!request || request.kind !== 'admit' || request.status !== 'open') return null;
    return { coord: request.coord };
  },
});

const candidateValidator = v.object({
  source: v.literal('3dhp'),
  externalId: v.string(),
  gnisId: v.optional(v.string()),
  name: v.string(),
  cls: v.optional(v.string()),
  featureType: v.number(),
  polygon: v.any(),
  bbox: v.object({
    minLat: v.number(),
    minLng: v.number(),
    maxLat: v.number(),
    maxLng: v.number(),
  }),
  centroid: latLng,
  surfaceAreaSqM: v.number(),
  serviceUrl: v.string(),
  fetchedAt: v.number(),
});

export const recordResolution = internalMutation({
  args: {
    requestId: v.id('waterBodyRequests'),
    resolvedAt: v.number(),
    candidate: v.optional(candidateValidator),
    resolveError: v.optional(v.string()),
  },
  handler: async (ctx, { requestId, resolvedAt, candidate, resolveError }) => {
    const request = await ctx.db.get(requestId);
    if (!request) return;
    await ctx.db.patch(requestId, {
      resolvedAt,
      candidate: candidate
        ? { ...candidate, cls: candidate.cls as Doc<'waterBodies'>['type'] | undefined }
        : undefined,
      candidateExternalId: candidate?.externalId,
      resolveError,
    });
  },
});

/** Moderator: run the resolver again — after an outage, or after the catalogue was updated. */
export const reresolve = mutation({
  args: { requestId: v.id('waterBodyRequests') },
  handler: async (ctx, { requestId }) => {
    await requireContributorRole(ctx, 'moderator');
    const request = await ctx.db.get(requestId);
    if (!request || request.kind !== 'admit') throw new ConvexError('Not an admit request');
    if (request.status !== 'open') throw new ConvexError('This request has been decided');
    await ctx.scheduler.runAfter(0, internal.corpusRequests.resolveAdmit, { requestId });
    return requestId;
  },
});

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The caller's own requests on a body — the drawer's "you asked for this lake" line, with the
 * outcome once there is one. `[]` when signed out.
 */
export const listMineForBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const profile = await getCurrentProfile(ctx);
    if (!profile) return [];
    const rows = await ctx.db
      .query('waterBodyRequests')
      .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
      .collect();
    return rows
      .filter((r) => r.requesterId === profile._id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({
        _id: r._id,
        kind: r.kind,
        status: r.status,
        createdAt: r.createdAt,
        ...(r.decidedAt !== undefined ? { decidedAt: r.decidedAt } : {}),
        ...(r.decisionNote !== undefined ? { decisionNote: r.decisionNote } : {}),
      }));
  },
});

/** The caller's own `admit` requests, newest first — the You tab's "water you asked for" list. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const profile = await getCurrentProfile(ctx);
    if (!profile) return [];
    const rows = await ctx.db
      .query('waterBodyRequests')
      .withIndex('by_requester_created', (q) => q.eq('requesterId', profile._id))
      .order('desc')
      .take(50);
    return rows.map((r) => ({
      _id: r._id,
      kind: r.kind,
      status: r.status,
      coord: r.coord,
      createdAt: r.createdAt,
      ...(r.waterBodyId !== undefined ? { waterBodyId: r.waterBodyId } : {}),
      ...(r.admittedWaterBodyId !== undefined
        ? { admittedWaterBodyId: r.admittedWaterBodyId }
        : {}),
      ...(r.candidate ? { candidateName: r.candidate.name } : {}),
      ...(r.decidedAt !== undefined ? { decidedAt: r.decidedAt } : {}),
      ...(r.decisionNote !== undefined ? { decisionNote: r.decisionNote } : {}),
    }));
  },
});

/**
 * How many distinct people have an open ask of each kind on this body — public, like the pending
 * access-report count: "3 people have asked for this lake back" is the corroboration a moderator
 * ranks by and the reassurance a skater gets that they are not the first.
 */
export const openCountsForBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const rows = await ctx.db
      .query('waterBodyRequests')
      .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId).eq('status', 'open'))
      .take(QUEUE_CAP);
    const counts: Partial<Record<RequestKind, number>> = {};
    for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    return counts;
  },
});

/** Moderator: the queue — open requests, oldest first, each with what a decision needs. */
export const listQueue = query({
  args: { status: v.optional(literals(['open', 'approved', 'declined'] as const)) },
  handler: async (ctx, { status }) => {
    await requireRole(ctx, 'moderator');
    const now = Date.now();
    const rows = await ctx.db
      .query('waterBodyRequests')
      .withIndex('by_status_created', (q) => q.eq('status', status ?? 'open'))
      .order(status === undefined || status === 'open' ? 'asc' : 'desc')
      .take(QUEUE_CAP);
    const out = [];
    for (const r of rows) {
      const requester = await ctx.db.get(r.requesterId);
      const body = r.waterBodyId ? await ctx.db.get(r.waterBodyId) : null;
      const sameBodyOpen = r.status === 'open' ? (await openSiblings(ctx, r)).length + 1 : 1;
      out.push({
        _id: r._id,
        kind: r.kind,
        status: r.status,
        coord: r.coord,
        createdAt: r.createdAt,
        requester: publicAuthor(requester, now),
        ...(r.note !== undefined ? { note: r.note } : {}),
        ...(r.activityId !== undefined ? { activityId: r.activityId } : {}),
        ...(body
          ? {
              body: {
                _id: body._id,
                name: body.name,
                type: body.type,
                states: body.states ?? [],
                surfaceAreaSqM: body.surfaceAreaSqM ?? 0,
                standing: standingOf(body),
              },
            }
          : {}),
        /** Distinct people with the same open ask on the same lake — the rank. */
        askers: sameBodyOpen,
        ...(r.candidate
          ? {
              candidate: {
                name: r.candidate.name,
                externalId: r.candidate.externalId,
                cls: r.candidate.cls,
                featureType: r.candidate.featureType,
                surfaceAreaSqM: r.candidate.surfaceAreaSqM,
                bbox: r.candidate.bbox,
                centroid: r.candidate.centroid,
                serviceUrl: r.candidate.serviceUrl,
              },
            }
          : {}),
        ...(r.resolvedAt !== undefined ? { resolvedAt: r.resolvedAt } : {}),
        ...(r.resolveError !== undefined ? { resolveError: r.resolveError } : {}),
        ...(r.decidedAt !== undefined ? { decidedAt: r.decidedAt } : {}),
        ...(r.decisionNote !== undefined ? { decisionNote: r.decisionNote } : {}),
        ...(r.admittedWaterBodyId !== undefined
          ? { admittedWaterBodyId: r.admittedWaterBodyId }
          : {}),
      });
    }
    return out;
  },
});

export const queueCount = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, 'moderator');
    const rows = await ctx.db
      .query('waterBodyRequests')
      .withIndex('by_status_created', (q) => q.eq('status', 'open'))
      .take(QUEUE_CAP + 1);
    return { count: Math.min(rows.length, QUEUE_CAP), capped: rows.length > QUEUE_CAP };
  },
});

// ── Decide ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Moderator: approve a request — and perform what it asks, through the verb that already exists.
 *
 * `restore` and `takedown` are admin acts (D48), so approving one takes an admin. `admit` needs a
 * resolved candidate with a class we accept; a river or a canal cannot be admitted and the queue says
 * so rather than inventing a class. Every other open ask of the same kind on the same body is
 * approved with it — four people asked, and one decision answers all four.
 */
export const approve = mutation({
  args: { requestId: v.id('waterBodyRequests'), note: v.optional(v.string()) },
  handler: async (ctx, { requestId, note }) => {
    const request = await ctx.db.get(requestId);
    if (!request) throw new ConvexError('Request not found');
    if (request.status !== 'open') throw new ConvexError('This request has been decided');
    const actor = await requireContributorRole(
      ctx,
      request.kind === 'restore' || request.kind === 'takedown' ? 'admin' : 'moderator',
    );
    const now = Date.now();
    const trimmedNote = note?.trim();

    let admittedWaterBodyId: Id<'waterBodies'> | undefined;
    if (request.kind === 'admit') {
      admittedWaterBodyId = await admitCandidate(ctx, request, actor, now);
    } else {
      const body = await ctx.db.get(request.waterBodyId as Id<'waterBodies'>);
      if (!body || !isListed(body)) throw new ConvexError('Water body not found');
      switch (request.kind) {
        case 'activate':
          await activateBody(ctx, body, { via: 'request', actorId: actor._id, now });
          break;
        case 'restore':
          if (body.removedAt === undefined) break; // already back — the ask is moot, still approved
          await ctx.runMutation(api.waterBodies.restore, { waterBodyId: body._id });
          break;
        case 'contest_access':
          // The decision note goes to the requester; the ruling carries none. A public,
          // 160-character note on the lake is a different sentence for a different reader, and the
          // lake editor is where a moderator writes one.
          await ctx.runMutation(api.waterBodies.setPublicAccess, {
            waterBodyId: body._id,
            verdict: 'open',
            reason: 'Public access confirmed on a skater\u2019s request',
          });
          break;
        case 'takedown':
          if (body.removedAt !== undefined) break;
          await ctx.runMutation(api.waterBodies.remove, {
            waterBodyId: body._id,
            reason: 'landowner_request',
          });
          break;
      }
    }

    // The act must have taken: a body that acquired a `none` ruling or a removal after the ask was
    // filed does not come back on an `activate`, and telling the requester it did would be a lie.
    const after = await ctx.db.get(
      admittedWaterBodyId ?? (request.waterBodyId as Id<'waterBodies'>),
    );
    if (!after) throw new ConvexError('Water body not found');
    const outcome = standingOf(after);
    const expectActive = request.kind !== 'takedown';
    if (expectActive ? outcome.standing !== 'active' : outcome.standing !== 'removed') {
      throw new ConvexError(
        expectActive
          ? `This lake is still ${outcome.standing === 'removed' ? 'removed' : 'dormant'}${
              outcome.standing === 'dormant' && outcome.reason === 'no_public_access'
                ? ' under a no-public-access ruling'
                : ''
            } — clear that first in the lake editor, then approve.`
          : 'The removal did not take.',
      );
    }

    await decide(ctx, request, 'approved', actor._id, now, trimmedNote, admittedWaterBodyId);
    return { requestId, ...(admittedWaterBodyId ? { admittedWaterBodyId } : {}) };
  },
});

/** Moderator: decline — with a note the requester reads. Declining is not deleting (D107). */
export const decline = mutation({
  args: { requestId: v.id('waterBodyRequests'), note: v.string() },
  handler: async (ctx, { requestId, note }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const request = await ctx.db.get(requestId);
    if (!request) throw new ConvexError('Request not found');
    if (request.status !== 'open') throw new ConvexError('This request has been decided');
    // The requester reads this; a decline with nothing to read is the "unavailable" with no reason
    // that N7b exists to end. Enforced here, not only in the dialog.
    const trimmed = note.trim();
    if (trimmed.length === 0) throw new ConvexError('Say why — the skater reads this.');
    if (trimmed.length > MAX_REQUEST_NOTE_LENGTH) {
      throw new ConvexError(`Keep the note under ${MAX_REQUEST_NOTE_LENGTH} characters.`);
    }
    await decide(ctx, request, 'declined', actor._id, Date.now(), trimmed);
    return requestId;
  },
});

/**
 * The other open asks that share this one's question: the same kind on the same body, or — for an
 * `admit` — the same catalogue feature (Greptile, PR #63: admits have no body to group by, and two
 * taps on one pond were two independent decisions). An unresolved admit has no siblings yet.
 */
async function openSiblings(
  ctx: QueryCtx,
  request: Doc<'waterBodyRequests'>,
): Promise<Doc<'waterBodyRequests'>[]> {
  if (request.kind === 'admit') {
    if (request.candidateExternalId === undefined) return [];
    const rows = await ctx.db
      .query('waterBodyRequests')
      .withIndex('by_candidate_external_id', (q) =>
        q.eq('candidateExternalId', request.candidateExternalId).eq('status', 'open'),
      )
      .take(QUEUE_CAP);
    return rows.filter((r) => r._id !== request._id);
  }
  if (request.waterBodyId === undefined) return [];
  const rows = await ctx.db
    .query('waterBodyRequests')
    .withIndex('by_water_body', (q) =>
      q.eq('waterBodyId', request.waterBodyId).eq('status', 'open'),
    )
    .take(QUEUE_CAP);
  return rows.filter((r) => r.kind === request.kind && r._id !== request._id);
}

/**
 * Close the request and every open sibling, with one audit row each. Siblings share the decision
 * because they share the question.
 */
async function decide(
  ctx: MutationCtx,
  request: Doc<'waterBodyRequests'>,
  status: 'approved' | 'declined',
  actorId: Id<'profiles'>,
  now: number,
  note: string | undefined,
  admittedWaterBodyId?: Id<'waterBodies'>,
): Promise<void> {
  const siblings = await openSiblings(ctx, request);
  for (const row of [request, ...siblings]) {
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
        ...(row._id !== request._id ? { withRequestId: request._id } : {}),
      },
      createdAt: now,
    });
  }
}

/** The reachable body under a point, within the admit margin — the check `create` makes, repeated. */
async function bodyUnder(
  ctx: QueryCtx,
  coord: { lat: number; lng: number },
): Promise<Doc<'waterBodies'> | null> {
  const nearby = await listedBodiesNearCoord(ctx, coord, ADMIT_KNOWN_WATER_MARGIN_M);
  const known = nearestBodyForPoint(
    coord,
    [...nearby.values()].map((b) => ({
      ref: b._id,
      polygon: b.polygon as unknown as Polygon | MultiPolygon,
      surfaceAreaSqM: b.surfaceAreaSqM ?? 0,
    })),
    ADMIT_KNOWN_WATER_MARGIN_M,
  );
  return known === null ? null : (nearby.get(known) ?? null);
}

/**
 * Insert the catalogue's polygon as a body admitted by request (D107).
 *
 * `includedByRequest` from birth, active, `source: '3dhp'` with the catalogue id as `externalId` and
 * `threeDhpId` — so a later campaign that emits the same feature upserts *this* row rather than a
 * twin, and the transform's floor cannot delete what a person admitted. The enrichment passes find
 * it by `activatedAt` like any other returned body. Refuses, rather than guessing, a candidate the
 * catalogue calls a river or a canal.
 */
async function admitCandidate(
  ctx: MutationCtx,
  request: Doc<'waterBodyRequests'>,
  actor: Doc<'profiles'>,
  now: number,
): Promise<Id<'waterBodies'>> {
  const c = request.candidate;
  if (!c) {
    throw new ConvexError(
      request.resolveError
        ? `The catalogue lookup did not find water here (${request.resolveError}). Re-resolve, or decline.`
        : 'The catalogue lookup has not answered yet.',
    );
  }
  if (c.cls === undefined) {
    throw new ConvexError(
      'The catalogue classifies this as flowing water or a canal, which the corpus does not hold. Decline it, or draw it by hand in the lake editor.',
    );
  }
  // Two guards against a second row for one lake, because the check `create` made is stale by the
  // time a moderator approves: the same-id guard `importCanonical` would apply (a campaign admitted
  // this feature since), and then the same spatial check `create` made (a body admitted without a
  // 3DHP id — a user drawing, an OSM import — now sits under the candidate's point).
  const byId = await ctx.db
    .query('waterBodies')
    .withIndex('by_three_dhp_id', (q) => q.eq('threeDhpId', c.externalId))
    .first();
  const twin = byId ?? (await bodyUnder(ctx, c.centroid));
  if (twin) {
    const twinStanding = standingOf(twin);
    if (twinStanding.standing === 'removed' || twinStanding.standing === 'unlisted') {
      throw new ConvexError(
        'The catalogue feature under this point is a body that was taken off the map. Decline this, or restore that body from the lake editor.',
      );
    }
    if (twinStanding.standing === 'dormant' && twinStanding.reason === 'no_public_access') {
      throw new ConvexError(
        'The catalogue feature under this point is a body under a no-public-access ruling. Decline this, or change the ruling in the lake editor.',
      );
    }
    await activateBody(ctx, twin, {
      via: 'request',
      actorId: actor._id,
      now,
      extraPatch: { includedByRequest: true },
    });
    return twin._id;
  }

  const place = await resolvePlaceForCoord(ctx, c.centroid);
  const scores = scoreFields({ surfaceAreaSqM: c.surfaceAreaSqM, active: true });
  const id = await ctx.db.insert('waterBodies', {
    name: c.name,
    searchText: searchTextFor(c.name, []),
    type: c.cls,
    source: '3dhp',
    externalId: c.externalId,
    threeDhpId: c.externalId,
    ...(c.gnisId !== undefined ? { gnisId: c.gnisId } : {}),
    geometrySource: '3dhp',
    waterBodyKey: `wb_${crypto.randomUUID()}`,
    polygon: c.polygon,
    bbox: c.bbox,
    centroid: c.centroid,
    representativePoint: c.centroid,
    surfaceAreaSqM: c.surfaceAreaSqM,
    sourceAreaSqM: c.surfaceAreaSqM,
    ...(place?.state ? { states: [place.state] } : {}),
    includedByRequest: true,
    activatedAt: now,
    ...scores,
    dedupStatus: 'clean',
    createdAt: now,
  });
  await syncWaterBodyCells(ctx, id, {
    bbox: c.bbox,
    minVisibleZoom: scores.minVisibleZoom,
    listed: true,
  });
  const inserted = await ctx.db.get(id);
  if (inserted) await registerWeatherMembership(ctx, inserted, now);
  await ctx.db.insert('moderationActions', {
    actorId: actor._id,
    action: 'set_included_by_request',
    targetType: 'waterbody',
    targetId: id,
    reason: `Admitted from the catalogue on a skater’s request (3DHP ${c.externalId})`,
    metadata: { includedByRequest: true, requestId: request._id, serviceUrl: c.serviceUrl },
    createdAt: now,
  });
  return id;
}
