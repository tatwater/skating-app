/**
 * The shared MapLibre shell (A02, Decision 12) — everything two maps in this app have in common.
 *
 * `MapView` was a 745-line imperative component that owned both the *canvas* (protocol registration,
 * basemap style, theme flavor, bounds, controls, viewport reporting, teardown) and the *skater map*
 * (water layers, hazards, pins, tracks, drawer navigation). The lake editor needs the first half and
 * almost none of the second, so the founder's call was one shell rather than a second canvas: one
 * place for map bugs, one style pipeline, one set of teardown rules.
 *
 * The seam is deliberately low. This hook owns nothing above "there is a map, themed, bounded, and
 * telling you where it's looking" — the caller registers its own sources, layers and handlers in
 * `onLoad`. Drawing it higher would produce a shell with a dozen conditional props, which is two
 * components wearing one name (the risk `plans/phases/A02-body-editor-and-subareas.md` flags under
 * *To settle during the build*).
 *
 * **The skater path must come out behaviorally identical**, which is the price of Decision 12 and a
 * testing obligation rather than an aspiration: the existing map suite runs green unchanged.
 */

import type { BBox } from '@skating/core';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FoldedAttributionControl } from './mapAttribution';
import { boundsToViewport, buildMapStyle, type MapFlavor, zoomForViewport } from './waterMap';

export interface MapCanvasOptions {
  pmtilesUrl: string;
  /**
   * The whole-planet z0–6 overview archive, which draws the ocean and the continents everywhere the
   * regional archive has nothing to say. Blank ⇒ single-source style, as before the two-archive
   * basemap: the map renders, but stops dead at the regional archive's edge.
   */
  worldPmtilesUrl?: string;
  /** Basemap theme (D6/D34). A change re-creates the map; the shell preserves pan/zoom across it. */
  flavor: MapFlavor;
  /**
   * Pan limit, or omitted for none. The lake editor pins it to one lake's bbox (Decision 5). The
   * skater map no longer sets it at all: with a world overview under the map there is a whole planet
   * to look at, and `ReturnToRegion` handles the getting-back rather than a fence handling the
   * getting-away.
   */
  maxBounds?: [[number, number], [number, number]];
  initialCenter: [number, number];
  initialZoom: number;
  /**
   * Floor on zoom-out. The editor sets it to the zoom that fits its lake, which — with `maxBounds`
   * — is what makes "which lake am I editing" unambiguous rather than merely likely.
   */
  minZoom?: number;
  /** Frame these bounds on first load instead of using `initialCenter`/`initialZoom`. */
  fitBounds?: [[number, number], [number, number]] | null;
  /**
   * Register sources, layers and event handlers. Called once per map instance, inside `load`.
   * Read through a ref, so it may close over fresh values without re-creating the map.
   */
  onLoad: (map: maplibregl.Map) => void;
  /** The viewport + D49 zoom bucket, on first load and after every `moveend`. */
  onViewport?: (view: { viewport: BBox; zoom: number }) => void;
  /** Extra MapLibre controls beyond attribution — the skater map wants navigation, the editor doesn't. */
  navigationControl?: boolean;
  /**
   * A credit for something drawn whose source can't declare one, shown in the map's own credits
   * beside the sources' — the skater map's contour credit, which depends on whose lines are in
   * view. `null`/omitted shows none. Changing it updates the credits in place, never the map.
   */
  extraAttribution?: string | null;
}

/**
 * How many live maps are using the `pmtiles://` protocol handler.
 *
 * `addProtocol`/`removeProtocol` are **global** to maplibre-gl, not per-map, so an unmount that
 * unregisters unconditionally breaks any map still on screen — and the two surfaces that use this
 * shell (the skater map, kept mounted across the `_map` tree, and the lake editor) will overlap the
 * moment anything embeds one in the other. Refcounting costs two lines and removes the ordering
 * hazard entirely.
 */
let pmtilesUsers = 0;

/**
 * The class every MapLibre container in this app wears — **a height and a width, never a position**.
 *
 * MapLibre's own stylesheet declares `.maplibregl-map { position: relative }`, and it is loaded
 * with the canvas chunk, so it lands *after* the app's sheet. Both selectors are one class, so the
 * later one wins: an `absolute inset-0` container is silently turned back into a static-flow box
 * with `inset` doing nothing, which leaves it `height: 0`. MapLibre then sizes its canvas from
 * `getBoundingClientRect().height || 300` and the map draws a 300 px strip, or nothing at all.
 * Nothing errors, so the only symptom is a blank map.
 *
 * `size-full` asks for the same box without touching `position`, so the rule has nothing to
 * override. The pane around it (`MapPane`, `relative isolate overflow-hidden`) is what positions it.
 */
