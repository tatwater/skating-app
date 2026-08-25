/**
 * The shared MapLibre shell (N2, Decision 12) — everything two maps in this app have in common.
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
 * components wearing one name (the risk `plans/phase-N2-lake-editor-and-subareas.md` flags under
 * *To settle during the build*).
 *
 * **The skater path must come out behaviourally identical**, which is the price of Decision 12 and a
 * testing obligation rather than an aspiration: the existing map suite runs green unchanged.
 */

import type { BBox } from '@skating/core';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { useEffect, useRef, useState } from 'react';
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

export interface MapCanvas {
  containerRef: React.RefObject<HTMLDivElement | null>;
  mapRef: React.RefObject<maplibregl.Map | null>;
  /** True once `load` has fired — every `setData` effect has to wait for it. */
  loaded: boolean;
}

/**
 * Create and own one MapLibre map.
 *
 * The re-create-on-theme-change behaviour is inherited from `MapView` rather than reconsidered: the
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
  } = options;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [loaded, setLoaded] = useState(false);
  const lastViewRef = useRef<{ center: [number, number]; zoom: number } | null>(null);

  // Both callbacks are read through refs so a caller can close over current state without the map
  // being torn down and rebuilt underneath it on every render.
  const onLoadRef = useRef(options.onLoad);
  onLoadRef.current = options.onLoad;
  const onViewportRef = useRef(options.onViewport);
  onViewportRef.current = options.onViewport;

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
      attributionControl: false, // replaced below — see the `compact` note on `addControl`
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
    // **Compact: the credits live behind an ⓘ rather than across the map** (N6e A4, founder ask:
    // *"can we keep all attribution strings in the sidebar/drawer, instead of over the map itself?"*).
    //
    // MapLibre's own compact mode *is* that affordance, and using it beats hand-rolling one for a
    // reason that outlives this phase: the control unions the `attribution` of every **active
    // source**, so the aerial credit appears the moment the reveal adds its source and disappears
    // when it removes it, with nothing to remember. A hand-composed string is the version that goes
    // stale the first time someone adds a layer.
    //
    // It also settles the ODbL question rather than skirting it. OSM's guidance wants the credit in
    // the corner of a browsable map *or* behind a clearly-labelled affordance on the map itself —
    // an ⓘ is the second of those. Credits reachable only from a drawer, on a map that renders
    // perfectly well with no drawer open, would be the configuration that risks it.
    map.addControl(new maplibregl.AttributionControl({ compact: true }));
    // ⚠ **`compact` does not mean *collapsed*, and that is the whole of what looked wrong.**
    //
    // MapLibre mounts the compact control **expanded** (`_updateCompact` adds `maplibregl-compact`
    // *and* `maplibregl-compact-show`) and only minimises it on the first `drag` — not on a zoom, not
    // on a click, not on a fly-to. So a map that is opened and read rather than dragged shows every
    // credit of every active source laid across the bottom edge for the entire session, growing each
    // time a source mounts: adding the freeze-up frames is what turned it into
    // *"© OpenStreetMap contributors | Copernicus Sentinel data 2025–2026"*.
    //
    // Removing that one class is exactly what MapLibre's own minimise path does, so this is its rest
    // state arriving at mount instead of after a gesture. The ⓘ stays, the credits are one click
    // behind it, and the licence surface is unchanged — which is why this, and not moving a required
    // credit into a panel that can be closed while the imagery it credits is still on the map.
    map
      .getContainer()
      .querySelector('.maplibregl-ctrl-attrib')
      ?.classList.remove('maplibregl-compact-show');
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
      // Frame the caller's bounds before anything reads the viewport, so the first query is scoped to
      // what the user will actually be looking at rather than to the pre-fit view.
      if (fitBounds && !lastViewRef.current)
        map.fitBounds(fitBounds, { padding: 24, animate: false });
      onLoadRef.current(map);
      setLoaded(true);
      syncViewport(); // first query, framed on the initial view
    });
    map.on('moveend', syncViewport);

    return () => {
      setLoaded(false);
      map.remove();
      mapRef.current = null;
      pmtilesUsers = Math.max(0, pmtilesUsers - 1);
      if (pmtilesUsers === 0) maplibregl.removeProtocol('pmtiles');
    };
    // `initialCenter` / `initialZoom` / `minZoom` are deliberately absent — see `initialViewRef`.
  }, [pmtilesUrl, worldPmtilesUrl, flavor, boundsKey, fitKey, navigationControl]);

  return { containerRef, mapRef, loaded };
}
