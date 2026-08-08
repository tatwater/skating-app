/**
 * **Two outlines, one frame** — the SVG behind the dedup merge card.
 *
 * The question a moderator is actually answering ("are these the same water?") is a *shape*
 * question, and until now the only way to see a shape was to open each body's editor in turn, on a
 * full MapLibre canvas, and hold the first one in your head while the second loaded. That is the
 * worst possible way to compare two outlines: never side by side, never at the same scale, and
 * never overlaid.
 *
 * So this projects every outline in a group into **one shared frame** and hands back plain SVG path
 * data. Overlaid rather than side by side, because near-coincident is the whole hypothesis: two
 * outlines that are one lake vanish into a single edge, and two that are not show two shapes with a
 * gap. That difference is legible at 200 px in a fraction of a second, which is what makes it worth
 * doing without a basemap at all.
 *
 * **No basemap, no tiles, no map library.** A queue page renders dozens of these; a MapLibre
 * instance per card would be tens of megabytes of tiles to answer a question the geometry answers on
 * its own. The card still links to each body's real editor for anything the outline can't settle.
 */

export interface PreviewShape {
  key: string;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

export interface PreviewPath {
  key: string;
  /** SVG path data in the returned viewBox's coordinate space. */
  d: string;
}

export interface ShapePreview {
  paths: PreviewPath[];
  width: number;
  height: number;
}

const DEG = Math.PI / 180;

function rings(geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon): GeoJSON.Position[][] {
  return geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
}

/**
 * Project every shape into a shared box, preserving aspect.
 *
 * Equirectangular with an `x` scale of `cos(midLat)`: at the size of a lake this is
 * indistinguishable from anything more careful, and the property that matters is that **both shapes
 * get exactly the same transform** — a comparison drawn under two projections would show a
 * difference that isn't there.
 *
 * Latitude is flipped, since SVG's `y` grows downward and north does not.
 */
export function buildShapePreview(
  shapes: readonly PreviewShape[],
  {
    width = 320,
    height = 200,
    padding = 6,
  }: { width?: number; height?: number; padding?: number } = {},
): ShapePreview {
  const all = shapes.flatMap((s) => rings(s.geometry).flat());
  const empty = { paths: shapes.map((s) => ({ key: s.key, d: '' })), width, height };
  if (all.length === 0) return empty;

  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const [lng, lat] of all) {
    if (lng === undefined || lat === undefined) continue;
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) return empty;

  const cos = Math.max(0.01, Math.cos(((minLat + maxLat) / 2) * DEG));
  const spanX = Math.max((maxLng - minLng) * cos, 1e-9);
  const spanY = Math.max(maxLat - minLat, 1e-9);
  // One scale for both axes — a stretched-to-fit outline is a different shape, which is precisely
  // the thing being judged.
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;

  const project = ([lng, lat]: GeoJSON.Position): [number, number] => [
    offsetX + ((lng ?? 0) - minLng) * cos * scale,
    // Flip: SVG y grows downward, latitude grows north.
    offsetY + (maxLat - (lat ?? 0)) * scale,
  ];

  return {
    width,
    height,
    paths: shapes.map((shape) => ({
      key: shape.key,
      d: rings(shape.geometry)
        .map((ring) => {
          if (ring.length === 0) return '';
          const points = ring.map(project).map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`);
          return `M${points.join('L')}Z`;
        })
        .filter(Boolean)
        .join(' '),
    })),
  };
}
