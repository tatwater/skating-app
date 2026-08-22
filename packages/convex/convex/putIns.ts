/**
 * Put-in markers (Phase 4, decision #7) — routable access points for the map + directions button.
 * A report `point` can be dropped mid-lake / on the ice, so it is NOT itself a put-in: `listForBody`
 * clusters the visible reports' points, snaps each cluster to the nearest shore/road edge, and merges
 * in any admin-set `official` markers, minus moderator-`hidden` coords. Directions always target a
 * put-in coord, never the on-water centroid (which would route you into the middle of the lake).
 *
 * The clustering/snap/geometry lives in `@skating/core` (`clusterPutIns` / `snapToEdge`) so it's pure
 * + tested; this module is the Convex glue + the moderator/admin mutations. The operator UI is the
 * lake editor's Put-ins tool (N6f) — this header promised it "in Phase 7" for three phases while
 * `setOfficial` and `hide` had no caller at all, which is exactly how nobody noticed.
 */

import {
  clusterPutIns,
  DEFAULT_PUTIN_MERGE_METERS,
  distanceToPolygonMeters,
  haversineMeters,
  type LatLng,
  OPERATOR_PUT_IN_SNAP_MAX_M,
  snapToEdge,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, type QueryCtx, query } from './_generated/server';
import { recomputeAccessKind } from './accessPoints';
import { requireContributorRole } from './lib/auth';
import { latLng } from './lib/validators';

/** How many recent reports feed the derived-cluster read — bounds the per-body scan (read-cap). */
const PUTIN_REPORT_SCAN_LIMIT = 200;
/** A derived cluster or official marker within this distance of a `hidden` coord is suppressed. */
const HIDE_SUPPRESS_METERS = DEFAULT_PUTIN_MERGE_METERS;
/** A label on a map pin, not a description — "Town Beach", not a paragraph about the town beach. */
const MAX_PUT_IN_NAME_LENGTH = 60;

/** A put-in marker as the map consumes it: a routable coord, its provenance, and (derived) its weight. */
export interface PutInMarker {
  coord: LatLng;
  source: 'derived' | 'osm' | 'official';
  /**
   * The row's id, on markers that are rows. Absent on a `derived` cluster, which is computed from
   * report points each read and has nothing stable to be identified by.
   */
  id?: string;
  /**
   * The walk from the lot to here, as a line to draw (N6e Workstream 0).
   *
   * Carried on the marker rather than fetched separately because the map is already holding it: this
   * query loads the whole row for the pin, and the drawer's `accessForBody` is a different read on a
   * different surface. Only ever present on a routed hike-in leg.
   *
   * **It inherits this query's suppression rules for free, which is the point of putting it here.**
   * A moderator's `hide` is a coordinate, not a status, so a hidden launch is filtered out of
   * `markers` before it can contribute — and its approach line goes with it. Drawing the line from a
   * second query would have re-created the PR #43 defect exactly: the marker gone from the map while
   * a dashed line still walked to where it used to be.
   */
  approachPath?: LatLng[];
  approachMeters?: number;
  approachAscentM?: number;
  /**
   * The launch's name (N6d/A3) — OSM's where it has one, else the derived compass label.
   *
   * *"Lake Fairlee Boat Ramp"* is what makes a pin worth tapping rather than a dot, and it is the
   * headline of the phase's A3: OSM already names these features, so the names arrive free with the
   * geometry. Absent on `derived` clusters, which are a statistical artefact of report points and have
   * nothing to be named after.
   */
  name?: string;
  reportCount?: number;
  /**
   * When somebody was last known to get on the ice here — the newest `skateEndTime` among the reports
   * that formed the cluster, or the write time for a stored row.
   *
   * Put-ins are the one thing on the map deliberately exempt from every ageing rule in the app (N5a
   * correction 1: access is the corpus's single most-discussed concern, so a marker outlives its
   * season and its author). That exemption is right, and it has a cost this field pays: an access
   * point from three winters ago renders identically to one used last week, while being the kind of
   * fact that *does* go stale — land changes hands, a gate goes up, a pull-off gets posted. Saying
   * when it was last used lets the exemption stand without the marker overclaiming (D3).
   *
   * Absent for `official` markers, which an operator set deliberately and which carry their own
   * authority rather than a date.
   */
  lastUsedAt?: number;
}

