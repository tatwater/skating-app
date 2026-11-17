/**
 * Put-in markers (Phase 04, decision #7) — routable access points for the map + directions button.
 * A report `point` can be dropped mid-lake / on the ice, so it is NOT itself a put-in: `listForBody`
 * clusters the visible reports' points, snaps each cluster to the nearest shore/road edge, and merges
 * in any admin-set `official` markers, minus moderator-`hidden` coords. Directions always target a
 * put-in coord, never the on-water centroid (which would route you into the middle of the lake).
 *
 * The clustering/snap/geometry lives in `@skating/core` (`clusterPutIns` / `snapToEdge`) so it's pure
 * + tested; this module is the Convex glue + the moderator/admin mutations. The operator UI is the
 * lake editor's Put-ins tool (A06f) — this header promised it "in Phase 07" for three phases while
 * `setOfficial` and `hide` had no caller at all, which is exactly how nobody noticed.
 */

import {
  distanceToPolygonMeters,
  MAX_PUT_IN_NAME_LENGTH,
  OPERATOR_PUT_IN_SNAP_MAX_M,
  snapToEdge,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from './_generated/dataModel';
import { type MutationCtx, mutation, type QueryCtx, query } from './_generated/server';
import { recomputeAccessKind } from './accessPoints';
import { composed, writeAudit } from './lib/audit';
import { requireCapability } from './lib/auth';
import { refreshBodyLibrary } from './lib/bodyLibrary';
import { type PutInMarker, putInMarkersForBody } from './lib/putInMarkers';
import { isSuppressed } from './lib/putInSuppression';
import { activateOnEvidence } from './lib/standing';
import { UNDO_POLICY } from './lib/undoPolicy';
import { latLng } from './lib/validators';

export {
  loadPutInRows,
  PUT_IN_REPORT_SCAN,
  type PutInMarker,
  putInMarkersForBody,
} from './lib/putInMarkers';

import { resolveSubAreaForPutIn } from './subAreas';

// The suppression rule itself lives in `lib/putInSuppression` (so `subAreas` can apply it without a
// module cycle); re-exported here because this is where readers of put-ins look for it.
export { isSuppressed };

// A launch's name is a label on a map pin, not a description — "Town Beach", not a paragraph about
// the town beach: `MAX_PUT_IN_NAME_LENGTH`, defined once in core's `textCaps` so the old editor's
// field takes the same number (B01-3o).

/**
 * The put-in markers for a water body (decision #7): admin `official` markers first (priority), then
 * `derived` clusters of visible reports' put-in points — each snapped to the nearest shore/road edge —
 * with any coord a moderator hid (or a report that opted out of `showPutIn`) removed. Returns `[]` for
 * an unknown body. Derived markers are approximate; official ones are accurate.
 */
export const listForBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }): Promise<PutInMarker[]> => {
    const body = await ctx.db.get(waterBodyId);
    if (!body) return [];
    return putInMarkersForBody(ctx, body);
  },
});

/**
 * Admin/moderator: add an `official` put-in marker (accurate, priority styling). Writes a
 * `moderationActions` audit row for accountability.
 *
 * The operator UI is the lake editor's Put-ins tool (A06f) — arm, click the canvas, save. This
 * mutation shipped in Phase 04 with a comment promising that UI "in Phase 07" and went unwired for
 * three phases while the admin card linked to the public map, which never grew a control either.
 *
 * `name` is optional and new with that UI. An `osm` launch arrives with whatever OSM called it and a
 * `derived` one is labeled by compass bearing (`resolvePutInName`), so a hand-placed launch was the
 * one rung that could never be named — despite being the rung where somebody actually knows.
 */
