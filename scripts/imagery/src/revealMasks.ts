/**
 * Turning a corpus row into the shape imagery is allowed to show through (N6e PR 2a, D148).
 *
 * ## What this produces, and what it deliberately does not
 *
 * One GeoJSON feature per body: the **solid** reveal — water, the walk in, and the parking, each
 * buffered by `SENTINEL_MASK_METERS.solid` and unioned. That is `revealShape` from `@skating/core`,
 * unchanged, which is the point: the web client and this archive must agree about what a reveal
 * covers, and two implementations of a geodesic buffer are two chances to disagree by metres.
 *
 * **The feather is not here.** `SENTINEL_MASK_METERS.feather` is 240 m of ramp outside this shape,
 * and it is applied in the container as a distance transform against the rasterised mask — where
 * ground distance is measurable in pixels and a ramp is one operation. Baking it into *geometry*
 * would mean either a second buffered ring (a step, not a ramp) or dozens of them, which is the
 * stacked-opacity approach `imageryMask`'s own module note records as already tried and abandoned.
 *
 * ## Why the web client does something different, and why that is fine
 *
 * `imageryCanvas` dilates in pixel space — a fill plus a stroke at `2 × solid` — because it computes
 * masks for up to fifty bodies synchronously on the main thread at every camera change, and Turf
 * buffers at that rate stall the map. This runs once a season against a whole corpus, so it can
 * afford the real geometry, and `imageryCanvas` says so explicitly: *"PR 2's Sentinel archive bakes
 * its alpha server-side, where there is no rasteriser and the real geometry is the answer."*
 */

import {
  type ImageryMaskInput,
  type LatLng,
  revealShape,
  SENTINEL_MASK_METERS,
} from '@skating/core';
import type { Feature, MultiPolygon, Polygon } from 'geojson';

/** One row of `imageryMasks.listForImageryMask`, as it arrives over `convex run`. */
export interface CorpusMaskRow {
  waterBodyId: string;
  name?: string;
  polygon: Polygon | MultiPolygon;
  approachPaths?: readonly (readonly LatLng[])[];
  parkingCoords?: readonly LatLng[];
  markerCoords?: readonly LatLng[];
}

/** What a bake did with one row — a feature, or the reason there isn't one. */
export type MaskOutcome =
  | { ok: true; feature: Feature<Polygon | MultiPolygon, MaskProperties> }
  | { ok: false; waterBodyId: string; name?: string; reason: 'no-geometry' | 'union-failed' };

/**
 * What travels with the shape into the container.
 *
 * `waterBodyId` is the only field the cutter needs; `name` rides along because the artifact is
 * something a person opens in QGIS when a lake looks wrong, and an id is not a lake.
 */
export interface MaskProperties {
  waterBodyId: string;
  name?: string;
}

/**
 * Buffer one body's reveal into a feature.
 *
 * ⚠ **Fails closed, and the caller must keep it that way.** `revealShape` returns `null` when the
 * union collapses, and `@skating/core` is explicit that this means *"do not reveal"* rather than
 * *"reveal everything"* — a reveal that fails open is a photograph of the whole Northeast with no way
 * to tell which lake you were looking at. So a failure here omits the body from the mask file, which
 * means the archive simply never shows it. That is the safe direction and it is also a silent one,
 * which is why `bakeMasks` counts and reports every omission rather than logging a warning nobody
 * reads.
 */
export function maskFeatureFor(row: CorpusMaskRow): MaskOutcome {
  if (!row.polygon || !row.polygon.type) {
    return { ok: false, waterBodyId: row.waterBodyId, name: row.name, reason: 'no-geometry' };
  }

  const input: ImageryMaskInput = {
    polygon: row.polygon,
    approachPaths: row.approachPaths,
    parkingCoords: row.parkingCoords,
    markerCoords: row.markerCoords,
  };

  const shape = revealShape(input, SENTINEL_MASK_METERS.solid);
  if (!shape) {
    return { ok: false, waterBodyId: row.waterBodyId, name: row.name, reason: 'union-failed' };
  }

  return {
    ok: true,
    feature: {
      type: 'Feature',
      geometry: shape,
      properties: {
        waterBodyId: row.waterBodyId,
        ...(row.name === undefined ? {} : { name: row.name }),
      },
    },
  };
}

/** A run's tally, so an omission cannot hide inside a success count. */
export interface BakeTally {
  masked: number;
  omitted: number;
  byReason: Record<'no-geometry' | 'union-failed', number>;
  /**
   * The bodies that produced no mask, capped for legibility.
   *
   * A list rather than a count alone, because "142 bodies omitted" is unactionable while "142
   * omitted, and here are the first twenty, all of them sub-acre ponds" is a decision. Capped because
   * a systemic failure would otherwise print the entire corpus into a run log.
   */
  omissions: { waterBodyId: string; name?: string; reason: string }[];
}

export const MAX_REPORTED_OMISSIONS = 20;

/** Start an empty tally. */
export function emptyTally(): BakeTally {
  return {
    masked: 0,
    omitted: 0,
    byReason: { 'no-geometry': 0, 'union-failed': 0 },
    omissions: [],
  };
}

/** Fold one outcome into a tally. */
export function recordOutcome(tally: BakeTally, outcome: MaskOutcome): BakeTally {
  if (outcome.ok) {
    tally.masked++;
    return tally;
  }
  tally.omitted++;
  tally.byReason[outcome.reason]++;
  if (tally.omissions.length < MAX_REPORTED_OMISSIONS) {
    tally.omissions.push({
      waterBodyId: outcome.waterBodyId,
      ...(outcome.name === undefined ? {} : { name: outcome.name }),
      reason: outcome.reason,
    });
  }
  return tally;
}
