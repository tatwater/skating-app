/**
 * The walk from the car to the ice, drawn (N6e Workstream 0).
 *
 * N6d gave a skater a distance, a climb and a Hike-In chip — *"park here, then about 1.1 km on foot,
 * 90 m of climb"* — and no way to see **where** that kilometre goes. On a lake with two launches on
 * opposite shores, the sentence does not say which one the trail reaches, and a hike-in pond's whole
 * problem is that the way in is not obvious from the map.
 *
 * Shared by both clients for the same reason `hazardLayer` and `contourLayer` are: *what gets drawn*
 * is decided once and only the colours are per-app.
 *
 * ## The one rule this layer has
 *
 * **A line is drawn only where somebody routed one.** `putIns.approachPath` is written only for a
 * routed hike-in leg, and this module refuses anything else rather than synthesising a segment from
 * the lot to the launch. A crow-flies line looks exactly like a walked one at every zoom, so drawing
 * the fallback would turn *"at least 900 m on foot"* — an honest floor — into a route through
 * whatever happens to lie between two points. The distance carries its own hedge; a line cannot.
 *
 * That is the same distinction the drawer's copy already makes, moved onto the map, and it is why
 * this file has no `straightLineFallback` anything.
 */

import type { LatLng } from './geometry';

/** The MapLibre source and layer ids, so both clients name them the same thing. */
export const APPROACH_SOURCE_ID = 'approach-paths';
export const APPROACH_LAYER_ID = 'approach-path-line';

// Where the line sits: above the lake and its contours, **below every pin** — the line is context
// for the markers at its two ends, and a route drawn over the put-in it leads to would hide the
// thing it is explaining.
//
// There is deliberately no `beforeLayerId` constant for that. Both clients add this layer *before*
// the put-in markers exist, so an anchor naming a layer that is not there yet would be a no-op
// dressed as a rule; web gets the order from `addLayer` sequence and mobile from JSX order.

/**
 * A launch with a walk worth drawing.
 *
 * Deliberately a **subset of the put-in marker both clients already hold**, so neither has to issue a
 * query to draw this: the rows behind `putIns.listForBody` carry the approach, and the map is already
 * reading them for the pins at the line's two ends. A second query for a few dozen coordinates the
 * client has in hand would be a read to save a read.
 *
 * `id` is optional because a derived cluster is not a stored row and has no id — it also never has a
 * path, so it never reaches a feature.
 */
export interface MappableApproach {
  id?: string;
  /** Only ever set by the ETL on a routed hike-in leg — see the module note. */
  approachPath?: readonly LatLng[];
  approachMeters?: number;
  approachAscentM?: number;
  name?: string;
}

/**
 * Approaches → a `FeatureCollection` of lines for the `approach-paths` source.
 *
 * Every launch without a stored path is skipped in silence, which is the ordinary case: 3,588
 * put-ins carry an approach and only the hike-in ones carry its geometry. A path of fewer than two
 * points is dropped too — MapLibre renders a one-point LineString as nothing, so this is a guard
 * against a silent blank rather than against a crash.
 */
export function approachesToFeatureCollection(
  approaches: readonly MappableApproach[],
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const [index, approach] of approaches.entries()) {
    const path = approach.approachPath;
    if (!path || path.length < 2) continue;
    features.push({
      type: 'Feature',
      id: approach.id ?? index,
      geometry: {
        type: 'LineString',
        coordinates: path.map((p) => [p.lng, p.lat]),
      },
      properties: {
        ...(approach.id ? { putInId: approach.id } : {}),
        ...(approach.name ? { name: approach.name } : {}),
        ...(approach.approachMeters === undefined ? {} : { meters: approach.approachMeters }),
        ...(approach.approachAscentM === undefined ? {} : { ascentM: approach.approachAscentM }),
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * The line's paint, dashed.
 *
 * Dashed rather than solid, and this is the layer's second honesty rule. A solid line on a map reads
 * as infrastructure — a road, a boundary, something surveyed. This is an ORS route over OSM's trail
 * data: it is *a* walking route between two points, accurate to the network's own quality, and a
 * dash is how every map in the world says "path, approximately". It also keeps the line from
 * competing with the hazard and track lines, which are the layers a skater must not misread.
 */
export function approachLinePaint(color: string): {
  'line-color': string;
  'line-width': unknown[];
  'line-dasharray': number[];
  'line-opacity': number;
} {
  return {
    'line-color': color,
    // Thin at the zooms where the lake is a shape and thicker once the trail is the subject.
    'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.5, 14, 2.5, 16, 3.5],
    'line-dasharray': [2, 2],
    'line-opacity': 0.9,
  };
}
