/**
 * The water-body silhouette (A10 §12.3; Phase 05 decision 6, folded in by founder call 2026-09-20).
 *
 * A small still image of the lake on a report card and, later, under the sheet: the outline as a
 * shape, the put-in as a dot, the skate as a line, and — when a chip says *where* — a soft wedge
 * or band over the part of the lake the author meant. **Not a map.** No tiles, no zoom, no tap: the
 * card is the button, and the detail page has the real map. That is what makes it cheap enough to
 * draw twenty times in a scrolling list on a phone, and what lets it render from the offline cache.
 *
 * Drawn at render time, never minted as an image: a baked picture could not follow the theme, the
 * author flipping `showPutIn` (the pin goes and the path's ends are trimmed, D58), an outline
 * redraw, or a sector highlight's color. What the server sends is geometry, small — a few hundred
 * points — and the two SVG components (`react-native-svg`, inline `<svg>`) draw the same paths from
 * the same functions here.
 *
 * Every projection is an equirectangular fit scaled by cos(latitude), which at the scale of one lake
 * is indistinguishable from the map's Mercator and needs no library. Nothing here is a safety claim
 * (D3): the highlight says where the author looked, not where the ice is good.
 */

import { type BBox, haversineMeters, type LatLng, polygonBBox, simplifyPath } from './geometry';
import { COMPASS_SECTORS, type Sector } from './types';
import type { Where } from './where';

/** A `[lng, lat]` pair, the GeoJSON order — what the outline arrives in and what the SVG consumes. */
export type LngLat = [number, number];

/** The geometry one card needs. Ids are absent on purpose: this is a picture, not a link. */
export interface SilhouetteData {
  /** The outline's rings after simplification — outer rings and the islands big enough to survive. */
  rings: LngLat[][];
  bbox: BBox;
  /** The wedge apex — the body's interior point, never the shoreline `centroid`. */
  origin: LatLng;
  /** The radius of the `middle` sector in meters, when a highlight needs it. */
  middleRadiusM?: number;
  /** Where the author got on — only when the viewer may see it (Phase 04 #7). */
  putIn?: LatLng;
  /** The recorded skate, simplified, its ends trimmed when the put-in is withheld (D58). */
  path?: LngLat[];
  /** The part of the lake the author's chips are about (D193), when they say. */
  sector?: Sector;
  /** The named bay a chip is about, as its ring, when one is named. */
  bayRing?: LngLat[];
}

/** How many points a card's outline may carry, all rings together. Plenty for 160 px; tiny on the wire. */
export const SILHOUETTE_MAX_POINTS = 240;
/** Rings that simplify to less than this many points are noise at card scale and are dropped. */
const MIN_RING_POINTS = 4;

type Geom =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

/**
 * The outline, simplified for a card: every ring run through Douglas–Peucker at a tolerance derived
 * from the body's own extent (a pixel at `SILHOUETTE_MAX_POINTS` px across), coarsened until the
 * whole thing fits the point budget, tiny rings dropped. Champlain's 10,755 vertices come back as
 * a couple of hundred; a pond's 40 come back as 40.
 */
export function silhouetteRings(geom: Geom): { rings: LngLat[][]; bbox: BBox } {
  const bbox = polygonBBox(geom);
  const spanM = Math.max(
    haversineMeters({ lat: bbox.minLat, lng: bbox.minLng }, { lat: bbox.minLat, lng: bbox.maxLng }),
    haversineMeters({ lat: bbox.minLat, lng: bbox.minLng }, { lat: bbox.maxLat, lng: bbox.minLng }),
    1,
  );
  const source: number[][][] = geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.flat();
  // Converted once; a coarsening pass re-simplifies, it does not re-read the outline.
  const sourcePoints = source.map((ring) =>
    ring.map(([lng, lat]): LatLng => ({ lat: lat as number, lng: lng as number })),
  );
  let tolerance = spanM / SILHOUETTE_MAX_POINTS;
  let rings: LngLat[][] = [];
  for (let pass = 0; pass < 8; pass++) {
    rings = [];
    for (const points of sourcePoints) {
      const kept = simplifyPath(points, tolerance);
      if (kept.length < MIN_RING_POINTS) continue;
      rings.push(kept.map((p): LngLat => [p.lng, p.lat]));
    }
    const total = rings.reduce((n, r) => n + r.length, 0);
    if (total <= SILHOUETTE_MAX_POINTS) break;
    tolerance *= 1.6;
  }
  return { rings, bbox };
}

/** A recorded path, simplified to the same budget — a skate's shape, not its every fix. */
export function silhouettePath(coordinates: readonly number[][], bbox: BBox): LngLat[] {
  const spanM = Math.max(
    haversineMeters({ lat: bbox.minLat, lng: bbox.minLng }, { lat: bbox.minLat, lng: bbox.maxLng }),
    haversineMeters({ lat: bbox.minLat, lng: bbox.minLng }, { lat: bbox.maxLat, lng: bbox.minLng }),
    1,
  );
  const points = coordinates.map(([lng, lat]) => ({ lat: lat as number, lng: lng as number }));
  return simplifyPath(points, spanM / SILHOUETTE_MAX_POINTS).map((p): LngLat => [p.lng, p.lat]);
}

/**
 * The `where` the highlight draws, for a report whose chips may each say a different place: the
 * **first located chip's `where`, whole** — its sector and its bay together, as that one
 * observation stated them. Never a sector from one chip beside a bay from another: "black ice,
 * south end" plus a thickness reading in North Bay is not "the south end of North Bay", and a card
 * that drew both would compose a place no one claimed. One highlight per card — a report that says
 * "black ice north, slush south" is a report the reader opens. A chip located by a point alone is
 * not one the card can draw.
 */