/**
 * Split a body's stored `putIns` rows into official markers, **persisted derived** markers, and the
 * hidden coords.
 *
 * The middle bucket has a **history worth knowing before deleting it as dead code**, because it looks
 * like dead code and briefly wasn't. Rows are normally only written by an admin setting an `official`
 * marker, so anything stored as `derived` was ignored on read and the derived markers you actually saw
 * were recomputed from live reports every time. Then account deletion erased a departed skater's
 * reports, which silently erased the access points they revealed — so the purge started materializing
 * the marker before deleting its report, and this bucket is what made those rows visible.
 *
 * The D62 second amendment removed the need by removing the erasure: reports are kept and redacted, so
 * `listForBody` derives a departed skater's put-in exactly as it does everyone else's, and nothing
 * writes a `derived` row any more. The reader stays because rows written by the old path exist on dev
 * and a marker vanishing is precisely the outcome all of this was trying to prevent.
 */
async function loadPutInRows(ctx: QueryCtx, waterBodyId: Id<'waterBodies'>) {
  const rows = await ctx.db
    .query('putIns')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
    .collect();
  const official = rows.filter((r) => r.source === 'official' && r.status === 'visible');
  const osm = rows.filter((r) => r.source === 'osm' && r.status === 'visible');
  const persisted = rows.filter((r) => r.source === 'derived' && r.status === 'visible');
  const hidden = rows.filter((r) => r.status === 'hidden');
  return { official, osm, persisted, hidden };
}

/**
 * The approach fields a stored row contributes to its marker, or nothing.
 *
 * One helper for the two buckets that can have them, so a launch's line and its distance can never
 * be included by one and forgotten by the other — the enumeration failure that cost N6d four
 * separate defects.
 */
function approachOf(row: Doc<'putIns'>): {
  approachPath?: LatLng[];
  approachMeters?: number;
  approachAscentM?: number;
} {
  return {
    ...(row.approachPath ? { approachPath: row.approachPath } : {}),
    ...(row.approachMeters === undefined ? {} : { approachMeters: row.approachMeters }),
    ...(row.approachAscentM === undefined ? {} : { approachAscentM: row.approachAscentM }),
  };
}

/** Is `coord` within the suppression radius of any moderator-hidden coord? */
function isSuppressed(coord: LatLng, hidden: Doc<'putIns'>[]): boolean {
  return hidden.some((h) => haversineMeters(coord, h.coord) <= HIDE_SUPPRESS_METERS);
}

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
    const { official, osm, persisted, hidden } = await loadPutInRows(ctx, waterBodyId);

    // Derived clusters from the visible reports that didn't opt out of showing a put-in (decision #7).
    //
    // ⚠ **This read is deliberately NOT season-scoped, and it is the trap of N5a** (D63, correction 1).
    // Put-ins are exempt from the seasonal reset by founder call — where you can get on the ice doesn't
    // change because the calendar did, and S1 says access is the corpus's single most-discussed
    // concern. But the markers are *derived from reports*, and reports are the most thoroughly
    // season-scoped read in the app. Add a season bound here to match `listByWaterBody` and put-ins
    // silently narrow to this winter's, losing exactly the thing the exemption exists to keep — with
    // no error, no empty state and nothing in a test to notice. The marker's `lastUsedAt` is what keeps
    // an old access point honest instead (D62 second amendment); age is disclosed, never hidden.
    const reports = await ctx.db
      .query('reports')
      .withIndex('by_water_body_skate_end_time', (q) => q.eq('waterBodyId', waterBodyId))
      .order('desc')
      .take(PUTIN_REPORT_SCAN_LIMIT);
    const points = reports
      .filter((r) => r.moderationStatus === 'visible' && r.showPutIn !== false)
      // Carry the skate time along so each cluster can say when its access point was last used. A
      // departed skater's report still counts here — it is kept and redacted (D62 second amendment),
      // so their put-in survives by the ordinary derivation rather than by a special case.
      .map((r) => ({ ...r.point, at: r.skateEndTime }));

    const polygon = body.polygon as unknown as Polygon | MultiPolygon;
    const markers: PutInMarker[] = [];

    // Official markers first (priority styling), unless a hidden coord suppresses them.
    for (const o of official) {
      if (!isSuppressed(o.coord, hidden)) {
        markers.push({
          coord: o.coord,
          source: 'official',
          id: o._id,
          ...(o.name ? { name: o.name } : {}),
          ...approachOf(o),
        });
      }
    }

    // Then the OSM-derived launches (N6d). **Between `official` and `derived`, matching the
    // `PUTIN_SOURCES` ladder**: a mapped slipway is better evidence than a cluster of report points and
    // worse than an operator's pin. Without this bucket they render nowhere — they are neither
    // `official` nor `derived`, so the 3,588 launches the access ETL imported would be invisible on the
    // map while the drawer happily described them.
    for (const row of osm) {
      if (isSuppressed(row.coord, hidden)) continue;
      if (markers.some((m) => haversineMeters(m.coord, row.coord) <= HIDE_SUPPRESS_METERS))
        continue;
      markers.push({
        coord: row.coord,
        source: 'osm',
        id: row._id,
        ...(row.name ? { name: row.name } : {}),
        ...approachOf(row),
      });
    }

    // Then persisted derived markers — access points whose source report has been erased (a departed
    // skater's, `lib/contentPurge`). Same suppression and same official-wins rule as a live cluster;
    // they simply have no report left to be recomputed from.
    for (const row of persisted) {
      if (isSuppressed(row.coord, hidden)) continue;
      if (markers.some((m) => haversineMeters(m.coord, row.coord) <= HIDE_SUPPRESS_METERS))
        continue;
      // `createdAt` is the honest answer for a stored row: it's when the marker was written down, and
      // for the legacy preservation rows that's the sweep that wrote them rather than the skate. It
      // overstates the age by less than it would understate it by claiming nothing.
      markers.push({ coord: row.coord, source: 'derived', lastUsedAt: row.createdAt });
    }

    // Then derived clusters, snapped to shore, dropping suppressed ones and any that coincide with an
    // official marker or a persisted one (the accurate one wins; a duplicate is noise).
    for (const cluster of clusterPutIns(points)) {
      const coord = snapToEdge(cluster.coord, polygon);
      if (isSuppressed(coord, hidden)) continue;
      if (markers.some((m) => haversineMeters(m.coord, coord) <= HIDE_SUPPRESS_METERS)) continue;
      markers.push({
        coord,
        source: 'derived',
        reportCount: cluster.reportCount,
        ...(cluster.lastUsedAt !== undefined ? { lastUsedAt: cluster.lastUsedAt } : {}),
      });
    }

    return markers;
  },
});

