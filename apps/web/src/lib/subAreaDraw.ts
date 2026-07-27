/**
 * The sub-area draw control (N2) — terra-draw, **lazy-loaded and admin-only**.
 *
 * MapLibre ships no draw control. terra-draw (MIT, 1.32) is the plan of record over
 * `@mapbox/mapbox-gl-draw`, which needs a compat shim and drags Mapbox styling assumptions with it;
 * its MapLibre adapter peers on `maplibre-gl >= 4` and we're on 5.24.
 *
 * **Loaded on demand, from inside the admin route only.** A skater never draws anything — the
 * path-only doctrine means the app has no freehand authoring at all outside this one operator
 * surface — so shipping a draw engine in the main bundle would be paying for a capability the
 * overwhelming majority of sessions can't reach.
 *
 * The paste-GeoJSON escape hatch in the editor is not a nicety: it's the break-glass path if this
 * import ever fails, and the way an operator loads a shape traced somewhere else. Drawing is the
 * convenient way to make a polygon, not the only one.
 */

import type maplibregl from 'maplibre-gl';

/** The subset of terra-draw this app touches, so the dynamic import needs no `any` at call sites. */
export interface SubAreaDrawControl {
  /** Arm polygon drawing. Each finished ring is handed to the `onFinish` given at creation. */
  startDrawing: () => void;
  /** Disarm, leaving anything already drawn on screen. */
  stopDrawing: () => void;
  /** Drop every drawn shape. */
  clear: () => void;
  /** Tear down and detach from the map. */
  destroy: () => void;
}

/**
 * Attach a polygon draw control to a map.
 *
 * `onFinish` fires with the completed ring as a GeoJSON Polygon. The caller previews it (as the
 * editor's yellow draft layer) and decides whether to save — this control never writes anything, and
 * the server clips whatever does get saved to the parent regardless (Decision 10).
 */
export async function createSubAreaDraw(
  map: maplibregl.Map,
  onFinish: (polygon: GeoJSON.Polygon) => void,
): Promise<SubAreaDrawControl> {
  const [{ TerraDraw, TerraDrawPolygonMode }, { TerraDrawMapLibreGLAdapter }] = await Promise.all([
    import('terra-draw'),
    import('terra-draw-maplibre-gl-adapter'),
  ]);

  const draw = new TerraDraw({
    adapter: new TerraDrawMapLibreGLAdapter({ map }),
    modes: [new TerraDrawPolygonMode()],
  });
  draw.start();

  draw.on('finish', (id) => {
    const feature = draw.getSnapshotFeature(id);
    if (feature?.geometry?.type !== 'Polygon') return;
    onFinish(feature.geometry as GeoJSON.Polygon);
    // One bay per draw: disarm after each finished ring so a stray click doesn't start a second
    // shape the operator hasn't noticed and would then save by accident.
    draw.setMode('static');
  });

  return {
    startDrawing: () => draw.setMode('polygon'),
    stopDrawing: () => draw.setMode('static'),
    clear: () => draw.clear(),
    destroy: () => {
      draw.stop();
    },
  };
}

/**
 * Parse a pasted GeoJSON string into a Polygon/MultiPolygon, or say why it isn't one.
 *
 * The break-glass path (and the way a shape traced in QGIS gets in). Accepts a bare geometry, a
 * `Feature`, or a one-feature `FeatureCollection`, because all three are things people actually
 * paste — insisting on the exact right wrapper would be pedantry at the moment someone is working
 * around a broken draw control.
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
