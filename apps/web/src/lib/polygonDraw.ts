/**
 * The polygon draw control — terra-draw, **lazy-loaded**.
 *
 * MapLibre ships no draw control. terra-draw (MIT, 1.32) is the plan of record over
 * `@mapbox/mapbox-gl-draw`, which needs a compat shim and drags Mapbox styling assumptions with it;
 * its MapLibre adapter peers on `maplibre-gl >= 4` and we're on 5.24.
 *
 * **Two callers, deliberately one module** (N5b Decision 2). N2 built this for the admin sub-area
 * editor and its doc comment said "admin-only", which stopped being true when N5b gave skaters
 * freeform hazard polygons — the primitive D51 always described as the opt-in/advanced one. A second
 * wrapper around the same engine would be two places for a draw bug to live; sharing it also means
 * Vite emits **one** ~218 kB chunk for both routes rather than one each, since both dynamic imports
 * name the same specifier.
 *
 * **Still loaded on demand, and never in the main bundle.** A skater who never draws a polygon never
 * fetches it. That was the founder call at kickoff: the chunk is a real cost on a phone on lake ice,
 * and it is paid only by the person who asked for the tool. It is web-only regardless of who asks —
 * terra-draw's adapters all target `maplibre-gl`, the DOM library, and mobile's map is a native
 * module, so there is no version of this that ships to a phone at all.
 *
 * The paste-GeoJSON escape hatch stays **admin-only** and is not a nicety: it's the break-glass path
 * if this import ever fails, and the way an operator loads a shape traced somewhere else.
 */

import type maplibregl from 'maplibre-gl';

/** The subset of terra-draw this app touches, so the dynamic import needs no `any` at call sites. */
export interface PolygonDrawControl {
  /** Arm polygon drawing. Each finished ring is handed to `onFinish`. */
  startDrawing: () => void;
  /**
   * Switch to selection, so the drawn ring's vertices can be dragged, inserted at midpoints and
   * deleted. This is what D51 meant when it called freeform polygons the expensive primitive, and
   * the reason this engine is worth its chunk to the skater who armed it.
   */
  startEditing: () => void;
  /** Disarm, leaving anything already drawn on screen. */
  stopDrawing: () => void;
  /**
   * Replace the tracked ring with this one. What makes a snapped shore band editable: N5b Decision 3
   * says a band is an ordinary polygon draft the moment it's derived, and that is only true if the
   * vertex editor can be handed one it didn't draw.
   */
  setPolygon: (polygon: GeoJSON.Polygon | null) => void;
  /** Drop every drawn shape. */
  clear: () => void;
  /** Tear down and detach from the map. */
  destroy: () => void;
}

export interface PolygonDrawOptions {
  /** A ring was completed. Fires once per finished shape, not on every drag. */
  onFinish?: (polygon: GeoJSON.Polygon) => void;
  /**
   * The tracked ring changed — a finish, or a vertex dragged in edit mode. `null` when the last
   * shape was removed. Callers holding live draft state (the hazard form) read this; the sub-area
   * editor, which saves an explicit snapshot, uses `onFinish` alone.
   */
  onChange?: (polygon: GeoJSON.Polygon | null) => void;
  /**
   * Disarm after the first finished ring (the default). A stray click must not start a second shape
   * the author hasn't noticed and would then save by accident.
   */
  singleShape?: boolean;
}

/**
 * Attach a polygon draw control to a map.
 *
 * The polygon mode carries terra-draw's own `ValidateNotSelfIntersecting`, so a crossing ring can't
 * be *finished* on this path at all. That is a courtesy, not the guarantee: `isValidHazardShape`
 * refuses one on the server too, where a client's manners are not evidence.
 *
 * This control never writes anything. The hazard form previews what it emits and the skater decides
 * whether to post; the sub-area editor previews it as its yellow draft layer, and the server clips
 * whatever gets saved to the parent regardless (N2 Decision 10).
 */
