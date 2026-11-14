/**
 * A body's put-in markers (decision #7, A06d) — the derivation `putIns.listForBody` serves, in a lib
 * so the Bodies library's writer (`lib/bodyLibrary.ts`) can read the same rule without importing
 * `putIns.ts` (whose imports reach `lib/audit.ts`, which calls that writer).
 */

import { clusterPutIns, haversineMeters, type LatLng, snapToEdge } from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { HIDE_SUPPRESS_METERS, isSuppressed } from './putInSuppression';

/** How many recent reports feed the derived-cluster read — bounds the per-body scan (read-cap). */
const PUTIN_REPORT_SCAN_LIMIT = 200;

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
   * The walk from the lot to here, as a line to draw (A06e Workstream 0).
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
   * The launch's name (A06d §1.3) — OSM's where it has one, else the derived compass label.
   *
   * *"Lake Fairlee Boat Ramp"* is what makes a pin worth tapping rather than a dot, and it is the
   * headline of the phase's A06d §1.3: OSM already names these features, so the names arrive free with the
   * geometry. Absent on `derived` clusters, which are a statistical artifact of report points and have
   * nothing to be named after.
   */
  name?: string;
  reportCount?: number;
  /**
   * When somebody was last known to get on the ice here — the newest `skateEndTime` among the reports
   * that formed the cluster, or the write time for a stored row.
   *
   * Put-ins are the one thing on the map deliberately exempt from every aging rule in the app (A05a
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
export async function loadPutInRows(ctx: QueryCtx, waterBodyId: Id<'waterBodies'>) {
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
 * be included by one and forgotten by the other — the enumeration failure that cost A06d four
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

/** How many of a body's newest reports a put-in derivation reads — the scan `listForBody` makes. */
export const PUT_IN_REPORT_SCAN = PUTIN_REPORT_SCAN_LIMIT;

/**
 * A body's put-in markers, as `listForBody` returns them — one rule for the map and for the Bodies
 * library's put-ins fact (B01-3), so the two cannot disagree about whether a body has a launch.
 *
 * `reports`, when given, are the body's newest reports by skate end (`by_water_body_skate_end_time`,
 * descending) the caller already read; the first {@link PUT_IN_REPORT_SCAN} stand in for this read.
 * `firstOnly` returns as soon as one marker is known, reading reports only when no stored marker
 * survives its suppression.
 */
export async function putInMarkersForBody(
  ctx: QueryCtx,
  body: Doc<'waterBodies'>,
  opts: { reports?: readonly Doc<'reports'>[]; firstOnly?: boolean } = {},
): Promise<PutInMarker[]> {
  const waterBodyId = body._id;
  const { official, osm, persisted, hidden } = await loadPutInRows(ctx, waterBodyId);

  // Derived clusters from the visible reports that didn't opt out of showing a put-in (decision #7).
  //
  // ⚠ **This read is deliberately NOT season-scoped, and it is the trap of A05a** (D63, correction 1).
  // Put-ins are exempt from the seasonal reset by founder call — where you can get on the ice doesn't
  // change because the calendar did, and S1 says access is the corpus's single most-discussed
  // concern. But the markers are *derived from reports*, and reports are the most thoroughly
  // season-scoped read in the app. Add a season bound here to match `listByWaterBody` and put-ins
  // silently narrow to this winter's, losing exactly the thing the exemption exists to keep — with
  // no error, no empty state and nothing in a test to notice. The marker's `lastUsedAt` is what keeps
  // an old access point honest instead (D62 second amendment); age is disclosed, never hidden.
  const stored = [...official, ...osm, ...persisted];
  if (opts.firstOnly === true && stored.some((r) => !isSuppressed(r.coord, hidden))) {
    const first = stored.find((r) => !isSuppressed(r.coord, hidden)) as Doc<'putIns'>;
    return [{ coord: first.coord, source: first.source, id: first._id }];
  }
  const reports =
    opts.reports !== undefined
      ? opts.reports.slice(0, PUTIN_REPORT_SCAN_LIMIT)
      : await ctx.db
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

  // Then the OSM-derived launches (A06d). **Between `official` and `derived`, matching the
  // `PUTIN_SOURCES` ladder**: a mapped slipway is better evidence than a cluster of report points and
  // worse than an operator's pin. Without this bucket they render nowhere — they are neither
  // `official` nor `derived`, so the 3,588 launches the access ETL imported would be invisible on the
  // map while the drawer happily described them.
  for (const row of osm) {
    if (isSuppressed(row.coord, hidden)) continue;
    if (markers.some((m) => haversineMeters(m.coord, row.coord) <= HIDE_SUPPRESS_METERS)) continue;
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
    if (markers.some((m) => haversineMeters(m.coord, row.coord) <= HIDE_SUPPRESS_METERS)) continue;
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
}
