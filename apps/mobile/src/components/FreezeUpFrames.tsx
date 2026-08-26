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
import { useMemo, useState } from 'react';
import { env } from '../lib/env';

export const FREEZE_UP_SOURCE_ID = 'freeze-up-frame';
export const FREEZE_UP_LAYER_ID = 'freeze-up-frame-raster';
/** The outgoing pass, held one notch behind so a scrub never uncovers bare cartography. */
export const FREEZE_UP_PREVIOUS_SOURCE_ID = 'freeze-up-frame-previous';
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
  companion,
  season,
  body,
}: {
  stop: TimelineStop | null;
  /**
   * The seam half to draw, which **outlives the stop that supplied it** (`framesToRender`).
   *
   * Passed in rather than read off `stop.companion`: sliding from a seamed pass to an unseamed one
   * would otherwise unmount half the lake and leave bare cartography where 40% of a reservoir was.
   */
  companion: IndexedFrame | null;
  season: string | null;
  /** The lake, which clips the granule edge down to the part anyone can see. */
  body: Polygon | MultiPolygon | null;
}) {
  // ⚠ **The frame the scrubber just left, kept underneath the one it moved to.**
  //
  // > **Founder, 2026-08-26:** *"sliding around its timeline […] the image disappears for a second or
  // > two and then re-appears at every notch change."*
  //
  // Reported on web, and the cause is the same on both: React unmounts the outgoing `<Frame>` before
  // the incoming one has any tiles, so every notch crossing had a window with nothing drawn. Web fixes
  // it with two explicit lanes it can cross-fade (`useFreezeUpFrame`); here there is no load event to
  // hang a fade on, so the declarative equivalent does the same job — **render the previous pass too,
  // below the current one.** Both are masked to the same lake, so the new frame simply covers the old
  // as its tiles arrive, and until then the old one is what is on screen. There is no moment with
  // neither.
  //
  // ⚠ **The pair moves only when the key genuinely changes**, which is not the same as "on every
  // render". Holding a bare `previous` and rewriting it each pass looked equivalent and was not: this
  // component re-renders for reasons that have nothing to do with the scrubber — the map's viewport
  // query, a hazard arriving — and each of those would have retired the held frame, quite possibly
  // before its replacement had a single tile. The outgoing frame has to be retired by *a new date*,
  // not by the clock.
  //
  // ## ⚠ Adjusted during render, and here that is the correct tool rather than a shortcut
  //
  // React's documented pattern for "state derived from a change in props" — call the setter during
  // render, guarded so it cannot loop, and React re-runs this component immediately, discarding the
  // first pass before it reaches children or the host. State rather than a ref, so a render React
  // abandons cannot leave the pair advanced to a frame that was never shown.
  //
  // **A layout effect would be wrong here, unlike in `MapView`.** The new pass arrives as a prop, so
  // the render that first sees it would commit with `previous` still empty — unmounting the outgoing
  // `<Frame>` — and the effect would then re-mount it a commit later as a different element, which
  // re-fetches its tiles. That is precisely the flicker this hold exists to remove, reintroduced by
  // the fix. `MapView` can use an effect because *its* intermediate state is "still showing the old
  // picture", which is what the hold wants anyway; here the intermediate is "showing nothing".
  const [frames, setFrames] = useState<{
    current: IndexedFrame | null;
    previous: IndexedFrame | null;
  }>({ current: null, previous: null });
  if (stop && frames.current?.key !== stop.frame.key) {
    setFrames({ current: stop.frame, previous: frames.current });
  }
  const previous = frames.previous;

  // ⚠ **Memoised, and on this platform that is not a micro-optimisation.** `seamFeature` walks the
  // granule footprint at 25 m spacing — a Sentinel edge is 110–250 km, so it is tens of thousands of
  // point-in-polygon tests against a shoreline that can carry thousands of vertices — and it runs on
  // the JS thread, the same one the pan gesture's callbacks are on (`runOnJS(true)`). Recomputed per
  // render it fired on every viewport query and every arriving hazard, i.e. exactly the renders the
  // note above says have nothing to do with the scrubber. It also handed `<GeoJSONSource>` a fresh
  // object each time, so the native source was re-set on every one of them.
  const footprint = companion ? (stop?.frame.footprint ?? null) : null;
  const seam = useMemo(
    () => (footprint && body ? seamFeature(footprint, body) : null),
    [footprint, body],
  );

  if (!stop || !season || !env.imageryArchiveUrl) return null;

  return (
    <>
      {/* Held one notch behind, and dropped as soon as there is a *newer* outgoing frame to hold —
          so this is bounded at one extra raster, never a growing pool. */}
      {previous && previous.key !== stop.frame.key ? (
        <Frame
          key={`previous:${previous.key}`}
          frame={previous}
          season={season}
          prefix={FREEZE_UP_PREVIOUS_SOURCE_ID}
        />
      ) : null}
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
              // White rather than a theme color: every palette in this app already means something,
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
