import { distanceToPolygonMeters, snapToEdge } from '@skating/core';
import type * as maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { type ChordDrawControl, type ChordMap, createChordDraw } from '@/lib/chordDraw';
import { createPointDraw } from '@/lib/pointDraw';
import {
  createLineDraw,
  createPolygonDraw,
  type LineDrawControl,
  type PolygonDrawControl,
} from '@/lib/polygonDraw';
import type { MapToolClaim } from '../frame/mapTool';
import type { BodyMapPalette } from './bodyMapPalette';

/**
 * The map's half of the tool contract (`frame/mapTool`): the claimed engine attached to the live
 * map, the claim's draft drawn under it, and the camera taken to the claim's focus when a session
 * starts.
 *
 * - **Attached per session and per map.** The engine is built when the claim's `session` (or kind)
 *   changes, and again when the map is re-created (a theme switch): a control kept across that would
 *   drive a removed map. Its teardown never throws for a map that is already gone.
 * - **The callbacks go through a ref**, so the claim's fresh closures each render reach the engine
 *   without re-attaching it.
 * - **The ring engine is lazy** (terra-draw's chunk): a session that ends before it loads never
 *   attaches it; a chunk that fails says so through the claim's `onUnavailable`.
 * - Every write gates on `liveMap()`, as the rest of the console map's do.
 */

export const DRAFT_SOURCE = 'body-console-tool-draft';
const DRAFT_FILL = 'body-console-tool-draft-fill';
const DRAFT_LINE = 'body-console-tool-draft-line';
const DRAFT_POINTS = 'body-console-tool-draft-points';
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

function draftData(draft: MapToolClaim['draft']): GeoJSON.FeatureCollection {
  return draft
    ? {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: draft, properties: {} }],
      }
    : EMPTY;
}

