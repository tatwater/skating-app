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

import { allLevels, bboxIntersects, cellForPoint, pointInPolygon } from '@skating/core';
import { v } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type QueryCtx, query } from './_generated/server';
import { ADMIN_AREA_LADDER, syncAdminAreaCells } from './lib/cellIndex';
import { ADMIN_AREA_LEVELS } from './lib/enums';
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
          representativePoint: item.centroid,
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
          representativePoint: item.centroid,
          createdAt: Date.now(),
        });
        inserted++;
      }
      // Re-cell the boundary in one place for both paths (N1). The sync diffs desired cells against
      // stored ones, so a re-import moves a redrawn boundary rather than stacking duplicate rows.
      await syncAdminAreaCells(ctx, id, { bbox: item.bbox, level: item.level });
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

/** Candidate rows one cell may contribute. Boundaries of a level tile the map without overlapping,
 *  so a cell realistically holds a handful; this is the never-silent backstop (D5), not a bound. */
const AREA_CELL_CAP = 64;

/**
 * Find the boundary of `level` containing `point` (N1). One cell lookup per ladder rung, then a
 * `pointInPolygon` refine — a point sits inside exactly one area per level, so the first hit wins.
 *
 * **This replaced two different broken things.** Towns used to come from a ±0.2° *centroid*
 * rectangle, sized on the stated premise that "our towns run well under 0.4° across" — which the
 * Phase-2.5 corpus falsified the moment the Adirondacks loaded, and whose failure mode was silent
 * (its own comment: a town bigger than the margin "degrades to a county+state label"). Counties and
 * states, meanwhile, couldn't use that trick at all — a state centroid sits degrees from most
 * interior points — so they scanned **every** row of their level and grew with each state imported.
 * Indexing by bbox coverage makes size irrelevant to both: containment is exact at any scale.
 */
async function findContainingArea(
  ctx: QueryCtx,
  level: 'town' | 'county' | 'state',
  point: { lat: number; lng: number },
): Promise<Doc<'adminAreas'> | null> {
  for (const z of allLevels(ADMIN_AREA_LADDER)) {
    const cell = cellForPoint(point, z);
    const rows = await ctx.db
      .query('adminAreaCells')
      .withIndex('by_cell', (q) =>
        q.eq('z', cell.z).eq('x', cell.x).eq('y', cell.y).eq('level', level),
      )
      .take(AREA_CELL_CAP);
    if (rows.length === AREA_CELL_CAP) {
      console.warn(
        `findContainingArea hit the ${AREA_CELL_CAP}-row cap for ${level} at rung ${z}; a containing area may have been missed (N1).`,
      );
    }
    for (const row of rows) {
      const area = await ctx.db.get(row.adminAreaId);
      if (area && pointInArea(point, area)) return area;
    }
  }
  return null;
}

/**
 * Internal migration (run via `pnpm exec convex run`): cell-index every boundary (N1). Paginated
 * like the water-body backfill — `adminAreas` is only single-digit thousands of rows, but a
 * migration that can't resume is a migration you can't safely re-run.
 */
export const backfillCells = internalMutation({
  args: { cursor: v.optional(v.string()), batchSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, batchSize }) => {
    const numItems = Math.min(500, Math.max(1, batchSize ?? 200));
    const page = await ctx.db.query('adminAreas').paginate({ cursor: cursor ?? null, numItems });
    for (const area of page.page) {
      await syncAdminAreaCells(ctx, area._id, { bbox: area.bbox, level: area.level });
    }
    return { reindexed: page.page.length, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/** The point-derived place label parts stamped onto `reports.place` (Phase 5). */
export interface ResolvedPlace {
  town?: string;
  county?: string;
  state?: string;
}

/**
 * Resolve a coord to its most-specific `{ town?, county?, state? }` (Phase 5). All three levels now
 * come from the same cell-index lookup (a point sits in exactly one of each). The `state` code is
 * taken from the most-specific match's denormalized `state`. Returns `undefined` when nothing
 * contains the point (ocean / outside the imported region), so the caller simply omits `place`.
 * Reused by `reports.create`, GPS (Phase 8) and hazards (Phase 9).
 */
export async function resolvePlaceForCoord(
  ctx: QueryCtx,
  point: { lat: number; lng: number },
): Promise<ResolvedPlace | undefined> {
  const [town, county, state] = await Promise.all([
    findContainingArea(ctx, 'town', point),
    findContainingArea(ctx, 'county', point),
    findContainingArea(ctx, 'state', point),
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
