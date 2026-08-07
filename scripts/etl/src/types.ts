/**
 * Shared ETL types: the raw OSM feature shape `osmium export` emits, and the canonical
 * body record the transform produces (mirroring `waterBodies.importCanonical`).
 */

import type { BBox, LatLng, WaterBodyClass } from '@skating/core';
import type { Feature, Geometry, MultiPolygon, Polygon } from 'geojson';

/**
 * Properties of a water feature exported by `osmium export -a type,id` (see README): the OSM
 * tags flat (`natural`, `water`, `name`, …) plus the `@type`/`@id` attributes we key
 * `externalId` on. `@id` is numeric in osmium's output; we accept a string too, defensively.
 */
export type OsmWaterProperties = Record<string, unknown> & {
  '@type'?: string;
  '@id'?: number | string;
};

/**
 * A water feature from the convert stage. osmium normalizes every area to a `MultiPolygon`
 * (and we accept a `Polygon` too), but the geometry is typed as the full `Geometry` union so
 * the transform can *defensively* reject anything non-area at runtime — this is raw OSM.
 */
export type OsmWaterFeature = Feature<Geometry, OsmWaterProperties>;

/**
 * A canonical OSM body ready for `waterBodies.importCanonical`. Mirrors that mutation's
 * `canonicalBody` validator exactly — `source` is always `'osm'` this phase (rivers/NHD later).
 */
export interface CanonicalBody {
  /**
   * Which catalogue this record arrived from. **No longer half the upsert key** (N7 / D93) — the
   * ids below are — but still stored, because "where did this row come from" is a real question.
   */
  source: 'osm' | 'nhd' | '3dhp';
  /**
   * The arrival key, retained through one full campaign because the N6b contour tiles are stamped
   * with it and D93 retires it only once every consumer reads `waterBodyKey`.
   */
  externalId: string;
  /**
   * **What this lake is, in each catalogue that knows it** — the actual upsert key. At least one
   * must be present or `importCanonical` refuses the record rather than inventing an identity.
   */
  osmId?: string;
  nhdId?: string;
  threeDhpId?: string;
  /** Proposes candidates, never decides identity — 92 GNIS ids fan out across several NHD bodies. */
  gnisId?: string;
  /** Whose outline `polygon` is (D92); absent means "the same as `source`". */
  geometrySource?: 'osm' | 'nhd' | '3dhp' | 'user';
  /**
   * The states this body touches, when the producer knows. The OSM lane leaves it unset and the
   * loader's `--state` flag tags the batch; the merge computes it per body against the admin-area
   * mask, because a merged corpus is loaded in one pass and has no per-state batches to tag.
   */
  states?: string[];
  name: string;
  type: WaterBodyClass;
  polygon: Polygon | MultiPolygon;
  bbox: BBox;
  centroid: LatLng;
  surfaceAreaSqM: number;
  /**
   * The area the **admission decision** was made on — the source geometry, before simplification.
   *
   * `surfaceAreaSqM` above is measured from the stored polygon, because that is what we draw. The
   * floor is applied to the source, because that is the more accurate measure. The two differ by well
   * under a percent, and that was enough to matter: `pruneBelowAreaFloor` reads the *stored* number,
   * so a body admitted at 1.0001 acres and stored at 0.9999 was added by every import and deleted by
   * every prune — the exact drift the "one floor, in core" rule exists to prevent, arriving through
   * the one door it did not cover.
   */
  sourceAreaSqM?: number;
  /**
   * What share of the outline lies inside our five states, in `[0, 1]` (N7 audit).
   *
   * The region clip admits on a **single** in-region vertex, which is what keeps Beau Lake — most of
   * which is in Québec. The cost is that the corpus holds bodies that are mostly somewhere else and
   * nothing said so. Recorded, not acted on: it is the number a future rule would be set against.
   */
  inRegionFraction?: number;
  /**
   * How well corroborated each attribute is (D110) — `high` / `medium` / `low` / `none`.
   *
   * Computed by `@skating/core`'s `scoreBody` and, until the N7 audit, **discarded**: the merge
   * tallied the distribution into three lines of terminal output and stored nothing, so a fully
   * tested core module had no consumer and the review queue it feeds could never be opened.
   */
  confidence?: { name: string; polygon: string; cls: string };
  /**
   * Why this body wants a human — `class-conflict`, `name-conflict`, `bay-without-parent`,
   * `same-source-duplicate`. Empty is the normal case and is omitted rather than stored empty.
   */
  reviewReasons?: string[];
  /**
   * A point genuinely inside the water (N6c) — see `waterBodies.interiorPoint`. Absent only when
   * the geometry has no locatable interior, which is a body the transform is about to skip anyway.
   */
  interiorPoint?: LatLng;
  /**
   * Derived shape stats (N6c Workstream A), measured on the **pre-simplification** geometry per
   * D85. Each is independently optional: a degenerate ring costs one field, not the feature.
   */
  shorelineM?: number;
  longAxisM?: number;
  longAxisBearingDeg?: number;
  shortAxisM?: number;
  fetchProfileM?: number[];
}

/**
 * A depth carried opportunistically off an OSM `depth` / `maxdepth` tag (N6a rung 7), shaped for
 * `waterBodies.importDepths` — which keys on `source` + `externalId`, exactly what we have here.
 *
 * Kept **separate from `CanonicalBody`** rather than folded into it, because the two have different
 * ladders: `importCanonical` overwrites its field list every run (upstream OSM is authoritative for a
 * name and a shoreline), while a depth must go through the D68 ladder and lose to every better source.
 * Two streams, two mutations, one pass over the same input.
 */
export interface OsmDepthRecord {
  source: 'osm';
  externalId: string;
  meanDepthM?: number;
  meanDepthSource?: 'osm_tag';
  maxDepthM?: number;
  maxDepthSource?: 'osm_tag';
}
