/**
 * Put-in markers (Phase 4, decision #7) — routable access points for the map + directions button.
 * A report `point` can be dropped mid-lake / on the ice, so it is NOT itself a put-in: `listForBody`
 * clusters the visible reports' points, snaps each cluster to the nearest shore/road edge, and merges
 * in any admin-set `official` markers, minus moderator-`hidden` coords. Directions always target a
 * put-in coord, never the on-water centroid (which would route you into the middle of the lake).
 *
 * The clustering/snap/geometry lives in `@skating/core` (`clusterPutIns` / `snapToEdge`) so it's pure
 * + tested; this module is the Convex glue + the moderator/admin mutations (the operator UI is Phase 7).
 */

import {
  clusterPutIns,
  DEFAULT_PUTIN_MERGE_METERS,
  haversineMeters,
  type LatLng,
  snapToEdge,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, type QueryCtx, query } from './_generated/server';
import { requireRole } from './lib/auth';
import { latLng } from './lib/validators';

/** How many recent reports feed the derived-cluster read — bounds the per-body scan (read-cap). */
const PUTIN_REPORT_SCAN_LIMIT = 200;
/** A derived cluster or official marker within this distance of a `hidden` coord is suppressed. */
const HIDE_SUPPRESS_METERS = DEFAULT_PUTIN_MERGE_METERS;

/** A put-in marker as the map consumes it: a routable coord, its provenance, and (derived) its weight. */
export interface PutInMarker {
  coord: LatLng;
  source: 'derived' | 'official';
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
  const persisted = rows.filter((r) => r.source === 'derived' && r.status === 'visible');
  const hidden = rows.filter((r) => r.status === 'hidden');
  return { official, persisted, hidden };
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
    const { official, persisted, hidden } = await loadPutInRows(ctx, waterBodyId);

    // Derived clusters from the visible reports that didn't opt out of showing a put-in (decision #7).
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
        markers.push({ coord: o.coord, source: 'official' });
      }
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
 * Admin/moderator: add an `official` put-in marker (accurate, priority styling). The operator UI is
 * Phase 7; the data + mutation land here. Writes a `moderationActions` audit row for accountability.
 */
export const setOfficial = mutation({
  args: { waterBodyId: v.id('waterBodies'), coord: latLng, reason: v.optional(v.string()) },
  handler: async (ctx, { waterBodyId, coord, reason }) => {
    const actor = await requireRole(ctx, 'moderator');
    const body = await ctx.db.get(waterBodyId);
    if (!body) throw new ConvexError('Water body not found');
    const id = await ctx.db.insert('putIns', {
      waterBodyId,
      coord,
      source: 'official',
      status: 'visible',
      createdByUserId: actor._id,
      createdAt: Date.now(),
    });
    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'set_put_in', // a dedicated verb — placing an official marker, not un-hiding one
      targetType: 'waterbody',
      targetId: waterBodyId,
      reason: reason ?? 'Set official put-in',
      metadata: { coord, putInId: id },
      createdAt: Date.now(),
    });
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
    const actor = await requireRole(ctx, 'moderator');
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
    return id;
  },
});