export const setOfficial = mutation({
  args: {
    waterBodyId: v.id('waterBodies'),
    coord: latLng,
    name: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { waterBodyId, coord, name, reason }) => {
    const actor = await requireCapability(ctx, 'body.access');
    const body = await ctx.db.get(waterBodyId);
    if (!body) throw new ConvexError('Water body not found');
    const trimmedName = name?.trim();
    if (trimmedName && trimmedName.length > MAX_PUT_IN_NAME_LENGTH) {
      throw new ConvexError(
        `Keep the name under ${MAX_PUT_IN_NAME_LENGTH} characters — it labels a pin on a map.`,
      );
    }

    // **Snap to the shoreline, like every other rung already does** (A06f). `derived` clusters are
    // snapped in `listForBody` because a report's `point` is where somebody *skated*, which is often
    // mid-lake; `osm` launches arrive on the shore by construction. `official` — the one rung a human
    // places by hand — was the only one stored raw, so an operator's click landed exactly where they
    // tapped and a slightly-off tap left a pin floating on the water.
    //
    // That is not merely untidy. A put-in coord is the **directions destination** (D#7), and the
    // stated reason put-ins exist at all is that routing to a point on the water sends someone into
    // the middle of the lake. A hand-placed floating pin reintroduces precisely that, one lake at a
    // time.
    const polygon = body.polygon as unknown as Polygon | MultiPolygon;
    const outsideM = distanceToPolygonMeters(coord, polygon);
    if (outsideM > OPERATOR_PUT_IN_SNAP_MAX_M) {
      throw new ConvexError(
        `That point is ${Math.round(outsideM)} m from the water — too far to snap to the shore. If you meant the parking, place a parking area instead.`,
      );
    }
    const snapped = snapToEdge(coord, polygon);
    // The bay this launch serves (A09) — by distance to the bay's outline, since the coord was just
    // snapped onto the shoreline that outline traces. Absent on the ~99% of bodies with no bays.
    const subAreaId = await resolveSubAreaForPutIn(ctx, waterBodyId, snapped);

    const id = await ctx.db.insert('putIns', {
      waterBodyId,
      coord: snapped,
      source: 'official',
      status: 'visible',
      // Absent rather than empty, so `resolvePutInName` falls back to the compass label instead of
      // rendering a launch with a blank name.
      ...(trimmedName ? { name: trimmedName } : {}),
      ...(subAreaId !== undefined ? { subAreaId } : {}),
      createdByUserId: actor._id,
      createdAt: Date.now(),
    });
    await writeAudit(ctx, {
      actorId: actor._id,
      action: 'set_put_in', // a dedicated verb — placing an official marker, not un-hiding one
      targetType: 'waterbody',
      targetId: waterBodyId,
      reason:
        reason ??
        (trimmedName ? composed`Set official put-in: ${trimmedName}` : 'Set official put-in'),
      // The **snapped** coord, which is what was stored — an audit row recording the raw click
      // would describe a marker that never existed.
      metadata: { coord: snapped, putInId: id, ...(trimmedName ? { name: trimmedName } : {}) },
      createdAt: Date.now(),
    });
    // Standing (A07b, founder call): an official put-in on a dormant body brings it back — a human
    // saying "you can get on the ice here" is evidence of access, and access is what the seed
    // partitions on. And it keeps the body active through the July rollover for as long as it is
    // saved and not hidden (D245, reversing D177's "a put-in alone does not keep a body active").
    // Then the denormalized `accessKind`, recomputed from the visible put-ins (PR #43 review), and
    // the library row — the steps every put-in write owes, shared with `promote`.
    await afterPutInChange(ctx, waterBodyId, true);
    return id;
  },
});

/**
 * Moderator: hide a put-in coord (decision #7). Writes a `hidden` suppression row so the coord stays
 * suppressed even after re-clustering (one action outlives however many reports feed the marker), plus
 * a `moderationActions` audit row. A `reason` is required (accountability).
 */
export const hide = mutation({
  args: { waterBodyId: v.id('waterBodies'), coord: latLng, reason: v.string() },
  handler: async (ctx, { waterBodyId, coord, reason }) => {
    const actor = await requireCapability(ctx, 'body.access');
    const body = await ctx.db.get(waterBodyId);
    if (!body) throw new ConvexError('Water body not found');
    if (reason.trim().length === 0) throw new ConvexError('A reason is required');
    // Stamped like any other row (A09), so a bay-scoped access read can find the suppression rows
    // that apply to its shore without re-deriving them from the coordinate.
    const subAreaId = await resolveSubAreaForPutIn(ctx, waterBodyId, coord);
    const id = await ctx.db.insert('putIns', {
      waterBodyId,
      coord,
      source: 'derived',
      status: 'hidden',
      ...(subAreaId !== undefined ? { subAreaId } : {}),
      createdByUserId: actor._id,
      createdAt: Date.now(),
    });
    await writeAudit(ctx, {
      actorId: actor._id,
      action: 'hide',
      targetType: 'waterbody',
      targetId: waterBodyId,
      reason,
      metadata: { coord, putInId: id },
      createdAt: Date.now(),
    });
    // ⚠ **This one is not a no-op, and it is the case the review found.** A hide suppresses every
    // launch within `DEFAULT_PUTIN_MERGE_METERS` of the coord, so hiding a lake's only hike-in launch
    // has to take the Hike-In chip with it — otherwise the map draws no marker while the card still
    // warns about a walk to a launch that is no longer there.
    await recomputeAccessKind(ctx, waterBodyId);
    // The approach this changed came after the audit row's refresh: the library reads it again.
    await refreshBodyLibrary(ctx, waterBodyId);
    return id;
  },
});

