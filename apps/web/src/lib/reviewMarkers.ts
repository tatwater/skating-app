import type { LatLng } from '@skating/core';
import type maplibregl from 'maplibre-gl';

/**
 * What a moderator is checking on a map (D202): the spot a skater marked, and — when there is one —
 * what it may duplicate, a landmark or another proposal by the same name somewhere else. Shared by
 * the lake editor's canvas and the request queue's preview, so both draw a review the same way.
 */
export interface ReviewPoints {
  ask: LatLng;
  /** What the ask may duplicate, with the name it is shown by. */
  other?: { point: LatLng; kind: 'landmark' | 'proposal'; name: string };
  /** The ask's own label. */
  name?: string;
}

export const REVIEW_SOURCE_ID = 'review-points';

/**
 * Pink, because nothing else on either canvas is: the draft is yellow, parking amber, put-ins cyan
 * and slate, sample points purple. The ask is solid, what it may duplicate is a hollow ring of the
 * same color, and a dashed line joins them — one question, drawn as one thing.
 */
export const REVIEW_COLOR = '#ec4899';

/** The review as features: the ask, the other, and the line between them. Empty with no review. */
export function reviewFeatures(review: ReviewPoints | null): GeoJSON.FeatureCollection {
  if (!review) return { type: 'FeatureCollection', features: [] };
  const ask: GeoJSON.Feature = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [review.ask.lng, review.ask.lat] },
    properties: { role: 'ask', label: review.name ?? '' },
  };
  if (!review.other) return { type: 'FeatureCollection', features: [ask] };
  const { point, kind, name } = review.other;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [review.ask.lng, review.ask.lat],
            [point.lng, point.lat],
          ],
        },
        properties: { role: 'link' },
      },
      ask,
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
        properties: {
          role: 'other',
          label: kind === 'landmark' ? `${name} (landmark)` : `${name} (proposal)`,
        },
      },
    ],
  };
}

/** Add the review's source and layers — once, in a canvas's `onLoad`. */
export function addReviewLayers(map: maplibregl.Map, haloColor: string): void {
  map.addSource(REVIEW_SOURCE_ID, { type: 'geojson', data: reviewFeatures(null) });
  map.addLayer({
    id: 'review-link',
    type: 'line',
    source: REVIEW_SOURCE_ID,
    filter: ['==', ['get', 'role'], 'link'],
    paint: { 'line-color': REVIEW_COLOR, 'line-width': 2, 'line-dasharray': [2, 2] },
  });
  map.addLayer({
    id: 'review-points',
    type: 'circle',
    source: REVIEW_SOURCE_ID,
    filter: ['!=', ['get', 'role'], 'link'],
    paint: {
      'circle-radius': 8,
      'circle-color': ['case', ['==', ['get', 'role'], 'ask'], REVIEW_COLOR, 'rgba(0,0,0,0)'],
      'circle-stroke-color': ['case', ['==', ['get', 'role'], 'ask'], haloColor, REVIEW_COLOR],
      'circle-stroke-width': 3,
    },
  });
  map.addLayer({
    id: 'review-labels',
    type: 'symbol',
    source: REVIEW_SOURCE_ID,
    filter: ['!=', ['get', 'role'], 'link'],
    layout: {
      'text-field': ['get', 'label'],
      'text-size': 12,
      // Named, not left to MapLibre's default stack — the Protomaps glyph host serves only its own
      // faces, and a default-font label 404s per glyph range and never draws.
      'text-font': ['Noto Sans Regular'],
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'text-allow-overlap': true,
    },
    paint: { 'text-color': REVIEW_COLOR, 'text-halo-color': haloColor, 'text-halo-width': 1.5 },
  });
}

/** Draw a review and bring it into view: both ends framed, or the lone ask at a zoom that shows it. */
export function showReview(
  map: maplibregl.Map,
  review: ReviewPoints | null,
  options: { zoom?: number; animate?: boolean } = {},
): void {
  const source = map.getSource(REVIEW_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  source?.setData(reviewFeatures(review));
  if (!review) return;
  const animate = options.animate ?? true;
  if (!review.other) {
    map.flyTo({ center: [review.ask.lng, review.ask.lat], zoom: options.zoom ?? 14, animate });
    return;
  }
  const { ask, other } = review;
  map.fitBounds(
    [
      [Math.min(ask.lng, other.point.lng), Math.min(ask.lat, other.point.lat)],
      [Math.max(ask.lng, other.point.lng), Math.max(ask.lat, other.point.lat)],
    ],
    { padding: 60, maxZoom: options.zoom ?? 14, animate },
  );
}
