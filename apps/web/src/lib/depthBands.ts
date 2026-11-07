/**
 * Filled depth bands (B03 §2): the polygons between the contours, from their own archive.
 *
 * The contour archive holds lines, and MapLibre cannot fill between lines, so the first build faked
 * depth with the shallowest band's fill under banded contour lines. The bathymetry pipeline now
 * emits the bands themselves as polygons, in a **second** `.pmtiles` archive beside the contour one
 * (its `BANDS.md` is the contract). This file is the client's half of that contract, and nothing
 * here knows a color: the ramp is the design tokens', resolved in `mapPalette`.
 *
 * ## The contract, as the client reads it
 *
 * - Layer `bands` inside the archive (`BANDS_SOURCE_LAYER`).
 * - Each polygon carries `bodyId` — the same key the contours are stamped with
 *   (`contourBodyKey`: the OSM `externalId`, falling back to the Convex `_id`) — so one filter
 *   scopes both layers to the open lake.
 * - `bandIndex` 0–6 on the seven-band ramp (`DEPTH_BAND_EDGES_FT`: 0, 5, 10, 20, 30, 45, 70 ft),
 *   and `minDepthFt` / `maxDepthFt` (`maxDepthFt` absent on the open-ended deepest band).
 * - Bands may be annuli or nested whole shapes: the layer sorts by `bandIndex`, so the deeper band
 *   draws over the shallower one either way.
 *
 * ## Decoration, so a missing archive costs nothing (D82)
 *
 * A lake with no band polygons — an unconfigured deployment, an archive that 404s, a lake the
 * pipeline hasn't reached — renders exactly as it did before bands existed: the shallowest band's
 * fill under the contour lines. Nothing errors and nothing logs; `isBandsSourceError` is how the
 * map's error handler recognizes this source's failures to drop them.
 */

import {
  CONTOUR_FADE_MS,
  type ContourFeatureProperties,
  contourFilter,
  contourSourceSpec,
} from '@skating/core';

export const BANDS_SOURCE_ID = 'bathymetry-bands';
export const BANDS_LAYER_ID = 'bathymetry-bands-fill';
/** The `layer` name inside the band archive — set by the pipeline (`BANDS.md`). */
export const BANDS_SOURCE_LAYER = 'bands';
/** Fully faded in: opaque, like the shallow-band ground it lies on. */
export const BANDS_OPACITY = 1;
/** The same reveal as the contours', so the two arrive together. */
export const BANDS_FADE_MS = CONTOUR_FADE_MS;

/** One band, as the client reads it back off the tile. */
export interface BandFeatureProperties extends Partial<ContourFeatureProperties> {
  bodyId: string;
  bandIndex: number;
  minDepthFt: number;
  maxDepthFt?: number;
}

/**
 * Only the open lake's bands — the contours' own filter, because the two share one key. No lake
 * means no bands, never every band in the archive.
 */
export const bandsFilter = contourFilter;

/**
 * The vector source for the archive. A root-relative URL (`/dev-tiles/…`, a file in the app's
 * public dir) is resolved against the page first: the `pmtiles://` protocol fetches whatever
 * follows its prefix, and an absolute address is the one form every layer of that chain agrees on.
 */
export function bandsSourceSpec(
  archiveUrl: string,
  base: string | null = typeof window === 'undefined' ? null : window.location.href,
): { type: 'vector'; url: string } {
  const absolute = archiveUrl.startsWith('/') && base ? new URL(archiveUrl, base).href : archiveUrl;
  return contourSourceSpec(absolute);
}

/**
 * Whether a map `error` event is this source failing (an archive that 404s, a tile that won't
 * decode). Those are dropped: a lake without bands is a lake drawn as before, not a fault.
 */
export function isBandsSourceError(event: unknown): boolean {
  return (
    typeof event === 'object' &&
    event !== null &&
    (event as { sourceId?: unknown }).sourceId === BANDS_SOURCE_ID
  );
}
