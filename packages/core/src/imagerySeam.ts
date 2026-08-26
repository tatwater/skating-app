/**
 * Where two frames of one lake actually meet (N6e §C4).
 *
 * > **Founder, 2026-08-24:** *"we should provide a hairline border between the two images, with their
 * > respective dates on either side."*
 *
 * ## The line is the primary footprint's edge, and only the part inside the lake
 *
 * Two frames abut along a granule boundary. The visible join is therefore the boundary of whichever
 * one is drawn on top — the *primary* — restricted to the water, because that boundary also runs for
 * a hundred kilometres across land nobody is looking at.
 *
 * **Not the whole intersection outline.** Intersecting the footprint with the lake gives a polygon
 * whose boundary is part granule edge and part *shoreline*, and drawing all of it would trace the
 * shore a second time in a color that means something else. The shoreline is already drawn, and
 * §A3 makes it matter more once imagery is on. So the seam is specifically the piece that is **not**
 * shoreline.
 *
 * ## How, given what a footprint is
 *
 * A granule footprint is a quadrilateral — four segments, no curvature worth modelling. So each
 * segment is walked at a fixed ground spacing, each sample tested against the lake, and contiguous
 * in-water runs become lines. That needs only `pointInPolygon`, which is exact for this purpose,
 * rather than a line/polygon clipper the package does not carry.
 *
 * ⚠ **The sampling is what bounds the accuracy, and it is deliberately fine.** At 25 m the line
 * tracks a shoreline crossing to within about half a Sentinel pixel, which is under the width of the
 * hairline drawn on top of it. Coarser sampling would show as the seam starting slightly inside the
 * water or slightly on the bank — a small error that reads as a bug because a straight line beside a
 * shoreline is exactly where the eye checks alignment.
 */

import type { LineString, MultiLineString, MultiPolygon, Polygon, Position } from 'geojson';
import { type BBox, haversineMeters, type LatLng, pointInPolygon, polygonBBox } from './geometry';

/** Ground spacing between samples along a footprint edge. See the module note on why this is fine. */
export const SEAM_SAMPLE_METERS = 25;

/** Every ring of a polygon or multipolygon, outer and inner alike. */
function ringsOf(geom: Polygon | MultiPolygon): Position[][] {
  return geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.flat();
}

function inBox(lng: number, lat: number, box: BBox): boolean {
  return lat >= box.minLat && lat <= box.maxLat && lng >= box.minLng && lng <= box.maxLng;
}

/**
 * The hairline between a frame and its companion, or `null` if they do not visibly meet.
 *
 * `null` is the common and correct answer: most frames cover a lake outright, and a footprint whose
 * edge never crosses the water has no seam to draw. A caller should render nothing rather than
 * falling back to something.
 */
export function seamLineFor(
  footprint: Polygon | MultiPolygon,
  body: Polygon | MultiPolygon,
  options: { sampleMeters?: number } = {},
): MultiLineString | null {
  const spacing = options.sampleMeters ?? SEAM_SAMPLE_METERS;
  const box = polygonBBox(body);
  const lines: Position[][] = [];

  for (const ring of ringsOf(footprint)) {
    // A run in progress, carried across segments so a corner inside the lake does not split the line.
    let run: Position[] = [];

    for (let i = 0; i + 1 < ring.length; i++) {
      const from = ring[i] as [number, number];
      const to = ring[i + 1] as [number, number];
      const a: LatLng = { lat: from[1], lng: from[0] };
      const b: LatLng = { lat: to[1], lng: to[0] };
      const steps = Math.max(1, Math.ceil(haversineMeters(a, b) / spacing));

      for (let step = 0; step <= steps; step++) {
        const t = step / steps;
        // Kept as an explicit tuple rather than indexed back out: `Position` is `number[]`, so under
        // `noUncheckedIndexedAccess` every read of it is `number | undefined`.
        const lng = from[0] + (to[0] - from[0]) * t;
        const lat = from[1] + (to[1] - from[1]) * t;
        const position: Position = [lng, lat];

        // The bbox test first, because it rejects the ninety-odd kilometres of every edge that never
        // come near this lake for the cost of four comparisons.
        const inside = inBox(lng, lat, box) && pointInPolygon({ lat, lng }, body);

        if (inside) {
          run.push(position);
        } else if (run.length > 1) {
          lines.push(run);
          run = [];
        } else {
          run = [];
        }
      }
    }

    if (run.length > 1) lines.push(run);
  }

  return lines.length > 0 ? { type: 'MultiLineString', coordinates: lines } : null;
}

/**
 * The seam as a drawable feature, or `null`.
 *
 * A thin wrapper so a client can hand the result straight to a GeoJSON source without composing the
 * envelope itself — and so the two clients cannot disagree about whether it is a geometry or a
 * feature.
 */
export function seamFeature(
  footprint: Polygon | MultiPolygon,
  body: Polygon | MultiPolygon,
  options?: { sampleMeters?: number },
): { type: 'Feature'; geometry: MultiLineString; properties: Record<string, never> } | null {
  const geometry = seamLineFor(footprint, body, options);
  return geometry ? { type: 'Feature', geometry, properties: {} } : null;
}

/** Total length of a seam in metres — for deciding whether one is worth drawing at all. */
export function seamLengthMeters(seam: MultiLineString | LineString): number {
  const lines = seam.type === 'LineString' ? [seam.coordinates] : seam.coordinates;
  let total = 0;
  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i] as [number, number];
      const b = line[i + 1] as [number, number];
      total += haversineMeters({ lat: a[1], lng: a[0] }, { lat: b[1], lng: b[0] });
    }
  }
  return total;
}