/**
 * Admin/moderator: add an `official` put-in marker (accurate, priority styling). Writes a
 * `moderationActions` audit row for accountability.
 *
 * The operator UI is the lake editor's Put-ins tool (N6f) — arm, click the canvas, save. This
 * mutation shipped in Phase 4 with a comment promising that UI "in Phase 7" and went unwired for
 * three phases while the admin card linked to the public map, which never grew a control either.
 *
 * `name` is optional and new with that UI. An `osm` launch arrives with whatever OSM called it and a
 * `derived` one is labelled by compass bearing (`resolvePutInName`), so a hand-placed launch was the
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
    const actor = await requireContributorRole(ctx, 'moderator');
    const body = await ctx.db.get(waterBodyId);
    if (!body) throw new ConvexError('Water body not found');
    const trimmedName = name?.trim();
    if (trimmedName && trimmedName.length > MAX_PUT_IN_NAME_LENGTH) {
      throw new ConvexError(
        `Keep the name under ${MAX_PUT_IN_NAME_LENGTH} characters — it labels a pin on a map.`,
      );
    }

    // **Snap to the shoreline, like every other rung already does** (N6f). `derived` clusters are
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

    const id = await ctx.db.insert('putIns', {
      waterBodyId,
      coord: snapped,
      source: 'official',
      status: 'visible',
      // Absent rather than empty, so `resolvePutInName` falls back to the compass label instead of
      // rendering a launch with a blank name.
      ...(trimmedName ? { name: trimmedName } : {}),
      createdByUserId: actor._id,
      createdAt: Date.now(),
    });
    await ctx.db.insert('moderationActions', {
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
    // The body's denormalized `accessKind` is derived from its visible put-ins, so every mutation
    // that changes that set owes it a recompute (PR #43 review). A fresh `official` marker carries no
    // measured approach, so today this is usually a no-op — `bodyAccessKind` ignores an unknown kind.
    // It is here because the *invariant* is what keeps the chip honest, and the alternative is a rule
    // that holds by luck: the moment this mutation learns to take an approach, or the ladder learns
    // to score an unmeasured official marker, the omission becomes a wrong chip nobody looks for.
    await recomputeAccessKind(ctx, waterBodyId);
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
    const actor = await requireContributorRole(ctx, 'moderator');
    const body = await ctx.db.get(waterBodyId);
    if (!body) throw new ConvexError('Water body not found');
    if (reason.trim().length === 0) throw new ConvexError('A reason is required');
    const id = await ctx.db.insert('putIns', {
      waterBodyId,
      coord,
      source: 'derived',
      status: 'hidden',
      createdByUserId: actor._id,
      createdAt: Date.now(),
    });
    await ctx.db.insert('moderationActions', {
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
    return id;
  },
});
