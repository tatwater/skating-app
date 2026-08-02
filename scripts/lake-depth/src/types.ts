/**
 * Shared lake-depth ETL types (N6a). Three external sources, one normalized record.
 *
 * Every source is keyed to its **own** lake ids — `Hylak_id`, `lagoslakeid` — and none of them knows
 * anything about OSM, so there is no join key to our corpus. What each source can give us is a point
 * inside the lake plus its area, which is what the Convex-side geometric match consumes. The transform's
 * job is therefore normalization and provenance, never matching (see `waterBodies.matchAndImportDepths`).
 */

import type { DepthSource } from '@skating/core';
import type { Feature, Geometry } from 'geojson';

/**
 * A HydroLAKES polygon feature as `ogr2ogr -f GeoJSONSeq` emits it after clipping to our bbox.
 * Units per the HydroLAKES technical documentation: `Lake_area` km², `Depth_avg` m, `Shore_len` km.
 *
 * `Vol_src` is the field that earns HydroLAKES two rungs on the D68 ladder instead of one: 1 = reported
 * lake volume, 2 = reported reservoir volume, 3 = modelled. Since `Depth_avg` is defined as
 * `Vol_total / Lake_area`, a reported volume makes the depth measured-ish and a modelled one doesn't.
 */
export type HydroLakesProperties = Record<string, unknown> & {
  Hylak_id?: number | string;
  Lake_name?: string;
  Lake_area?: number | string;
  Depth_avg?: number | string;
  Vol_src?: number | string;
  /** Shoreline length in km, from HydroLAKES' own polygon — D85's free cross-check on `shorelineM`. */
  Shore_len?: number | string;
};

export type HydroLakesFeature = Feature<Geometry, HydroLakesProperties>;

/**
 * One row of GLOBathy's basic-parameters CSV, keyed on `Hylak_id` and joined to HydroLAKES in memory.
 * GLOBathy publishes **no mean depth** — only `Dmax` — so it can never contribute a `meanDepthM`.
 */
export interface GlobathyRow {
  hylakId: string;
  maxDepthM: number;
}

/**
 * One LAGOS-US DEPTH record: observed depth for a CONUS lake > 1 ha, compiled from ~65 sources.
 * Carries its own location and area, so unlike GLOBathy it needs no other dataset to be usable.
 */
export interface LagosDepthRow {
  lagoslakeid: string;
  lat: number;
  lng: number;
  areaSqM?: number;
  meanDepthM?: number;
  maxDepthM?: number;
}

/**
 * The normalized record the loader sends to `waterBodies.matchAndImportDepths`. One per **source** lake,
 * not per body — the match is the server's job, and a lake that fails to match is a counted rejection
 * rather than a silent drop.
 *
 * `key` is the source's own id (`hylak/1234`, `lagos/5678`), echoed back in the per-lake outcome so a
 * partial run can be diffed and resumed rather than re-guessed.
 */
export interface DepthRecord {
  key: string;
  point: { lat: number; lng: number };
  areaSqM?: number;
  meanDepthM?: number;
  meanDepthSource?: DepthSource;
  maxDepthM?: number;
  maxDepthSource?: DepthSource;
  /**
   * HydroLAKES' own shoreline length, in **metres** (its `Shore_len` is km).
   *
   * **A cross-check, never a source** (D85). Its polygon is a different water mask at a different
   * date and its own resolution, so a disagreement does not say who is right — but a 2× gap on a
   * known lake means our join or ring handling is broken, and that is worth catching at load time
   * rather than in a screenshot. Compared server-side against the stored `shorelineM`, logged, and
   * discarded: **we store ours**.
   */
  shorelineM?: number;
}

/** Per-source counts, printed by the CLI so a thin source is visible rather than inferred. */
export interface TransformSummary {
  hydroLakesRead: number;
  globathyRead: number;
  lagosRead: number;
  emitted: number;
  skipped: number;
  /** LAGOS-US rows that shared a `lagoslakeid` with another and were merged into one record. */
  lagosMerged: number;
  /**
   * Merged lakes whose own records **disagree across a shallow threshold** — some readings say the lake
   * is shallow and others say it isn't. The merge picks a number either way; this is the count of times
   * that pick decided a safety classification rather than a display detail, and it wants human eyes.
   */
  lagosContested: number;
}

export interface TransformError {
  key: string;
  message: string;
}
