/**
 * Painting one archived pass onto the map (N6e §C2, D148).
 *
 * ## The client does almost nothing here, and that was the point of the archive
 *
 * A frame is a `.pmtiles` raster whose **alpha was baked server-side** — clipped to the lake, its
 * approach and its parking, with a 240 m feather already ramped in. So showing a date is adding a
 * raster source and removing the previous one. No canvas, no mask arithmetic, no per-body fetch, and
 * nothing to keep in step with the projection.
 *
 * That is the whole argument D148 made for owning an archive rather than metering an API, and it is
 * also why mobile can have this: `useImageryReveal` needs a `CanvasRenderingContext2D` that React
 * Native does not have, and this needs a URL.
 *
 * ## ⚠ Two lanes, because a source's URL is immutable and React tears down before it builds
 *
 * MapLibre offers no way to repoint a raster source, so a new date means a new source. The obvious
 * shape — one source id, torn down in the effect's cleanup and rebuilt in the next effect — is what
 * this used to be, and it has a hole in it that no amount of preloading closes:
 *
 * > **Founder, 2026-08-26:** *"I just tried sliding around its timeline and it's impossible to tell
 * > what's changing because the image disappears for a second or two and then re-appears at every
 * > notch change, even going backwards to the previous radar image."*
 *
 * React runs a cleanup **before** the effect that replaces it. So every notch crossing had a window
 * with nothing on the map at all, opening the instant the old source was removed and closing only
 * when the new one's tiles arrived. On true color that window is short enough to read as a flicker;
 * on radar, where the difference between two dates is a couple of decibels of grey, it destroyed the
 * comparison the scrubber exists for — the eye has nothing to hold between the two pictures.
 *
 * So each slot owns **two lanes** and they leapfrog. The incoming date mounts on the free lane at
 * zero opacity while the outgoing one keeps the screen; when the new lane's *own* tiles report it
 * fades up over the top, and only then does the old one go dark. There is no frame in which neither
 * is drawn.
 *
 * **And the lane that went dark stays mounted.** Scrubbing back and forth between two dates is not an
 * edge case, it is the whole gesture — so the return trip finds its raster already there and is
 * instantaneous, where remove-then-rebuild made it a cold load every time. A lane is only torn down
 * when a *third* date needs it, which bounds this at two rasters per slot rather than a growing pool.
 *
 * ⚠ **The reveal is gated on `sourcedata` for this source id, never on `idle`.** A source added
 * after the map's `load` event can leave `idle` permanently un-fired — a gotcha this repo has already
 * paid for once on the bathymetry layer. Waiting for `idle` here would mean a frame that fetched
 * perfectly well and never became visible.
 */

import type { IndexedFrame } from '@skating/core';
import { archiveUrl, copernicusCredit } from '@skating/core';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { env } from '../lib/env';
import { FREEZE_UP_SEAM_LAYER_ID } from './useFreezeUpSeam';
import { FREEZE_UP_LAYER_PREFIX, insertBeforeLayerId } from './useImageryReveal';

/**
 * Which half of a seam a mount is for.
 *
 * Two slots rather than one, because a lake bisected by a granule edge needs both halves on screen at
 * once — see `TimelineStop.companion`. They are separate sources with separate lifecycles so that
 * scrubbing to a date with no companion tears down exactly one of them.
 */
export type FreezeUpSlot = 'primary' | 'companion';

export const FREEZE_UP_SOURCE_ID = 'freeze-up-frame';
// Re-exported from the module that owns the imagery stack, so the aerial's anchor and this one
// cannot name different layers. See `FREEZE_UP_LAYER_PREFIX`.
export const FREEZE_UP_LAYER_ID = FREEZE_UP_LAYER_PREFIX;

/** Which of a slot's lanes. See the module note. */
export type FreezeUpLane = number;

/**
 * How many frames a slot keeps mounted at once.
 *
 * > **Founder, 2026-08-26:** *"even radar images I was just looking at moments ago take a couple
 * > seconds to show up. This could be much faster using a local cache, right?"*
 *
 * These lanes **are** that cache, at the only level that helps: MapLibre keeps a mounted source's
 * decoded tiles, so re-showing one is a paint change rather than a fetch. Two lanes made a swap
 * seamless and a *return* still cost a cold load, which is the wrong half of the problem — scrubbing
 * is not a walk in one direction, it is a skater going back and forth over three or four dates
 * comparing them.
 *
 * Six, because a radar season is ~9 usable passes and an optical one ~30: it holds a whole
 * neighbourhood of radar and the working set of an optical scrub, and six lake-masked rasters is a
 * bounded amount of memory. The cost of raising it is that MapLibre keeps fetching tiles for every
 * mounted source as the camera moves, so this trades bandwidth on pan for latency on scrub.
 *
 * ⚠ It does not survive a reload, a lake change, or turning imagery off — everything is torn down
 * with the layer. A cache that outlives the session is the archive's own HTTP caching, which is a
 * separate question from this one.
 */
