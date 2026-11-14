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

import { distanceToPolygonMeters, OPERATOR_PUT_IN_SNAP_MAX_M, snapToEdge } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import { mutation, query } from './_generated/server';
import { recomputeAccessKind } from './accessPoints';
import { writeAudit } from './lib/audit';
import { requireCapability } from './lib/auth';
import { refreshBodyLibrary } from './lib/bodyLibrary';
import { type PutInMarker, putInMarkersForBody } from './lib/putInMarkers';
import { isSuppressed } from './lib/putInSuppression';
import { activateOnEvidence } from './lib/standing';
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

/** A label on a map pin, not a description — "Town Beach", not a paragraph about the town beach. */
const MAX_PUT_IN_NAME_LENGTH = 60;

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
        reason ?? (trimmedName ? `Set official put-in: ${trimmedName}` : 'Set official put-in'),
      // The **snapped** coord, which is what was stored — an audit row recording the raw click
      // would describe a marker that never existed.
      metadata: { coord: snapped, putInId: id, ...(trimmedName ? { name: trimmedName } : {}) },
      createdAt: Date.now(),
    });
    // Standing (A07b, founder call): an official put-in on a dormant body brings it back — a human
    // saying "you can get on the ice here" is evidence of access, and access is what the seed
    // partitions on. And it keeps the body active through the July rollover for as long as it is
    // saved and not hidden (D245, reversing D177's "a put-in alone does not keep a body active").
    await activateOnEvidence(ctx, waterBodyId, 'put_in');
    // The body's denormalized `accessKind` is derived from its visible put-ins, so every mutation
    // that changes that set owes it a recompute (PR #43 review). A fresh `official` marker carries no
    // measured approach, so today this is usually a no-op — `bodyAccessKind` ignores an unknown kind.
    // It is here because the *invariant* is what keeps the chip honest, and the alternative is a rule
    // that holds by luck: the moment this mutation learns to take an approach, or the ladder learns
    // to score an unmeasured official marker, the omission becomes a wrong chip nobody looks for.
    await recomputeAccessKind(ctx, waterBodyId);
    // The approach this changed came after the audit row's refresh: the library reads it again.
    await refreshBodyLibrary(ctx, waterBodyId);
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