export function useMapToolEngine(
  liveMap: () => maplibregl.Map | null,
  claim: MapToolClaim | null,
  palette: BodyMapPalette,
): void {
  const claimRef = useRef(claim);
  claimRef.current = claim;
  const session = claim?.session ?? null;
  const kind = claim?.engine.kind ?? null;

  // The draft: its own source and two layers, added on first need, painted in the lit ink.
  const draft = claim?.draft ?? null;
  // Added as soon as a tool is held, so the engine's own marks (added after) draw over the draft.
  const held = claim !== null;
  useEffect(() => {
    const map = liveMap();
    if (!map) return;
    const source = map.getSource(DRAFT_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (source) {
      source.setData(draftData(draft));
      return;
    }
    if (!held) return;
    map.addSource(DRAFT_SOURCE, { type: 'geojson', data: draftData(draft) });
    map.addLayer({
      id: DRAFT_FILL,
      type: 'fill',
      source: DRAFT_SOURCE,
      paint: { 'fill-color': palette.lit.fill ?? palette.lit.line, 'fill-opacity': 0.35 },
    });
    map.addLayer({
      id: DRAFT_LINE,
      type: 'line',
      source: DRAFT_SOURCE,
      paint: { 'line-color': palette.lit.line, 'line-width': palette.lit.width },
    });
    // Points (a suggested grid) as hollow rings: proposed, not placed.
    map.addLayer({
      id: DRAFT_POINTS,
      type: 'circle',
      source: DRAFT_SOURCE,
      filter: ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]],
      paint: {
        'circle-radius': 5,
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': palette.lit.line,
        'circle-stroke-width': 2,
      },
    });
  }, [draft, held, liveMap, palette]);

  // The camera, once per session: to the point asked about, or framing the thing being redrawn. Once
  // — a map re-created mid-session (a theme switch) keeps the operator's own view, as the console's
  // map does; a session that started while the map was down is framed when it comes up.
  const focused = useRef<string | null>(null);
  useEffect(() => {
    const map = liveMap();
    if (!map || session === null || focused.current === session) return;
    focused.current = session;
    const focus = claimRef.current?.focus;
    if (!focus) return;
    if ('point' in focus) {
      map.flyTo({ center: [focus.point.lng, focus.point.lat], zoom: Math.max(map.getZoom(), 13) });
    } else {
      const b = focus.bbox;
      map.fitBounds(
        [
          [b.minLng, b.minLat],
          [b.maxLng, b.maxLat],
        ],
        { padding: 80, maxZoom: 15 },
      );
    }
  }, [session, liveMap]);

  // The engine, per session and per map.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attached only when the session, its kind or the map moves.
  useEffect(() => {
    const map = liveMap();
    const current = claimRef.current;
    if (!map || current === null) return;
    const engine = current.engine;
    if (engine.kind === 'chord') {
      // The tool drives the slice of the map it declares; MapLibre's `on` overloads are wider than
      // that slice, which is the only reason for the cast.
      const control: ChordDrawControl = createChordDraw(map as unknown as ChordMap, {
        parent: engine.parent,
        onChange: (state, mouth, preview) => {
          const live = claimRef.current?.engine;
          if (live?.kind === 'chord') live.onChange(state, mouth, preview);
        },
      });
      if (engine.mouth) control.load(engine.mouth);
      else control.start();
      return () => {
        try {
          control.destroy();
        } catch {
          // The map went first (a re-create, or the route's unmount order): nothing to detach.
        }
      };
    }
    if (engine.kind === 'ring') {
      let gone = false;
      let control: PolygonDrawControl | null = null;
      // A traced ring goes to the vertex editor as it closes, and the editor stays armed through
      // every drag: the engine's single-shape default would go static on each `finish` — the ring's
      // close, and every vertex drag after it — leaving a ring the mode bar says can be adjusted
      // frozen after one move.
      let tracing = engine.polygon === undefined;
      createPolygonDraw(map, {
        singleShape: false,
        onFinish: () => {
          if (gone || !tracing) return;
          tracing = false;
          control?.startEditing();
        },
        onChange: (polygon) => {
          const live = claimRef.current?.engine;
          if (!gone && live?.kind === 'ring') live.onChange(polygon);
        },
      }).then(
        (built) => {
          if (gone) {
            built.destroy();
            return;
          }
          control = built;
          // A click traces (D313): the crosshair, never MapLibre's grab hand.
          map.getCanvas().style.cursor = 'crosshair';
          if (engine.polygon) {
            built.setPolygon(engine.polygon);
            built.startEditing();
          } else built.startDrawing();
        },
        () => {
          const live = claimRef.current?.engine;
          if (!gone && live?.kind === 'ring') live.onUnavailable();
        },
      );
      return () => {
        gone = true;
        try {
          control?.clear();
          control?.destroy();
          map.getCanvas().style.cursor = '';
        } catch {
          // As above: the map may already be gone.
        }
      };
    }
    if (engine.kind === 'point') {
      const parent = engine.snapTo;
      const control = createPointDraw(map as unknown as ChordMap, {
        ...(engine.point ? { point: engine.point } : {}),
        ...(parent
          ? {
              snap: (p) =>
                engine.snapWithinM !== undefined &&
                distanceToPolygonMeters(p, parent as never) > engine.snapWithinM
                  ? p
                  : snapToEdge(p, parent as never),
            }
          : {}),
        color: palette.lit.line,
        onPick: (p, scale) => {
          const live = claimRef.current?.engine;
          if (live?.kind === 'point') live.onPick(p, scale);
        },
      });
      return () => {
        try {
          control.destroy();
        } catch {
          // As above: the map may already be gone.
        }
      };
    }
    if (engine.kind === 'line') {
      let gone = false;
      let control: LineDrawControl | null = null;
      // As the ring's: a traced line goes to the vertex editor once, as it ends.
      let tracing = engine.line === undefined;
      createLineDraw(map, {
        onFinish: () => {
          if (gone || !tracing) return;
          tracing = false;
          control?.startEditing();
        },
        onChange: (line) => {
          const live = claimRef.current?.engine;
          if (!gone && live?.kind === 'line') live.onChange(line);
        },
      }).then(
        (built) => {
          if (gone) {
            built.destroy();
            return;
          }
          control = built;
          map.getCanvas().style.cursor = 'crosshair';
          if (engine.line) {
            built.setLine(engine.line);
            built.startEditing();
          } else built.startDrawing();
        },
        () => {
          const live = claimRef.current?.engine;
          if (!gone && live?.kind === 'line') live.onUnavailable();
        },
      );
      return () => {
        gone = true;
        try {
          control?.clear();
          control?.destroy();
          map.getCanvas().style.cursor = '';
        } catch {
          // As above: the map may already be gone.
        }
      };
    }
    return undefined;
  }, [session, kind, liveMap]);
}
