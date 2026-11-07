import { haversineMeters, type LngLat, type Projection } from '@skating/core';

/** What the projection reads of a MapLibre map — enough to fake in a test. */
export interface ProjectingMap {
  project(lngLat: [number, number]): { x: number; y: number };
  unproject(point: [number, number]): { lng: number; lat: number };
  getContainer(): HTMLElement;
  getCenter(): { lng: number; lat: number };
}

/**
 * The instrument map as core's `Projection` (B03 §5): screen pixels for a coordinate and back, the
 * frame's size, and its scale at the center — so the silhouette helpers that drew the old SVG lake
 * (the compass ring, the sector wash, the outline) draw over the real map in the same terms.
 * A snapshot of the camera: build it again when the map moves.
 */
export function mapProjection(map: ProjectingMap): Projection {
  const container = map.getContainer();
  const center = map.getCenter();
  const a = map.project([center.lng, center.lat]);
  const east = map.unproject([a.x + 100, a.y]);
  const meters = haversineMeters(
    { lat: center.lat, lng: center.lng },
    { lat: east.lat, lng: east.lng },
  );
  return {
    width: container.clientWidth,
    height: container.clientHeight,
    toXY: ([lng, lat]: LngLat) => {
      const p = map.project([lng, lat]);
      return [p.x, p.y];
    },
    fromXY: ([x, y]) => {
      const c = map.unproject([x, y]);
      return [c.lng, c.lat];
    },
    pxPerMeter: meters > 0 ? 100 / meters : 0,
  };
}
