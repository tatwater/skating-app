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
 *
 * ## ⚠ Two geometries per body, and conflating them corrupts every statistic in the archive
 *
 * A bake emits **two** features for each body, and they answer different questions:
 *
 * | | geometry | what it is for |
 * |---|---|---|
 * | **reveal** | `revealShape` — water ∪ walk ∪ parking, each +60 m, holes dropped | the **picture**: what alpha lets through |
 * | **water** | the body polygon exactly as the corpus holds it, holes intact | the **measurement**: what a zonal statistic counts |
 *
 * Until 2026-08-25 there was only the first, and `cut-granule.sh` rasterised it as the zone grid — so
 * `clearPct`, `snowIcePct`, `waterPct`, `vhDb` and `vvDb` were all measured over the lake *plus* a
 * 60 m ring of shore, *plus* its islands, *plus* the trail corridor and the parking lot.
 *
 * **The error is not uniform, which is what makes it dangerous.** The ring is a fixed width, so its
 * share of the zone scales with perimeter over area: negligible on Champlain, and on a circular
 * 1-acre pond (r ≈ 36 m) a 60 m buffer is **7× the pond's own area — 86% of that "lake" is land**.
 * That is precisely the size class [N6g](../../../plans/phase-N6g-imagery-research.md) Lane 2 wants to
 * eliminate on "never observed frozen", where the surrounding woods would have cast the vote. And for
 * radar it is worse still: forest is the classic bright `VH` target at ~−13 dB against smooth ice near
 * −22 dB, a ~10 dB contaminant sitting on the ~2 dB separation the archive exists to detect.
 *
 * **So the reveal shape must never be used as a zone, and the water polygon must never be used as
 * alpha.** The first would measure the shore; the second would show a lake with its shoreline cut off
 * and the walk in invisible, which is the whole point of D146's reveal.
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
  /** Surface elevation in metres — the radar geocode's input. See {@link MaskProperties.elevationM}. */
  elevationM?: number;
}

/**
 * What a bake did with one row — two features, or the reason there are none.
 *
 * ⚠ **They succeed and fail together, deliberately.** A body present in one artifact and absent from
 * the other is a body the archive either pictures without measuring or measures without picturing,
 * and both are silent. Emitting the pair from a single outcome makes that state unrepresentable.
 */
export type MaskOutcome =
  | {
      ok: true;
      /** The reveal shape — what alpha lets through. Never a zone. */
      feature: Feature<Polygon | MultiPolygon, MaskProperties>;
      /** The body polygon — what a zonal statistic counts. Never an alpha. */
      waterFeature: Feature<Polygon | MultiPolygon, MaskProperties>;
    }
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
  /**
   * Surface elevation in metres, where the corpus has one.
   *
   * ⚠ **For the radar geocode rather than for anything a skater sees.** A GRD is projected onto an
   * ellipsoid at a single average scene height, so a lake above or below that reference lands
   * displaced along range — the effect that made two islands appear to jump east and west between
   * dates. Over a flat surface at a known height the correction is a constant, and this is its input.
   */
  elevationM?: number;
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
  if (!row.polygon?.type) {
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

  const properties: MaskProperties = {
    waterBodyId: row.waterBodyId,
    ...(row.name === undefined ? {} : { name: row.name }),
    ...(row.elevationM === undefined ? {} : { elevationM: row.elevationM }),
  };

  return {
    ok: true,
    feature: { type: 'Feature', geometry: shape, properties },
    // ⚠ **`row.polygon` unmodified — not buffered, and holes NOT dropped.** `revealShape` calls
    // `outerRingsOnly` before buffering, which fills a lake's islands in so the picture shows them;
    // counting them as lake would put permanent land in a freeze-up statistic on every island lake in
    // the corpus. The measurement wants the corpus polygon exactly as drawn.
    waterFeature: { type: 'Feature', geometry: row.polygon, properties },
  };
}

/** A run's tally, so an omission cannot hide inside a success count. */
export interface BakeTally {
  masked: number;
  omitted: number;
  /**
   * How many masked bodies carry an `elevationM`.
   *
   * ⚠ **Counted because its absence is silent everywhere downstream.** The radar de-shift needs a
   * height per body; a body without one is copied unshifted, which is not an error and produces a
   * perfectly ordinary frame — of the wrong ground. On 2026-08-25 a bake produced **0 of 40** because
   * `listForImageryMask` returned the field in source but the deployed dev function predated it, and
   * nothing anywhere would have said so: the cutter would have run, every job would have exited 0,
   * and a nine-season radar archive would have been built with the correction silently disabled.
   *
   * The corpus is at 99.5% coverage, so anything near zero here means a stale deployment rather than
   * a gap in the data.
   */
  withElevation: number;
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
    withElevation: 0,
    byReason: { 'no-geometry': 0, 'union-failed': 0 },
    omissions: [],
  };
}

/** Fold one outcome into a tally. */
export function recordOutcome(tally: BakeTally, outcome: MaskOutcome): BakeTally {
  if (outcome.ok) {
    tally.masked++;
    if (outcome.feature.properties.elevationM !== undefined) tally.withElevation++;
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
