/**
 * Filled depth bands (B03 §2): the polygons between the contours, from the contour archive itself.
 *
 * The contour lines alone can't be filled between, so the first build faked depth with the shallowest
 * band's fill under banded contour lines. The bathymetry pipeline now traces the bands as polygons
 * into the **same** `.pmtiles` archive as the lines, on a second layer (`scripts/bathymetry/BANDS.md`
 * is the contract). This file is the client's half of it; nothing here knows a color — the ramp is
 * the design tokens', resolved in `mapPalette`.
 *
 * ## The contract, as the client reads it
 *
 * - The contour source (`CONTOUR_SOURCE_ID`, `VITE_BATHYMETRY_PMTILES_URL`), layer
 *   `bathymetry_bands` (`BAND_SOURCE_LAYER` in `@skating/core`); the lines stay on `bathymetry`.
 * - `bodyId` is the lines' own key (`contourBodyKey`), so the contours' filter scopes both layers.
 * - `bandIndex` 0–6 picks the color. A ramp band a lake has no contour for is **absent** (Mascoma,
 *   contoured every 10 ft, has no band 1), so color always comes from `bandIndex`, never position.
 * - `minDepthFt` / `maxDepthFt` are the contours that really bound the band on that lake, which can
 *   be wider than the ramp's edges; `maxDepthFt` is absent on the open-ended deepest band. Any depth
 *   text reads these, never the ramp's nominal edges (founder, 2026-11-07).
 * - `lane` (`surveyed` | `interpolated`) is there for a provenance treatment; nothing draws it yet.
 * - Bands exist z9–14, like the lines; the layer's floor is the contours' z11, so the two arrive at
 *   the same zoom.
 *
 * ## Decoration, so a lake without bands costs nothing (D82)
 *
 * An older archive with no band layer, or a lake the pipeline dropped, renders exactly as before:
 * the shallowest band's fill under the contour lines.
 */

import {
  BAND_SOURCE_LAYER,
  type BandFeatureProperties,
  CONTOUR_FADE_MS,
  contourFilter,
} from '@skating/core';

export type { BandFeatureProperties };

export const BANDS_LAYER_ID = 'bathymetry-bands-fill';
/** The band layer inside the contour archive — set by the pipeline (`BANDS.md`). */
export const BANDS_SOURCE_LAYER = BAND_SOURCE_LAYER;
/** Fully faded in: opaque, like the shallow-band ground it lies on. */
export const BANDS_OPACITY = 1;
/** The same reveal as the contours', so the two arrive together. */
export const BANDS_FADE_MS = CONTOUR_FADE_MS;

/**
 * Only the open lake's bands — the contours' own filter, because the two share one key. No lake
 * means no bands, never every band in the archive.
 */
export const bandsFilter = contourFilter;

/** What the legend needs of one band. */
export type LegendBand = Pick<BandFeatureProperties, 'bandIndex' | 'minDepthFt' | 'maxDepthFt'>;

/**
 * A lake's bands out of the features a tile query returned: one per `bandIndex` (a band crosses
 * tiles, so it comes back once per tile), shallow first. Features that don't carry a usable index or
 * floor are skipped rather than guessed at.
 */
export function lakeBands(props: readonly Partial<BandFeatureProperties>[]): LegendBand[] {
  const byIndex = new Map<number, LegendBand>();
  for (const p of props) {
    const bandIndex = Number(p.bandIndex);
    const minDepthFt = Number(p.minDepthFt);
    if (!Number.isInteger(bandIndex) || !Number.isFinite(minDepthFt) || byIndex.has(bandIndex)) {
      continue;
    }
    const max = p.maxDepthFt == null ? undefined : Number(p.maxDepthFt);
    byIndex.set(bandIndex, {
      bandIndex,
      minDepthFt,
      ...(max !== undefined && Number.isFinite(max) ? { maxDepthFt: max } : {}),
    });
  }
  return [...byIndex.values()].sort((a, b) => a.bandIndex - b.bandIndex);
}

/** Whether two band lists say the same thing — so a re-read of the same tiles sets no state. */
export function sameBands(a: readonly LegendBand[], b: readonly LegendBand[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (x, i) =>
        x.bandIndex === b[i]?.bandIndex &&
        x.minDepthFt === b[i]?.minDepthFt &&
        x.maxDepthFt === b[i]?.maxDepthFt,
    )
  );
}

/**
 * A band's depth in words, from the contours that bound it on this lake: "0–10 ft", or "70+ ft"
 * for the open-ended deepest band. Never the ramp's nominal edges.
 */
export function bandRangeLabel(band: LegendBand): string {
  return band.maxDepthFt === undefined
    ? `${band.minDepthFt}+ ft`
    : `${band.minDepthFt}–${band.maxDepthFt} ft`;
}
