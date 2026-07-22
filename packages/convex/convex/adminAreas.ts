/**
 * Administrative-boundary functions (Phase 5) — the point→place resolver behind the newsfeed's
 * location label and the idempotent OSM boundary importer that feeds it.
 *
 * A report's `point` (put-in pin / GPS start) resolves against these polygons to
 * `{ town?, county?, state? }`, stamped onto `reports.place` at create so the feed reads the label
 * directly (no per-read geocode; works for an offline flush because the mutation runs at flush).
 * Reuses the shared `@skating/core` `bboxIntersects` / `pointInPolygon` primitives — no external
 * geocoder. Reused by GPS ingest (Phase 8) + hazards (Phase 9).
 */

import { bboxIntersects, pointInPolygon } from '@skating/core';
import { v } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type QueryCtx, query } from './_generated/server';
import { ADMIN_AREA_LEVELS } from './lib/enums';
import { adminAreasGeo } from './lib/geospatial';
import { bbox, geoJson, latLng, literals } from './lib/validators';

/** An admin-boundary row as the offline `scripts/admin-areas` pipeline prepares it. */
const adminArea = v.object({
  externalId: v.string(), // OSM relation id — the idempotent upsert key
  name: v.string(), // this row's own name ("Burlington" / "Chittenden County")
  level: literals(ADMIN_AREA_LEVELS),
  state: v.string(), // 2-letter code, denormalized onto the label
  polygon: geoJson,
  bbox,
  centroid: latLng,
});

/**
 * Internal, never client-callable: idempotently upsert a batch of admin boundaries (Phase 5). Load
 * via `pnpm exec convex run` from `scripts/admin-areas` (chunk batches for the mutation read/size
 * limits, like the water ETL). Keyed on `by_external_id` — re-running on unchanged data is a no-op.
 */
export const importCanonical = internalMutation({
  args: { areas: v.array(adminArea) },
  handler: async (ctx, { areas }) => {
    let inserted = 0;
    let updated = 0;
    for (const item of areas) {
      const existing = await ctx.db
        .query('adminAreas')
        .withIndex('by_external_id', (q) => q.eq('externalId', item.externalId))
        .unique();

      let id: Id<'adminAreas'>;
      if (existing) {
        await ctx.db.patch(existing._id, {
          name: item.name,
          level: item.level,
          state: item.state,
          polygon: item.polygon,
          bbox: item.bbox,
          centroid: item.centroid,
        });
        id = existing._id;
        updated++;
      } else {
        id = await ctx.db.insert('adminAreas', {
          externalId: item.externalId,
          name: item.name,
          level: item.level,
          state: item.state,
          polygon: item.polygon,
          bbox: item.bbox,
          centroid: item.centroid,
          createdAt: Date.now(),
        });
        inserted++;
      }
      // Re-index the centroid in one place for both paths. `GeospatialIndex.insert` is
      // upsert-by-key: the component removes any existing point for this doc id before inserting
      // (see @convex-dev/geospatial `document.insert` → `removePointByKey`), so re-running the
      // import overwrites a boundary's centroid rather than stacking duplicates — which would eat
      // into `findContainingTown`'s read cap (the same pressure that forced the 0.2° margin).
      await adminAreasGeo.insert(
        ctx,
        id,
        { latitude: item.centroid.lat, longitude: item.centroid.lng },
        { level: item.level },
      );
    }
    return { inserted, updated };
  },
});

/** A degenerate (zero-area) bbox at a point — lets `bboxIntersects` do a cheap point-in-bbox test. */
function pointBBox(point: { lat: number; lng: number }) {
  return { minLat: point.lat, maxLat: point.lat, minLng: point.lng, maxLng: point.lng };
}

/** True when `point` is inside an admin area's boundary (cheap bbox prefilter → Turf refine). */
function pointInArea(point: { lat: number; lng: number }, area: Doc<'adminAreas'>): boolean {
  if (!bboxIntersects(area.bbox, pointBBox(point))) return false;
  return pointInPolygon(point, area.polygon as unknown as Polygon | MultiPolygon);
}