export const FREEZE_UP_LANE_COUNT = 6;

/** The ids one lane owns. Stable per (slot, lane), so a lane can be found again to be re-shown. */
export function freezeUpLaneIds(
  slot: FreezeUpSlot,
  lane: FreezeUpLane,
): {
  sourceId: string;
  layerId: string;
} {
  const suffix = slot === 'primary' ? '' : '-companion';
  return {
    sourceId: `${FREEZE_UP_SOURCE_ID}${suffix}-${lane}`,
    layerId: `${FREEZE_UP_LAYER_ID}${suffix}-${lane}`,
  };
}

/**
 * Where this slot's raster belongs in the stack, as a `beforeId`.
 *
 * ⚠ **`insertBeforeLayerId` alone is not enough, because `show()` re-inserts.** Every layer added
 * with the shared anchor lands *above* the ones added before it, so mount order used to be the whole
 * ordering — and `moveLayer(layer, anchor)` on every notch crossing broke it silently in two ways:
 *
 * - **The seam went under the photograph.** `useFreezeUpSeam` adds its hairline with the same anchor
 *   after the frames, so it starts on top; the first `show()` moved a raster back above it and the
 *   §C4 join simply stopped being drawn.
 * - **The companion could cover the primary.** `framesToRender` holds a stale companion precisely
 *   *because* the primary occludes it wherever the primary has water — so whichever slot's tiles
 *   happened to land last winning the stack turns a held half into a frame from another date drawn
 *   over the one the caption names.
 *
 * So the order is stated rather than inherited: companion under primary, primary under the seam.
 */
function frameAnchorId(map: maplibregl.Map, slot: FreezeUpSlot): string | undefined {
  if (slot === 'companion') {
    // The lowest primary lane currently in the style — read from the style rather than from lane
    // indices, because lane order is eviction order and says nothing about z.
    const lowestPrimary = (map.getStyle()?.layers ?? []).find(
      (layer) =>
        layer.id.startsWith(`${FREEZE_UP_LAYER_ID}-`) &&
        !layer.id.startsWith(`${FREEZE_UP_LAYER_ID}-companion-`),
    );
    if (lowestPrimary) return lowestPrimary.id;
  }
  if (map.getLayer(FREEZE_UP_SEAM_LAYER_ID)) return FREEZE_UP_SEAM_LAYER_ID;
  return insertBeforeLayerId(map);
}

/** Long enough to read as a cross-fade, short enough not to feel like latency. */
const FADE_MS = 180;

/**
 * How long to wait for a clean "loaded" before showing the frame anyway.
 *
 * ⚠ **A floor under a whole class of bug, not a nicety.** `isSourceLoaded` is a statement about the
 * tiles the *current viewport* needs, so a source can sit un-loaded indefinitely — a tile that 404s,
 * a range read that stalls, a viewport MapLibre has not asked about yet. Every one of those leaves a
 * fully-downloaded frame at zero opacity, and the user has no way to know: the map just shows the
 * summer aerial and the scrubber looks broken. Observed live twice on 2026-08-25.
 *
 * **A partially-drawn frame is strictly better than an invisible one.** Tiles that do arrive keep
 * arriving and fill in; the alternative is a control that silently does nothing. Two seconds is long
 * enough that a healthy load reveals through the normal path and short enough that a stall does not
 * read as a dead feature.
 */
const REVEAL_TIMEOUT_MS = 2000;