export const MAP_CONTAINER_CLASS = 'size-full';

export interface MapCanvas {
  containerRef: React.RefObject<HTMLDivElement | null>;
  mapRef: React.RefObject<maplibregl.Map | null>;
  /** True once `load` has fired — what *renders* over the map waits on this. */
  loaded: boolean;
  /**
   * The live map if its style is ready to be written to, else `null`.
   *
   * **Every effect that touches the map imperatively must gate on this, never on `mapRef.current`
   * plus `loaded`** (B03 §8.3). `loaded` is React state, so an effect body reads the value from the
   * render that scheduled it — while `mapRef` is mutated during the commit. A theme switch changes
   * `flavor` *and* the caller's palette in one render, so the cleanup that removes the old map and
   * the body that builds the new one both run in a commit where `loaded` still says `true`: a style
   * write in that window lands on a map whose style has not loaded and MapLibre throws
   * `Style is not done loading.`, which the error boundary turns into the crash screen. Reading
   * readiness from a ref the same commit updates keeps the two in step.
   *
   * This is a caller's whole dependency: it takes a new identity whenever readiness changes, which
   * is what re-runs their effect — and so re-applies everything — once the new map is ready. Listing
   * `loaded` beside it is redundant.
   */
  liveMap: () => maplibregl.Map | null;
}

/**
 * Create and own one MapLibre map.
 *
 * The re-create-on-theme-change behavior is inherited from `MapView` rather than reconsidered: the
 * basemap style is built per flavor, and rebuilding it in place would mean re-adding every caller's
 * layers anyway. `lastViewRef` carries pan/zoom across, so the user doesn't notice.
 */