// ── Making a launch official in place (B01-3d) ───────────────────────────────────────────────

/** What a promotion replaced, so its undo can put it back. */
interface PromotionPrev {
  source: 'osm' | 'derived';
  name: string | null;
  createdByUserId: Id<'profiles'> | null;
}

/** A launch's name, normalized at the edge: whitespace collapsed, capped like `setOfficial`'s. */
function putInName(raw: string | undefined): string | undefined {
  const name = raw?.replace(/\s+/g, ' ').trim();
  if (!name) return undefined;
  if (name.length > MAX_PUT_IN_NAME_LENGTH) {
    throw new ConvexError(
      `Keep the name under ${MAX_PUT_IN_NAME_LENGTH} characters — it labels a pin on a map.`,
    );
  }
  return name;
}

/** The stored put-in a promotion acts on, with the refusals every direction shares. */
async function promotableRow(
  ctx: MutationCtx,
  putInId: Id<'putIns'>,
): Promise<{ row: Doc<'putIns'>; body: Doc<'waterBodies'> }> {
  const row = await ctx.db.get(putInId);
  const refused = await launchRefusal(ctx, row);
  if (refused !== null || !row) throw new ConvexError(refused ?? 'That put-in no longer exists');
  const body = await ctx.db.get(row.waterBodyId);
  if (!body) throw new ConvexError('Water body not found');
  if (body.dedupStatus === 'merged') {
    throw new ConvexError('This body was merged into another — edit the body it was merged into');
  }
  return { row, body };
}

/**
 * Why a promotion, or its undo, is refused on this launch as it stands — gone, hidden, or at a spot a
 * moderator hid another launch — or `null`. One rule for the write and for whether its undo is offered
 * (B01-3d): a hide is audited on the put-in, and an import moves or drops launches with no row, so
 * neither overtakes the body's `set_put_in` row. (A merged-away body is the merge's own row on it.)
 */
export async function launchRefusal(
  ctx: QueryCtx | MutationCtx,
  row: Doc<'putIns'> | null,
): Promise<string | null> {
  if (!row) return 'That put-in no longer exists';
  return launchRefusalOf(
    row,
    await hiddenLaunches(ctx, row.waterBodyId).take(SUPPRESSION_ROWS_READ),
  );
}

/** {@link launchRefusal} on the hidden launches its caller read — one rule, however they're read. */
export function launchRefusalOf(
  row: Doc<'putIns'>,
  hidden: readonly { coord: { lat: number; lng: number } }[],
): string | null {
  if (row.status !== 'visible')
    return 'That put-in is hidden — a moderator said it is not a way in';
  if (isSuppressed(row.coord, hidden)) {
    return 'A moderator hid a put-in at this spot — it is not a way in';
  }
  return null;
}

/** A body's hidden launches, as the suppression check reads them. */
export function hiddenLaunches(ctx: QueryCtx | MutationCtx, waterBodyId: Id<'waterBodies'>) {
  return ctx.db
    .query('putIns')
    .withIndex('by_water_body_status', (q) =>
      q.eq('waterBodyId', waterBodyId).eq('status', 'hidden'),
    );
}

/** A launch as an undo recorded it: where it was and what it was called. */
export interface LaunchAsRecorded {
  coord: { lat: number; lng: number };
  name: string | null;
}

/**
 * Why promoting or demoting a launch is refused for its source and the launch the undo recorded, or
 * `null` — the checks `launchRefusal` leaves to the direction.
 */
export function directionRefusal(
  row: Doc<'putIns'>,
  direction: 'promote' | 'demote',
  expected: LaunchAsRecorded | undefined,
): string | null {
  if (direction === 'promote' && row.source === 'official')
    return 'That put-in is already official';
  if (direction === 'demote' && row.source !== 'official')
    return 'That put-in is no longer official';
  if (
    expected !== undefined &&
    (row.coord.lat !== expected.coord.lat ||
      row.coord.lng !== expected.coord.lng ||
      (row.name ?? null) !== expected.name)
  ) {
    return direction === 'promote'
      ? 'That put-in changed since — undo is not safe now'
      : 'That put-in changed since it was made official — undo is not safe now';
  }
  return null;
}

/**
 * Hidden coordinates a promotion checks its launch against (a body holds a handful) — and so the
 * documents its undo's refusal reads, which its share reserves (`refusalCost`, `lib/undoHandlersBody`).
 */
export const SUPPRESSION_ROWS_READ = 200;

