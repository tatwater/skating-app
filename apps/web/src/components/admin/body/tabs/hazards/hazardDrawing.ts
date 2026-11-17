import { type HazardShape, hazardFootprint } from '@skating/core';

import type { LngLat } from '../../map/mapDescriptors';

/**
 * **Whether, and how, a hazard or a known feature can be drawn on the Body console's map** — the one
 * rule the map, the list rows and the feature glyphs all ask, so the list never says one thing about
 * a report and the map another.
 *
 * - **`footprint`** — its stored clip, or its shape grown by its radius or band: drawn as its dot
 *   field (a crossing as its own mark, at `at`).
 * - **`pin`** — the footprint can't be drawn, but the stored geometry still holds a usable point:
 *   its own point, or the middle of its coordinates. The founder's call (2026-11-17): at least a pin
 *   at about where it is, said as *shape unknown*. **A pin is never a lesser hazard** (D3): it takes
 *   the same fade a footprint would, and nothing about the missing shape makes it lighter.
 * - **`nowhere`** — the stored geometry holds no usable coordinate anywhere in it. The list row still
 *   stands and says so; what the map should draw for it has not been designed.
 *
 * Every coordinate this hands back is finite and on the globe, so nothing is drawn at a NaN.
 */

/** A row with a stored shape: a hazard (`hazards.listForBody`) or a known feature. */
export type Shaped = Pick<HazardShape, 'geometryKind' | 'radiusMeters' | 'bufferMeters'> & {
  _id: string;
  geometry: unknown;
  clippedFootprint?: unknown;
};

export type Area = GeoJSON.Polygon | GeoJSON.MultiPolygon;

export type HazardDrawing =
  | { kind: 'footprint'; area: Area; at: LngLat }
  | { kind: 'pin'; at: LngLat }
  | { kind: 'nowhere' };

/** The geometry types the footprint math can grow. */
const GROWABLE = new Set(['Point', 'LineString', 'Polygon', 'MultiPolygon']);

/** A position the map can place: two finite numbers, a longitude and a latitude on the globe. */
export function isPlaceable(p: unknown): p is readonly [number, number, ...number[]] {
  if (!Array.isArray(p)) return false;
  const [lng, lat] = p as unknown[];
  return (
    typeof lng === 'number' &&
    typeof lat === 'number' &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    Math.abs(lng) <= 180 &&
    Math.abs(lat) <= 90
  );
}

const asRings = (v: unknown): unknown[][] =>
  Array.isArray(v) ? (v.filter(Array.isArray) as unknown[][]) : [];

/** An area the map can draw: at least one outer ring of four positions, every position placeable. */
function usableArea(g: unknown): Area | null {
  const a = g as { type?: unknown; coordinates?: unknown } | null | undefined;
  if (a?.type !== 'Polygon' && a?.type !== 'MultiPolygon') return null;
  const polygons = a.type === 'Polygon' ? [a.coordinates] : asRings(a.coordinates);
  if (polygons.length === 0) return null;
  for (const poly of polygons) {
    const rings = asRings(poly);
    if (rings.length === 0 || (rings[0]?.length ?? 0) < 4) return null;
    for (const ring of rings) if (!ring.every(isPlaceable)) return null;
  }
  return a as Area;
}

/** The shape grown, when it can be; a shape that throws or grows to nothing placeable is `null`. */
function grown(s: Shaped): Area | null {
  const g = s.geometry as { type?: unknown } | null | undefined;
  if (typeof g?.type !== 'string' || !GROWABLE.has(g.type)) return null;
  try {
    return usableArea(
      hazardFootprint({
        geometryKind: s.geometryKind,
        geometry: s.geometry as HazardShape['geometry'],
        ...(s.radiusMeters !== undefined ? { radiusMeters: s.radiusMeters } : {}),
        ...(s.bufferMeters !== undefined ? { bufferMeters: s.bufferMeters } : {}),
      }),
    );
  } catch {
    return null;
  }
}

/** A closed ring's distinct positions: its repeated closing vertex would pull a middle toward it. */
function open(ring: readonly unknown[]): unknown[] {
  const first = ring[0] as number[] | undefined;
  const last = ring[ring.length - 1] as number[] | undefined;
  return ring.length > 1 && first?.[0] === last?.[0] && first?.[1] === last?.[1]
    ? ring.slice(0, -1)
    : [...ring];
}

/** The positions a geometry's place is read from: a line's vertices, each polygon's outer ring. */
function positionsOf(g: unknown): unknown[] {
  const x = g as { type?: unknown; coordinates?: unknown } | null | undefined;
  switch (x?.type) {
    case 'Point':
      return [x.coordinates];
    case 'LineString':
    case 'MultiPoint':
      return asRings(x.coordinates);
    case 'Polygon':
      return open(asRings(x.coordinates)[0] ?? []);
    case 'MultiPolygon':
      return asRings(x.coordinates).flatMap((poly) => open(asRings(poly)[0] ?? []));
    default:
      return [];
  }
}

/** Every position anywhere in a geometry's coordinates, a hole's included. */
function everyPosition(g: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (v: unknown) => {
    if (isPlaceable(v)) out.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x);
  };
  walk((g as { coordinates?: unknown } | null | undefined)?.coordinates);
  return out;
}

/** The middle of the placeable positions, or `null` when none is. */
function middle(positions: readonly unknown[]): LngLat | null {
  const placed = positions.filter(isPlaceable);
  if (placed.length === 0) return null;
  const n = placed.length;
  return [placed.reduce((t, p) => t + p[0], 0) / n, placed.reduce((t, p) => t + p[1], 0) / n];
}

/** A stored Point's own position, when it is placeable. */
function ownPoint(g: unknown): LngLat | null {
  const x = g as { type?: unknown; coordinates?: unknown } | null | undefined;
  return x?.type === 'Point' && isPlaceable(x.coordinates)
    ? [x.coordinates[0], x.coordinates[1]]
    : null;
}

/** The one rule: how a row with a stored shape is drawn on the console's map. */
export function drawingOf(s: Shaped): HazardDrawing {
  const area = usableArea(s.clippedFootprint) ?? grown(s);
  if (area !== null) {
    // Where a crossing's mark goes: its point, or the middle of its footprint's outer ring.
    const outer = area.type === 'Polygon' ? area.coordinates[0] : area.coordinates[0]?.[0];
    // A usable area's first outer ring holds four placeable positions, so `at` is never absent.
    const at = ownPoint(s.geometry) ?? (middle(open(outer ?? [])) as LngLat);
    return { kind: 'footprint', area, at };
  }
  // Any usable point keeps it on the map: its outer rings' middle first, else any position it holds.
  const at =
    ownPoint(s.geometry) ?? middle(positionsOf(s.geometry)) ?? middle(everyPosition(s.geometry));
  return at === null ? { kind: 'nowhere' } : { kind: 'pin', at };
}