/** One lane's live state — what it is showing and the timers and listener that belong to it. */
interface MountedLane {
  key: string;
  sourceId: string;
  layerId: string;
  onSourceData: (event: maplibregl.MapSourceDataEvent) => void;
  revealTimer: ReturnType<typeof setTimeout>;
  /** Set when this lane is being replaced: the delayed fade-out that follows its successor's fade-in. */
  hideTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Mount the selected frame, and tear it down when the scrubber closes.
 *
 * `frame` is `null` whenever there is nothing to show — the reveal is off, the archive is not
 * configured, or no stop is landable — and each of those is an ordinary state rather than an error.
 */
export function useFreezeUpFrame({
  mapRef,
  loaded,
  frame,
  season,
  slot = 'primary',
}: {
  mapRef: { current: maplibregl.Map | null };
  loaded: boolean;
  frame: IndexedFrame | null;
  season: string | null;
  slot?: FreezeUpSlot;
}): void {
  const baseUrl = env.imageryArchiveUrl;
  const key = frame?.key ?? null;

  // Imperative bookkeeping, deliberately outside React's tree. The whole point is that a lane
  // OUTLIVES the render that mounted it — tying either lane's lifetime to an effect's cleanup is the
  // remove-then-add shape that produced the blank.
  const lanesRef = useRef<(MountedLane | null)[]>(
    Array.from({ length: FREEZE_UP_LANE_COUNT }, () => null),
  );
  const shownRef = useRef<FreezeUpLane | null>(null);
  /** Lanes most-recently-shown first — the eviction order when a new date needs a lane. */
  const recencyRef = useRef<FreezeUpLane[]>([]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    /** Take a lane down completely. Only ever called on a lane nobody is looking at. */
    const drop = (lane: FreezeUpLane) => {
      const mounted = lanesRef.current[lane];
      if (!mounted) return;
      clearTimeout(mounted.revealTimer);
      clearTimeout(mounted.hideTimer);
      map.off('sourcedata', mounted.onSourceData);
      // Order matters: a source with a layer still attached throws on removal.
      if (map.getLayer(mounted.layerId)) map.removeLayer(mounted.layerId);
      if (map.getSource(mounted.sourceId)) map.removeSource(mounted.sourceId);
      lanesRef.current[lane] = null;
      recencyRef.current = recencyRef.current.filter((index) => index !== lane);
      if (shownRef.current === lane) shownRef.current = null;
    };

    if (!loaded || !baseUrl || !key || !season) {
      for (let lane = 0; lane < lanesRef.current.length; lane++) drop(lane);
      return;
    }

    const shown = shownRef.current;
    if (shown !== null && lanesRef.current[shown]?.key === key) return;

    /**
     * Bring a lane to the front and let the one behind it go dark — but not until the fade has
     * finished. ⚠ Dropping the outgoing lane's opacity in the same tick would leave both rasters
     * part-transparent for the length of the cross-fade, and the basemap would show through the
     * middle of it: the flash this whole arrangement exists to prevent, arriving by a subtler road.
     */
    const show = (lane: FreezeUpLane) => {
      const mounted = lanesRef.current[lane];
      if (!mounted || !map.getLayer(mounted.layerId)) return;
      clearTimeout(mounted.revealTimer);
      // Raise it, because a re-shown lane is *underneath* the one it is replacing — it was added
      // first. Without this the outgoing frame stays on top and the fade happens invisibly.
      // ⚠ To the top of *this slot's* band, never to the shared anchor — see `frameAnchorId`.
      map.moveLayer(mounted.layerId, frameAnchorId(map, slot));
      map.setPaintProperty(mounted.layerId, 'raster-opacity', 1);

      // Only the lane being replaced needs hiding; every other mounted lane is already dark, held
      // for its tiles rather than for its pixels.
      const outgoing = shownRef.current;
      const previous = outgoing !== null && outgoing !== lane ? lanesRef.current[outgoing] : null;
      if (previous && map.getLayer(previous.layerId)) {
        clearTimeout(previous.hideTimer);
        previous.hideTimer = setTimeout(() => {
          if (map.getLayer(previous.layerId)) {
            map.setPaintProperty(previous.layerId, 'raster-opacity', 0);
          }
        }, FADE_MS);
      }
      shownRef.current = lane;
      recencyRef.current = [lane, ...recencyRef.current.filter((index) => index !== lane)];
    };

    // Already mounted — a date the skater has been to before, which after two or three notches is
    // most of them. No fetch and no wait: MapLibre still holds this source's tiles.
    const held = lanesRef.current.findIndex((mounted) => mounted?.key === key);
    if (held >= 0) {
      show(held);
      return;
    }

    // A date nobody has a lane for. Take an empty one, or evict the least recently *shown* — never
    // the one on screen, which would be tearing down the picture to make room for its replacement.
    //
    // ⚠ **`recency` only holds lanes that have actually been *shown*.** Scrub faster than the tiles
    // arrive and every lane is mounted while at most one of them is in that list — so the search
    // below has to fall back to any lane that is not the visible one, and the previous `?? 0` did
    // not: with lane 0 on screen and nothing else ever shown it evicted lane 0, blanking the map.
    // That is precisely the failure the lanes exist to prevent, arriving through the eviction path.
    const empty = lanesRef.current.indexOf(null);
    const evictable = (lane: FreezeUpLane) => lane !== shownRef.current;
    const stalest =
      [...recencyRef.current].reverse().find(evictable) ??
      lanesRef.current.map((_, lane) => lane).find(evictable);
    const target: FreezeUpLane = empty >= 0 ? empty : (stalest ?? 0);
    drop(target);

    const { sourceId, layerId } = freezeUpLaneIds(slot, target);
    const url = `pmtiles://${archiveUrl(baseUrl, key)}`;

    // ⚠ **Listen before adding, or the event that matters has already gone.**
    //
    // Registering after `addSource` loses the race whenever the source resolves quickly — a warm
    // pmtiles header, a cached range read — and the layer then sits at zero opacity until *something
    // else* makes MapLibre re-emit. Observed live 2026-08-25: nothing appeared until the camera
    // moved, at which point the new tile loads produced a second `sourcedata` and the frame revealed.
    //
    // The symptom is the cruellest available, because it looks like the archive is broken and the
    // fix is a zoom nobody thinks to try.
    const onSourceData = (event: maplibregl.MapSourceDataEvent) => {
      if (event.sourceId !== sourceId) return;
      if (!map.getSource(sourceId) || !map.isSourceLoaded(sourceId)) return;
      // ⚠ Only if it is still wanted. A lane that finishes loading after the skater has scrubbed past
      // it must not haul itself to the front — that is a stale date painting over the current one.
      if (lanesRef.current[target]?.key === key && shownRef.current !== target) show(target);
    };
    map.on('sourcedata', onSourceData);

    const mounted: MountedLane = {
      key,
      sourceId,
      layerId,
      onSourceData,
      // The floor — see `REVEAL_TIMEOUT_MS`. Scoped to this lane, so a stalled frame reveals itself
      // rather than leaving the outgoing one up forever.
      revealTimer: setTimeout(() => {
        if (lanesRef.current[target]?.key === key) show(target);
      }, REVEAL_TIMEOUT_MS),
      hideTimer: undefined,
    };
    lanesRef.current[target] = mounted;

    map.addSource(sourceId, {
      type: 'raster',
      url,
      // The cutter tiles at 512 and the frames are WEBP; saying so saves MapLibre a probe request and
      // stops it assuming the 256 default, which would draw every frame at half scale.
      tileSize: 512,
      // ⚠ **Copernicus' credit is required, and this is how it gets rendered.** `AttributionControl`
      // unions the `attribution` of every *active source*, so declaring it here makes the credit
      // appear the moment a frame mounts and disappear when it unmounts, with nothing to remember —
      // the same mechanism the basemap and the aerial reveal already use. A hand-composed credit
      // string elsewhere is the version that goes stale the first time someone adds a layer.
      attribution: copernicusCredit(season),
    });
    map.addLayer(
      {
        id: layerId,
        type: 'raster',
        source: sourceId,
        paint: {
          // ⚠ Zero on the FIRST frame too, not just on a swap. There is nothing underneath it then,
          // so it fades up from the basemap — which is the one moment a fade from nothing is honest.
          'raster-opacity': 0,
          'raster-opacity-transition': { duration: FADE_MS, delay: 0 },
          // ⚠ Off, and load-bearing. MapLibre's default resampling blends neighbouring tiles at
          // zoom boundaries, which on an alpha-masked frame smears the feather the cutter spent a
          // `gdal_proximity` pass computing — a soft edge turning into a soft *smudge*.
          'raster-fade-duration': 0,
        },
      },
      frameAnchorId(map, slot),
    );

    // And ask once directly, for the case where it loaded between `addSource` and here. The event is
    // the async path; this is the synchronous one, and needing both is what the race above means.
    if (map.isSourceLoaded(sourceId)) show(target);

    // ⚠ **No cleanup that removes anything.** Every lane is meant to survive this effect — that is
    // the fix. Teardown happens on unmount (below), or when a new date evicts the stalest lane.
    // `baseUrl` is inlined by Vite at build and cannot change within a session.
  }, [mapRef, loaded, key, season, slot]);

  // The only unconditional teardown. Split from the reconciler above because unmounting is the one
  // moment when nothing being on the map is correct.
  //
  // ⚠ **Empty deps, and `mapRef` is read at cleanup time rather than captured.** Keyed on `mapRef` it
  // fired whenever that object's *identity* changed, which tore both lanes down and rebuilt from
  // scratch — reintroducing the blank this hook exists to remove, on any caller that does not hand us
  // a stable ref. A ref's identity is not a fact about the map. A map that is genuinely re-created
  // arrives here as `loaded` going false, which the reconciler already handles.
  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount only — see above.
  useEffect(() => {
    const lanes = lanesRef.current;
    const shown = shownRef;
    return () => {
      const map = mapRef.current;
      for (const [index, mounted] of lanes.entries()) {
        if (!mounted) continue;
        clearTimeout(mounted.revealTimer);
        clearTimeout(mounted.hideTimer);
        map?.off('sourcedata', mounted.onSourceData);
        if (map?.getLayer(mounted.layerId)) map.removeLayer(mounted.layerId);
        if (map?.getSource(mounted.sourceId)) map.removeSource(mounted.sourceId);
        lanes[index] = null;
      }
      shown.current = null;
    };
  }, []);
}