export function reportWhereSummary(report: {
  iceTypes: readonly { where?: Where }[];
  surfaceTags: readonly { where?: Where }[];
  iceThickness?: { readings: readonly { where?: Where }[] };
}): { sector?: Sector; subAreaId?: string } {
  const located = [
    ...report.iceTypes,
    ...report.surfaceTags,
    ...(report.iceThickness?.readings ?? []),
  ].find((c) => c.where?.sector !== undefined || c.where?.subAreaId !== undefined)?.where;
  return {
    ...(located?.sector !== undefined ? { sector: located.sector } : {}),
    ...(located?.subAreaId !== undefined ? { subAreaId: located.subAreaId } : {}),
  };
}

// ── Drawing ───────────────────────────────────────────────────────────────────────────────────────

export interface Projection {
  width: number;
  height: number;
  toXY(point: LngLat): [number, number];
  /** The inverse — a tap on the drawing back to a coordinate (the sheet's picker, A10 §7.1). */
  fromXY(xy: [number, number]): LngLat;
  /** Pixels per meter at the fit — for radii. */
  pxPerMeter: number;
}

/**
 * Fit the bbox into `width × height` with `pad` px of margin, preserving aspect, latitude scaled by
 * cos(mid-latitude) so a round pond draws round. Centered on the short axis.
 */
export function silhouetteProjection(
  bbox: BBox,
  width: number,
  height: number,
  pad = 4,
): Projection {
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const cos = Math.max(Math.cos((midLat * Math.PI) / 180), 1e-6);
  const spanX = Math.max((bbox.maxLng - bbox.minLng) * cos, 1e-9);
  const spanY = Math.max(bbox.maxLat - bbox.minLat, 1e-9);
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const drawnW = spanX * scale;
  const drawnH = spanY * scale;
  const offsetX = (width - drawnW) / 2;
  const offsetY = (height - drawnH) / 2;
  const metersPerDegLat = 111_320;
  return {
    width,
    height,
    toXY: ([lng, lat]) => [
      offsetX + (lng - bbox.minLng) * cos * scale,
      offsetY + (bbox.maxLat - lat) * scale,
    ],
    fromXY: ([x, y]) => [
      bbox.minLng + (x - offsetX) / (cos * scale),
      bbox.maxLat - (y - offsetY) / scale,
    ],
    pxPerMeter: scale / metersPerDegLat,
  };
}

/** An SVG path for a closed ring: `M x y L … Z`, to one decimal. */
export function ringToPath(ring: readonly LngLat[], projection: Projection): string {
  return `${lineToPath(ring, projection)} Z`;
}

/** An SVG path for an open line. Empty for fewer than two points. */
export function lineToPath(line: readonly LngLat[], projection: Projection): string {
  if (line.length < 2) return '';
  return line
    .map((p, i) => {
      const [x, y] = projection.toXY(p);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

/** The rings as one path with holes (draw with `fill-rule="evenodd"`). */
export function ringsToPath(rings: readonly LngLat[][], projection: Projection): string {
  return rings.map((ring) => ringToPath(ring, projection)).join(' ');
}

/** The bearing range of a compass sector, degrees clockwise from north — `N` is `[-22.5, 22.5)`. */
function sectorBearings(sector: (typeof COMPASS_SECTORS)[number]): [number, number] {
  const step = 360 / COMPASS_SECTORS.length;
  const center = COMPASS_SECTORS.indexOf(sector) * step;
  return [center - step / 2, center + step / 2];
}

/**
 * The highlight for a sector, as an SVG path in the projection: a fan from the origin for a compass
 * sector (long enough to cross the whole silhouette — the caller clips it to the outline), a disc
 * for `middle`, `null` for the ones a still image cannot say alone (`near_shore` is a stroke — see
 * `NEAR_SHORE_STROKE_PX`; `head` / `mouth` need the bay, which draws as its ring instead).
 */
export function sectorHighlightPath(
  data: Pick<SilhouetteData, 'origin' | 'middleRadiusM'>,
  sector: Sector,
  projection: Projection,
): string | null {
  const [ox, oy] = projection.toXY([data.origin.lng, data.origin.lat]);
  if (sector === 'middle') {
    const r =
      data.middleRadiusM !== undefined
        ? Math.max(3, data.middleRadiusM * projection.pxPerMeter)
        : Math.min(projection.width, projection.height) * 0.2;
    return `M ${(ox - r).toFixed(1)} ${oy.toFixed(1)} a ${r.toFixed(1)} ${r.toFixed(1)} 0 1 0 ${(2 * r).toFixed(1)} 0 a ${r.toFixed(1)} ${r.toFixed(1)} 0 1 0 ${(-2 * r).toFixed(1)} 0 Z`;
  }
  if (!(COMPASS_SECTORS as readonly string[]).includes(sector)) return null;
  const [from, to] = sectorBearings(sector as (typeof COMPASS_SECTORS)[number]);
  const reach = Math.hypot(projection.width, projection.height) * 2;
  const point = (bearing: number): string => {
    const rad = (bearing * Math.PI) / 180;
    return `${(ox + reach * Math.sin(rad)).toFixed(1)} ${(oy - reach * Math.cos(rad)).toFixed(1)}`;
  };
  // Three rays so the fan's far edge is never a chord inside the lake.
  return `M ${ox.toFixed(1)} ${oy.toFixed(1)} L ${point(from)} L ${point((from + to) / 2)} L ${point(to)} Z`;
}

/** The stroke width, in px, that draws `near_shore` as a band inside the outline. */
export const NEAR_SHORE_STROKE_PX = 10;
