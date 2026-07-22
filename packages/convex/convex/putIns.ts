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
}

/** Split a body's stored `putIns` rows into the official (visible) markers and the hidden coords. */
async function loadPutInRows(ctx: QueryCtx, waterBodyId: Id<'waterBodies'>) {
  const rows = await ctx.db
    .query('putIns')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
    .collect();
  const official = rows.filter((r) => r.source === 'official' && r.status === 'visible');
  const hidden = rows.filter((r) => r.status === 'hidden');
  return { official, hidden };
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
    const { official, hidden } = await loadPutInRows(ctx, waterBodyId);

    // Derived clusters from the visible reports that didn't opt out of showing a put-in (decision #7).
    const reports = await ctx.db
      .query('reports')
      .withIndex('by_water_body_skate_end_time', (q) => q.eq('waterBodyId', waterBodyId))
      .order('desc')
      .take(PUTIN_REPORT_SCAN_LIMIT);
    const points = reports
      .filter((r) => r.moderationStatus === 'visible' && r.showPutIn !== false)
      .map((r) => r.point);

    const polygon = body.polygon as unknown as Polygon | MultiPolygon;
    const markers: PutInMarker[] = [];

    // Official markers first (priority styling), unless a hidden coord suppresses them.
    for (const o of official) {
      if (!isSuppressed(o.coord, hidden)) {
        markers.push({ coord: o.coord, source: 'official' });
      }
    }

    // Then derived clusters, snapped to shore, dropping suppressed ones and any that coincide with an
    // official marker (the accurate one wins).
    for (const cluster of clusterPutIns(points)) {
      const coord = snapToEdge(cluster.coord, polygon);
      if (isSuppressed(coord, hidden)) continue;
      if (
        markers.some(
          (m) => m.source === 'official' && haversineMeters(m.coord, coord) <= HIDE_SUPPRESS_METERS,
        )
      )
        continue;
      markers.push({ coord, source: 'derived', reportCount: cluster.reportCount });
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