export async function createPolygonDraw(
  map: maplibregl.Map,
  options: PolygonDrawOptions,
): Promise<PolygonDrawControl> {
  const [
    { TerraDraw, TerraDrawPolygonMode, TerraDrawSelectMode, ValidateNotSelfIntersecting },
    { TerraDrawMapLibreGLAdapter },
  ] = await Promise.all([import('terra-draw'), import('terra-draw-maplibre-gl-adapter')]);

  const draw = new TerraDraw({
    adapter: new TerraDrawMapLibreGLAdapter({ map }),
    modes: [
      new TerraDrawPolygonMode({ validation: ValidateNotSelfIntersecting }),
      new TerraDrawSelectMode({
        flags: {
          polygon: {
            feature: {
              // The shape does not move as a unit. Dragging a whole footprint off the spot it was
              // drawn on is the one edit that turns a hazard into a claim about somewhere nobody
              // stood — so vertices move and the polygon doesn't.
              draggable: false,
              selfIntersectable: false,
              coordinates: { draggable: true, midpoints: true, deletable: true },
            },
          },
        },
      }),
    ],
  });
  draw.start();

  /** The one ring this control tracks — everything here is single-shape by construction. */
  const currentPolygon = (): GeoJSON.Polygon | null => {
    for (const feature of draw.getSnapshot()) {
      if (feature.geometry?.type === 'Polygon') return feature.geometry as GeoJSON.Polygon;
    }
    return null;
  };

  draw.on('finish', (id) => {
    const feature = draw.getSnapshotFeature(id);
    if (feature?.geometry?.type !== 'Polygon') return;
    options.onFinish?.(feature.geometry as GeoJSON.Polygon);
    options.onChange?.(feature.geometry as GeoJSON.Polygon);
    if (options.singleShape !== false) draw.setMode('static');
  });

  // Dragging a vertex emits `change`, never `finish` — so a control listening only for finish would
  // render the drag and then store the shape as it was before it.
  draw.on('change', (_ids, type) => {
    if (type === 'create') return; // covered by `finish`; a mid-draw ring isn't a draft yet
    options.onChange?.(currentPolygon());
  });

  return {
    startDrawing: () => draw.setMode('polygon'),
    startEditing: () => draw.setMode('select'),
    stopDrawing: () => draw.setMode('static'),
    setPolygon: (polygon) => {
      draw.clear();
      if (!polygon) return;
      // `mode` is how terra-draw's store knows which mode owns a feature; without it the ring is
      // rendered but not selectable, which is the whole point of handing it over.
      draw.addFeatures([
        { type: 'Feature', geometry: polygon, properties: { mode: 'polygon' } },
      ] as Parameters<typeof draw.addFeatures>[0]);
    },
    clear: () => draw.clear(),
    destroy: () => {
      draw.stop();
    },
  };
}

/**
 * Parse a pasted GeoJSON string into a Polygon/MultiPolygon, or say why it isn't one.
 *
 * The **admin** break-glass path (and the way a shape traced in QGIS gets in) — a skater never sees
 * it. Accepts a bare geometry, a `Feature`, or a one-feature `FeatureCollection`, because all three
 * are things people actually paste — insisting on the exact right wrapper would be pedantry at the
 * moment someone is working around a broken draw control.
 */
export function parsePastedPolygon(
  text: string,
): { ok: true; polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "That isn't valid JSON." };
  }
  const geometry = unwrapGeometry(parsed);
  if (!geometry) return { ok: false, error: "Couldn't find a geometry in there." };
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
    return {
      ok: false,
      error: `A sub-area has to be a Polygon or MultiPolygon, not a ${geometry.type}.`,
    };
  }
  return { ok: true, polygon: geometry };
}

function unwrapGeometry(value: unknown): GeoJSON.Geometry | null {
  if (typeof value !== 'object' || value === null) return null;
  const node = value as { type?: string; geometry?: unknown; features?: unknown };
  if (node.type === 'FeatureCollection' && Array.isArray(node.features)) {
    return node.features.length === 1 ? unwrapGeometry(node.features[0]) : null;
  }
  if (node.type === 'Feature') return unwrapGeometry(node.geometry);
  return typeof node.type === 'string' ? (value as GeoJSON.Geometry) : null;
}