export function useMapCanvas(options: MapCanvasOptions): MapCanvas {
  const {
    pmtilesUrl,
    worldPmtilesUrl,
    flavor,
    maxBounds,
    initialCenter,
    initialZoom,
    minZoom,
    fitBounds,
    navigationControl = true,
    extraAttribution = null,
  } = options;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  /**
   * The map that has fired `load`, **as state** rather than a boolean, so `liveMap` can key on it.
   *
   * A boolean would collapse: a `load` landing in the same React batch as the cleanup's reset — a
   * synchronous style, or a caller firing it inside the effect — would settle back on `true`, the
   * memo below would keep its identity and no caller effect would re-run, leaving the new instance
   * with no spec, no filters and no sources and no error anywhere. Two instances are never the same
   * object, so keying on the map itself cannot collapse that way.
   */
  const [loadedMap, setLoadedMap] = useState<maplibregl.Map | null>(null);
  const loaded = loadedMap !== null;
  // The same fact again, in a ref so it is true of `mapRef.current` *now* and not of whichever map
  // was live when the current render was scheduled — it is what closes the window between a `load`
  // and the re-render it schedules. See `MapCanvas.liveMap`.
  const styleLoadedRef = useRef(false);
  // A fresh identity per readiness change, so `liveMap` is a caller's whole dependency: it both reads
  // the map and re-runs their effect once a new one can take a write.
  const liveMap = useMemo(
    () => () => (loadedMap !== null && styleLoadedRef.current ? mapRef.current : null),
    [loadedMap],
  );
  const lastViewRef = useRef<{ center: [number, number]; zoom: number } | null>(null);

  // Both callbacks are read through refs so a caller can close over current state without the map
  // being torn down and rebuilt underneath it on every render.
  const onLoadRef = useRef(options.onLoad);
  onLoadRef.current = options.onLoad;
  const onViewportRef = useRef(options.onViewport);
  onViewportRef.current = options.onViewport;
  // The credits control of the live map, and the extra credit a re-created map starts from.
  const attributionRef = useRef<FoldedAttributionControl | null>(null);
  const extraAttributionRef = useRef(extraAttribution);
  extraAttributionRef.current = extraAttribution;

  // `maxBounds` and `fitBounds` are array literals a caller usually rebuilds each render; compare by
  // value so the map isn't re-created on every parent render.
  const boundsKey = JSON.stringify(maxBounds);
  const fitKey = JSON.stringify(fitBounds ?? null);

  // **The initial camera is read through a ref and is NOT a dependency**, and that distinction is
  // load-bearing rather than tidy. These three only matter at construction — MapLibre has consumed
  // them before `load` fires — so re-creating the map when their *identity* changes buys nothing and
  // costs everything: `LakeEditorMap` derives `initialCenter` from its body's bbox as a fresh array
  // literal each render, so with them in the dep array every parent state change (a finished draw,
  // a saved banner, a Convex query resolving) tore the canvas down and rebuilt it. That is visible
  // as a flicker and fatal to anything holding the map — the lazily-created terra-draw control keeps
  // a reference to the instance it attached to, so the editor could draw exactly one shape per page
  // load and then silently accept clicks that went nowhere.
  const initialViewRef = useRef({ center: initialCenter, zoom: initialZoom, minZoom });
  initialViewRef.current = { center: initialCenter, zoom: initialZoom, minZoom };

  // biome-ignore lint/correctness/useExhaustiveDependencies: bounds are compared by their serialized key.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const protocol = new Protocol();
    if (pmtilesUsers === 0) maplibregl.addProtocol('pmtiles', protocol.tile);
    pmtilesUsers++;

    const initialView = initialViewRef.current;
    const map = new maplibregl.Map({
      container,
      style: buildMapStyle({ regionUrl: pmtilesUrl, worldUrl: worldPmtilesUrl, flavor }),
      // Restore pan/zoom across a theme-driven re-create; else the caller's initial framing.
      center: lastViewRef.current?.center ?? initialView.center,
      zoom: lastViewRef.current?.zoom ?? initialView.zoom,
      ...(maxBounds ? { maxBounds } : {}),
      ...(initialView.minZoom !== undefined ? { minZoom: initialView.minZoom } : {}),
      attributionControl: false, // replaced below by the folded one — see `mapAttribution`
      // **North is up, always.** A rotated map is a trap here rather than a feature: the navigation
      // control is built with `showCompass: false`, so once a two-finger twist or a right-drag has
      // spun the view there is no affordance anywhere to put it back — and nobody rotates a map on
      // purpose, they do it by accident while pinching to zoom. It costs a skater their bearings on
      // the one surface where "which way is the far shore" is the question being asked.
      //
      // Pitch goes with it. It is the same accidental two-finger gesture, and a tilted lake reads as
      // a different shape than the one on the polygon it is drawn from.
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    mapRef.current = map;
    // The other two rotation paths, which are handler methods rather than constructor options: the
    // two-finger twist (the accidental one) and shift+arrows on the keyboard. `touchZoomRotate` stays
    // enabled — pinch-to-zoom is essential — with only its rotation half switched off.
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    // The credits, compact and folded behind an ⓘ that stays on the map — see `mapAttribution`
    // for why MapLibre's own `compact: true` is not enough on its own.
    const attribution = new FoldedAttributionControl();
    attribution.setExtraAttribution(extraAttributionRef.current);
    map.addControl(attribution);
    attributionRef.current = attribution;
    if (navigationControl) {
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    }

    const syncViewport = () => {
      const c = map.getCenter();
      lastViewRef.current = { center: [c.lng, c.lat], zoom: map.getZoom() };
      onViewportRef.current?.({
        viewport: boundsToViewport(map.getBounds()),
        zoom: zoomForViewport(map.getZoom()),
      });
    };

    map.on('load', () => {
      // Re-measure the container. A cheap guard, not a fix for an observed bug.
      //
      // MapLibre sizes its canvas **once, synchronously, in the constructor**, falling back to
      // 400×300 if the container measures zero, and its `ResizeObserver` only fires on subsequent
      // *changes* — so a container that is briefly zero at construction and correct forever after
      // produces a 300px map inside a full-height box, with the viewport query framed on bounds
      // nobody is looking at. That was never possible while the map was a fixed `75vh` block; now
      // that its height comes from the flex layout, it is one unsettled frame away.
      map.resize();
      styleLoadedRef.current = true;
      // Frame the caller's bounds before anything reads the viewport, so the first query is scoped to
      // what the user will actually be looking at rather than to the pre-fit view.
      if (fitBounds && !lastViewRef.current)
        map.fitBounds(fitBounds, { padding: 24, animate: false });
      onLoadRef.current(map);
      setLoadedMap(map);
      syncViewport(); // first query, framed on the initial view
    });
    map.on('moveend', syncViewport);

    return () => {
      styleLoadedRef.current = false;
      setLoadedMap(null);
      map.remove();
      mapRef.current = null;
      attributionRef.current = null;
      pmtilesUsers = Math.max(0, pmtilesUsers - 1);
      if (pmtilesUsers === 0) maplibregl.removeProtocol('pmtiles');
    };
    // `initialCenter` / `initialZoom` / `minZoom` are deliberately absent — see `initialViewRef`.
  }, [pmtilesUrl, worldPmtilesUrl, flavor, boundsKey, fitKey, navigationControl]);

  // The credit follows the caller in place; a re-created map took the current one at construction.
  useEffect(() => {
    attributionRef.current?.setExtraAttribution(extraAttribution);
  }, [extraAttribution]);

  return { containerRef, mapRef, loaded, liveMap };
}