/**
 * Moderator: make a stored launch official **in place** (B01-3d, `body.access`) — the Access tab's
 * *Make official*. The same row, point and bay; its parking, its walk and its approach-kind override
 * kept; the name set only when one is given. `setOfficial` stays for placing a new point.
 *
 * **Which launches:** the stored rows the Access tab lists (`accessForBody`) — an `osm` launch, or a
 * persisted `derived` one. A live report cluster has no row and never appears in that list; making
 * one official is placing a point there (`setOfficial` at its coordinate, which then wins over the
 * cluster on the map). Refused: an official, hidden or suppressed launch, one on a merged-away body,
 * or a missing one.
 *
 * Returns `{ putInId, actionId, undoNeedsReason }` so the console's toast can undo it directly.
 */
export const promote = mutation({
  args: { putInId: v.id('putIns'), name: v.optional(v.string()), reason: v.optional(v.string()) },
  handler: async (ctx, { putInId, name, reason }) => {
    const actor = await requireCapability(ctx, 'body.access');
    return promotePutInImpl(ctx, actor, { putInId, name, reason });
  },
});

/** `promote`'s body — also what undoing its undo runs (D226). */
export async function promotePutInImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  args: {
    putInId: Id<'putIns'>;
    name?: string | undefined;
    reason?: string | undefined;
    /** The launch as the undo it redoes left it — refused if it moved or was renamed since. */
    expected?: LaunchAsRecorded;
  },
): Promise<{ putInId: Id<'putIns'>; actionId: Id<'moderationActions'>; undoNeedsReason: boolean }> {
  const { row, body } = await promotableRow(ctx, args.putInId);
  const refused = directionRefusal(row, 'promote', args.expected);
  if (refused !== null || row.source === 'official') {
    throw new ConvexError(refused ?? 'That put-in is already official');
  }
  const name = putInName(args.name);
  const prev: PromotionPrev = {
    source: row.source,
    name: row.name ?? null,
    createdByUserId: row.createdByUserId ?? null,
  };
  await ctx.db.patch(row._id, {
    source: 'official',
    createdByUserId: actor._id,
    ...(name !== undefined ? { name } : {}),
  });
  const after = name ?? row.name;
  const actionId = await writeAudit(ctx, {
    actorId: actor._id,
    action: 'set_put_in',
    targetType: 'waterbody',
    targetId: body._id,
    reason:
      args.reason?.trim() ||
      (after ? composed`Made the put-in official: ${after}` : 'Made the put-in official'),
    metadata: {
      putInId: row._id,
      coord: row.coord,
      direction: 'promoted',
      ...(after ? { name: after } : {}),
      prev,
    },
    createdAt: Date.now(),
  });
  await afterPutInChange(ctx, body._id, true);
  return {
    putInId: row._id,
    actionId,
    undoNeedsReason: UNDO_POLICY.set_put_in.takesAway('promoted'),
  };
}

/**
 * Undo a promotion: the source and name it replaced, the row, its lot and its walk left as they are.
 * Refused — by the same checks a promotion takes — when the launch changed since: hidden or
 * suppressed, moved, no longer official, or renamed.
 */
export async function demotePutInImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  args: {
    putInId: Id<'putIns'>;
    prev: PromotionPrev;
    expected: LaunchAsRecorded;
    reason: string;
  },
): Promise<void> {
  const { row, body } = await promotableRow(ctx, args.putInId);
  const refused = directionRefusal(row, 'demote', args.expected);
  if (refused !== null) throw new ConvexError(refused);
  await ctx.db.patch(row._id, {
    source: args.prev.source,
    name: args.prev.name ?? undefined,
    createdByUserId: args.prev.createdByUserId ?? undefined,
  });
  await writeAudit(ctx, {
    actorId: actor._id,
    action: 'set_put_in',
    targetType: 'waterbody',
    targetId: body._id,
    reason: args.reason,
    metadata: {
      putInId: row._id,
      coord: row.coord,
      direction: 'demoted',
      prev: { source: 'official', name: row.name ?? null },
      ...(args.prev.name !== null ? { name: args.prev.name } : {}),
    },
    createdAt: Date.now(),
  });
  // A visible launch keeps a body active either way: demoting it never shelves one.
  await afterPutInChange(ctx, body._id, false);
}

/** What every put-in write owes after it: the body back if it was shelved, its access kind, its row. */
async function afterPutInChange(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  evidence: boolean,
): Promise<void> {
  if (evidence) await activateOnEvidence(ctx, waterBodyId, 'put_in');
  await recomputeAccessKind(ctx, waterBodyId);
  await refreshBodyLibrary(ctx, waterBodyId);
}
