/**
 * The empty-tile survey, cached as something a person can look at (N6e PR 2).
 *
 * ## Why this is cached at all, and it is not for speed
 *
 * Sentinel-2 tiles are a **fixed grid**: `18TXP` is the same 110 km square of ground on every pass,
 * forever. Only how much of a tile the orbital swath fills varies. So "does this tile contain any
 * corpus body" is a property of *tile × corpus* — it changes when a lake is added, merged or taken
 * down, and never because time passed or a satellite flew over.
 *
 * Re-surveying costs ~100 local reads, which is seconds. The reason to persist it is that a
 * recomputed number is one you have to trust, while **a stored artifact is one you can check** — and
 * this particular number silently halves or doubles the cost of a nine-season backfill.
 *
 * ## Why GeoJSON rather than a list of tile codes
 *
 * A survey that says `["18TXP", "19TCG", …]` is unreviewable: nobody can tell by reading it whether
 * the kept tiles cover the corpus or whether a swathe of Vermont was dropped. The same data as tile
 * rectangles with a `kept` flag opens in geojson.io or QGIS and answers that at a glance — the
 * superset of tiles the season touches, with the ones we will actually cut highlighted.
 *
 * That is also precisely the shape an admin map view would consume, so building it here means the
 * dashboard version is a rendering job rather than a data job.
 */

import type { Feature, FeatureCollection, Polygon } from 'geojson';

/**
 * Bump to force every cached survey to be recomputed.
 *
 * The convenient invalidation target: the cache key already changes when the corpus does, but during
 * bring-up we want the survey re-run even when nothing about the corpus moved.
 */
export const TILE_SURVEY_VERSION = 3;

/** What one tile contributed to the decision. */
export interface TileSurveyEntry {
  tile: string;
  /** Bodies whose mask intersects the tile's footprint bbox. */
  bodies: number;
  /** `false` ⇒ no corpus body, so no Machine is spawned for any granule on this tile. */
  kept: boolean;
  /** The footprint bbox actually tested: minLng, minLat, maxLng, maxLat. */
  bbox: [number, number, number, number];
}

/** A survey as stored — a FeatureCollection with the cache key as a GeoJSON foreign member. */
export interface TileSurveyCollection extends FeatureCollection<Polygon, TileSurveyProperties> {
  surveyKey: string;
  surveyedAt?: string;
}

export interface TileSurveyProperties {
  tile: string;
  bodies: number;
  kept: boolean;
}

/**
 * The identity a cached survey is valid for.
 *
 * `season` and `bodies` come from the mask sidecar, so **any change to the corpus invalidates the
 * cache by construction** — a lake added, merged or taken down moves the count, and a re-bake under a
 * new season changes the label. That is the whole reason the sidecar carries a body count.
 *
 * It is not a content hash. A corpus edit that removes one body and adds another leaves the count
 * unchanged, and this would keep a stale survey — which costs at most one tile's worth of Machines in
 * either direction, against re-hashing a 58 MB file on every run. Bump `TILE_SURVEY_VERSION` when that
 * trade stops being acceptable.
 */
export function tileSurveyKey(season: string, bodies: number): string {
  return `v${TILE_SURVEY_VERSION}:${season}:${bodies}`;
}

/** A tile's bbox as a closed GeoJSON ring. */
function bboxPolygon([minLng, minLat, maxLng, maxLat]: readonly number[]): Polygon {
  const x1 = minLng as number;
  const y1 = minLat as number;
  const x2 = maxLng as number;
  const y2 = maxLat as number;
  return {
    type: 'Polygon',
    coordinates: [
      [
        [x1, y1],
        [x2, y1],
        [x2, y2],
        [x1, y2],
        [x1, y1],
      ],
    ],
  };
}

/** Turn a completed survey into the reviewable artifact. */
export function toTileSurveyCollection(
  entries: readonly TileSurveyEntry[],
  surveyKey: string,
  surveyedAt?: string,
): TileSurveyCollection {
  const features: Feature<Polygon, TileSurveyProperties>[] = [...entries]
    // Sorted by tile so two surveys of the same corpus diff cleanly instead of reordering.
    .sort((a, b) => a.tile.localeCompare(b.tile))
    .map((entry) => ({
      type: 'Feature',
      geometry: bboxPolygon(entry.bbox),
      properties: { tile: entry.tile, bodies: entry.bodies, kept: entry.kept },
    }));

  return {
    type: 'FeatureCollection',
    surveyKey,
    ...(surveyedAt === undefined ? {} : { surveyedAt }),
    features,
  };
}

/** The tiles a stored survey says to skip, or `null` if it does not apply to this corpus. */
export function emptyTilesFromCollection(
  collection: TileSurveyCollection | null,
  expectedKey: string,
): ReadonlySet<string> | null {
  if (!collection || collection.surveyKey !== expectedKey) return null;
  const empty = new Set<string>();
  for (const feature of collection.features) {
    if (feature.properties && !feature.properties.kept) empty.add(feature.properties.tile);
  }
  return empty;
}