/**
 * Half-width (degrees) of the centroid rectangle used to find the containing **town**. Sized to
 * comfortably contain a town's centroid from any interior point (a town's centroid sits within ~half
 * its diameter of any point it contains, and our towns run well under 0.4° across) while keeping the
 * rectangle's S2 covering small — a wider box blows the geospatial component's ~1024-row read cap in
 * the dense NY/MA town belt (measured: a 1° box read 1045 rows and capped, missing the target town).
 * A town larger than this margin can allow degrades to a county+state label (a fine fallback), never
 * a wrong town. Counties/states are far larger (a centroid can sit degrees from an interior point),
 * so those levels are scanned by the `by_level` index (a handful of rows), not queried geospatially.
 */
const TOWN_QUERY_MARGIN_DEG = 0.2;
/** Cap on town centroids pulled from the prefilter — the small rectangle holds far fewer in practice. */
const TOWN_QUERY_LIMIT = 128;

/** Find the town containing `point` via the geospatial centroid prefilter + a `pointInPolygon` refine. */
async function findContainingTown(
  ctx: QueryCtx,
  point: { lat: number; lng: number },
): Promise<Doc<'adminAreas'> | null> {
  const rectangle = {
    west: point.lng - TOWN_QUERY_MARGIN_DEG,
    east: point.lng + TOWN_QUERY_MARGIN_DEG,
    south: point.lat - TOWN_QUERY_MARGIN_DEG,
    north: point.lat + TOWN_QUERY_MARGIN_DEG,
  };
  const page = await adminAreasGeo.query(ctx, {
    shape: { type: 'rectangle', rectangle },
    limit: TOWN_QUERY_LIMIT,
    filter: (q) => q.eq('level', 'town'),
  });
  for (const { key } of page.results) {
    const area = await ctx.db.get(key);
    if (area && pointInArea(point, area)) return area;
  }
  return null;
}

/** Find the county/state containing `point` by scanning that level's short `by_level` list. */
async function findContainingByLevel(
  ctx: QueryCtx,
  level: 'county' | 'state',
  point: { lat: number; lng: number },
): Promise<Doc<'adminAreas'> | null> {
  const areas = await ctx.db
    .query('adminAreas')
    .withIndex('by_level', (q) => q.eq('level', level))
    .collect();
  return areas.find((area) => pointInArea(point, area)) ?? null;
}

/** The point-derived place label parts stamped onto `reports.place` (Phase 5). */
export interface ResolvedPlace {
  town?: string;
  county?: string;
  state?: string;
}

/**
 * Resolve a coord to its most-specific `{ town?, county?, state? }` (Phase 5). Towns come from the
 * geospatial prefilter; county/state from their short `by_level` scans (a point sits in exactly one
 * of each). The `state` code is taken from the most-specific match's denormalized `state`. Returns
 * `undefined` when nothing contains the point (ocean / outside the imported region), so the caller
 * simply omits `place`. Reused by `reports.create` now and GPS (Phase 8) + hazards (Phase 9) later.
 */
export async function resolvePlaceForCoord(
  ctx: QueryCtx,
  point: { lat: number; lng: number },
): Promise<ResolvedPlace | undefined> {
  const [town, county, state] = await Promise.all([
    findContainingTown(ctx, point),
    findContainingByLevel(ctx, 'county', point),
    findContainingByLevel(ctx, 'state', point),
  ]);
  const place: ResolvedPlace = {};
  if (town) place.town = town.name;
  if (county) place.county = county.name;
  const stateCode = town?.state ?? county?.state ?? state?.state;
  if (stateCode) place.state = stateCode;
  return place.town || place.county || place.state ? place : undefined;
}

/**
 * Public read: resolve a coord to its place label parts. Thin wrapper over `resolvePlaceForCoord`
 * for tests + a potential "where is this?" hint; `reports.create` calls the helper directly so the
 * label is stamped inside the same mutation (no per-read geocode).
 */
export const resolvePlace = query({
  args: { point: latLng },
  handler: (ctx, { point }) => resolvePlaceForCoord(ctx, point),
});
