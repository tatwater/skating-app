import { haversineMeters } from '@skating/core';
import type { BBoxLike } from '@/lib/mapSurface';
import type { LngLat } from '../../body/map/mapDescriptors';

/**
 * The geometry an Inbox embed frames itself on — pure, so the rules are tested without a map:
 *
 * - **The frame is the item's subject**: the box around everything the item is about (a body's
 *   outline, the asked point, a candidate, a skate, a distance rule's two ends). The console map's
 *   camera frames it and fences the operator to it (`useBodyMapCanvas`: one box-size of slack on
 *   each side, a step and a half out from the framing).
 * - **Never smaller than {@link MIN_SPAN_M} a side**: a lone point (an admit with no catalog match,
 *   a report off a body we don't hold) would otherwise frame at the street's zoom with nothing to
 *   read it against. The box grows about its own center.
 */

/** The least a frame spans, north–south and east–west, in meters: a small pond and its shore. */
export const MIN_SPAN_M = 400;

/** Meters per degree of latitude (the mean meridian degree). */
const M_PER_DEG_LAT = 111_320;

/** Meters per degree of longitude at a latitude. */
function mPerDegLng(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Every position of a polygon or multipolygon, rings and holes alike. */
export function outlineCoords(g: GeoJSON.Polygon | GeoJSON.MultiPolygon): LngLat[] {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.flatMap((poly) => poly.flatMap((ring) => ring.map((c) => toLngLat(c))));
}

function toLngLat(c: GeoJSON.Position): LngLat {
  return [c[0] ?? 0, c[1] ?? 0];
}

/** The box around some points; `null` for none. */
export function boxOf(coords: readonly LngLat[]): BBoxLike | null {
  if (coords.length === 0) return null;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLng, minLat, maxLng, maxLat };
}

/**
 * The frame around `coords`: their box, grown about its center to at least `minSpan` meters on
 * each axis (east–west measured at the box's widest latitude, so it is never narrower than asked).
 */
export function frameBox(
  coords: readonly [LngLat, ...LngLat[]],
  minSpan: number = MIN_SPAN_M,
): BBoxLike {
  const box = boxOf(coords) as BBoxLike;
  const worstLat = Math.min(89, Math.max(Math.abs(box.minLat), Math.abs(box.maxLat)));
  const needLat = minSpan / M_PER_DEG_LAT;
  const needLng = minSpan / mPerDegLng(worstLat);
  const padLat = Math.max(0, needLat - (box.maxLat - box.minLat)) / 2;
  const padLng = Math.max(0, needLng - (box.maxLng - box.minLng)) / 2;
  return {
    minLng: box.minLng - padLng,
    maxLng: box.maxLng + padLng,
    minLat: box.minLat - padLat,
    maxLat: box.maxLat + padLat,
  };
}

/**
 * A box grown by `factor` of its own size on each side, about its center — for a subject of a few
 * points (2.4's asked point and its lookalike), framed with the room the board gives them: at
 * `factor` 1 they span the middle third.
 */
export function growBox(box: BBoxLike, factor: number): BBoxLike {
  const dx = (box.maxLng - box.minLng) * factor;
  const dy = (box.maxLat - box.minLat) * factor;
  return {
    minLng: box.minLng - dx,
    maxLng: box.maxLng + dx,
    minLat: box.minLat - dy,
    maxLat: box.maxLat + dy,
  };
}

/** Great-circle meters between two points. */
export function metersBetween(a: LngLat, b: LngLat): number {
  return haversineMeters({ lng: a[0], lat: a[1] }, { lng: b[0], lat: b[1] });
}

/**
 * The nearest pair of vertices between two outlines — where a distance rule between them runs. A
 * vertex pair, not the true nearest points of two edges: the rule ends on each shore's drawn
 * corners, and the measure it carries is that pair's distance (never shorter than the true gap).
 * Compared on a local flat projection (cheap; within a part in ten thousand of the sphere at a
 * body's scale); measured great-circle.
 */
export function nearestVertices(
  a: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  b: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): [LngLat, LngLat] | null {
  const pa = outlineCoords(a);
  const pb = outlineCoords(b);
  if (pa.length === 0 || pb.length === 0) return null;
  // Each vertex's parallel scale, once: a pair is compared at the mean of its two (no trig inside
  // the loop), which keeps the flat comparison true to the sphere at high latitudes too.
  const ka = pa.map((p) => Math.cos((p[1] * Math.PI) / 180));
  const kb = pb.map((q) => Math.cos((q[1] * Math.PI) / 180));
  let best = Infinity;
  let pair: [LngLat, LngLat] = [pa[0] as LngLat, pb[0] as LngLat];
  for (let i = 0; i < pa.length; i++) {
    const p = pa[i] as LngLat;
    for (let j = 0; j < pb.length; j++) {
      const q = pb[j] as LngLat;
      const dx = (p[0] - q[0]) * (((ka[i] as number) + (kb[j] as number)) / 2);
      const dy = p[1] - q[1];
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        pair = [p, q];
      }
    }
  }
  return pair;
}

/** The point halfway along a straight rule (a measure label's place). */
export function midpoint(a: LngLat, b: LngLat): LngLat {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}
