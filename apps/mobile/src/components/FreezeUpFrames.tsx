/**
 * The freeze-up frames on mobile (N6e §C2, D148) — and the reason this file is short.
 *
 * ## This is the payoff for deferring mobile imagery to PR 3
 *
 * The Tier 1 aerial reveal needs a `CanvasRenderingContext2D` to punch alpha out of a fetched
 * photograph, and React Native has none. That is why `useImageryReveal` is web-only and why mobile
 * has had no reveal at all since PR 1 — a deliberate wait, on the bet that D148's archive would make
 * the whole problem disappear rather than solving it twice.
 *
 * **It did.** A frame is a `.pmtiles` raster with its alpha already baked in — clipped to the lake,
 * its approach and its parking, feathered by a `gdal_proximity` pass on a Fly Machine months ago. So
 * mobile's reveal is a `RasterSource` pointed at a URL. No canvas, no Skia, no second copy of the
 * projection maths.
 *
 * MapLibre Native reads `pmtiles://` directly, with no JS protocol to register — the same mechanism
 * the basemap already uses (`waterMap.ts`), and one that skips the browser's CORS layer entirely.
 *
 * ## Declarative here, imperative on web, and that difference removes a bug class
 *
 * Web adds and removes sources by hand, which is where the reveal had to be gated on a `sourcedata`
 * event — and where two separate load races were found in live use on 2026-08-25. React Native's
 * bindings are components: React owns the lifecycle, mounting and unmounting with the selection.
 *
 * So there is no reveal gate here, and deliberately no zero-opacity mount. Tiles paint as they
 * arrive, which is exactly what web's timeout floor settled on after those races — arrived at here by
 * construction rather than by correction.
 *
 * ## ⚠ Every source is keyed AND id'd by the frame, and both are load-bearing
 *
 * A raster source's URL is immutable in MapLibre — the fact web works around by tearing the source
 * down and rebuilding it. Declarative bindings hide that: React sees the same component in the same
 * position, reconciles it as a *prop update*, and hands the native side a new `url` it will not act
 * on. **Observed on device 2026-08-25: the first frame of each band rendered and no later tap changed
 * anything**, not even a zoom, because unlike web there was no second load event to rescue it.
 *
 * `key` forces the unmount/remount that actually recreates the native source. The id is derived from
 * the frame as well, so that even if a binding defers its teardown the incoming source cannot collide
 * with the outgoing one under a shared name.
 */

import { GeoJSONSource, Layer, RasterSource } from '@maplibre/maplibre-react-native';
import {
  archiveUrl,
  CONTOUR_BEFORE_LAYER_ID,
  copernicusCredit,
  type IndexedFrame,
  seamFeature,
  type TimelineStop,
} from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import { env } from '../lib/env';

export const FREEZE_UP_SOURCE_ID = 'freeze-up-frame';
export const FREEZE_UP_LAYER_ID = 'freeze-up-frame-raster';
export const FREEZE_UP_COMPANION_SOURCE_ID = 'freeze-up-frame-companion';
export const FREEZE_UP_COMPANION_LAYER_ID = 'freeze-up-frame-companion-raster';
export const FREEZE_UP_SEAM_SOURCE_ID = 'freeze-up-seam';
export const FREEZE_UP_SEAM_LAYER_ID = 'freeze-up-seam-line';

/** Matches web's hairline: deliberate at any zoom, never competing with the shoreline beside it. */
const SEAM_WIDTH = 1.25;

/** Ids unique to the frame, so an outgoing source can never share a name with its replacement. */
const idsFor = (prefix: string, frame: IndexedFrame) => ({
  sourceId: `${prefix}-${frame.granuleId}-${frame.band}`,
  layerId: `${prefix}-${frame.granuleId}-${frame.band}-layer`,
});

function Frame({ frame, season, prefix }: { frame: IndexedFrame; season: string; prefix: string }) {
  const { sourceId, layerId } = idsFor(prefix, frame);
  return (
    <RasterSource
      id={sourceId}
      url={`pmtiles://${archiveUrl(env.imageryArchiveUrl, frame.key)}`}
      // The cutter tiles at 512. Native defaults to 512 already, but saying so keeps the two clients
      // reading identically rather than relying on a default that differs from web's.
      tileSize={512}
      // Copernicus' credit is required — unlike NAIP's, which is courtesy. Declared on the source so
      // the attribution surface unions it automatically, exactly as web does.
      attribution={copernicusCredit(season)}
    >
      <Layer
        id={layerId}
        type="raster"
        // Under every pin, track and hazard that follows, for the reason contours are: imagery is
        // context and hazards are the product, so if the two ever compete the picture loses.
        beforeId={CONTOUR_BEFORE_LAYER_ID}
        paint={{
          'raster-opacity': 1,
          // ⚠ Off, matching web. MapLibre's cross-zoom blending smears an alpha-masked edge, turning
          // the cutter's feather into a smudge — which reads as a bad clip rather than a render
          // setting.
          'raster-fade-duration': 0,
        }}
      />
    </RasterSource>
  );
}

/**
 * Render the selected pass, its seam companion, and the hairline between them.
 *
 * Everything is `null`-tolerant: no stop, no archive, no season are all ordinary states, and the
 * component simply renders nothing rather than treating any of them as an error.
 */
export function FreezeUpFrames({
  stop,
  season,
  body,
}: {
  stop: TimelineStop | null;
  season: string | null;
  /** The lake, which clips the granule edge down to the part anyone can see. */
  body: Polygon | MultiPolygon | null;
}) {
  if (!stop || !season || !env.imageryArchiveUrl) return null;

  const companion = stop.companion?.frame ?? null;
  const seam =
    companion && stop.frame.footprint && body ? seamFeature(stop.frame.footprint, body) : null;

  return (
    <>
      {companion ? (
        <Frame
          key={`companion:${companion.key}`}
          frame={companion}
          season={season}
          prefix={FREEZE_UP_COMPANION_SOURCE_ID}
        />
      ) : null}
      <Frame
        key={`primary:${stop.frame.key}`}
        frame={stop.frame}
        season={season}
        prefix={FREEZE_UP_SOURCE_ID}
      />
      {seam ? (
        <GeoJSONSource id={FREEZE_UP_SEAM_SOURCE_ID} data={seam}>
          <Layer
            id={FREEZE_UP_SEAM_LAYER_ID}
            type="line"
            beforeId={CONTOUR_BEFORE_LAYER_ID}
            layout={{ 'line-join': 'round', 'line-cap': 'round' }}
            paint={{
              // White rather than a theme colour: every palette in this app already means something,
              // and a divider borrowing one would be read as that thing.
              'line-color': '#ffffff',
              'line-opacity': 0.85,
              'line-width': SEAM_WIDTH,
            }}
          />
        </GeoJSONSource>
      ) : null}
    </>
  );
}
