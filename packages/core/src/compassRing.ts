/**
 * The compass ring around the lake (A10-6 / D206) — the `where` picker's pointer half.
 *
 * Eight arc segments, one per compass sector, drawn around the silhouette's **origin** (the same
 * interior point the sector wedges fan out from, so a click on the N arc and the N wedge it lights
 * are one fact). The ring is not decoration and is never permanent: a surface draws it only while a
 * where question is open (where-mode), and the chips beside it answer the same question for a
 * keyboard. `middle` and `near_shore` have no arc — they are the disc and the band, chips only.
 *
 * Pure geometry over a `Projection`, shared by the web `<svg>` and mobile `react-native-svg`
 * drawings so the two rings cannot drift. Nothing here is a safety claim (D3): a sector says where
 * the author looked.
 */

import type { LngLat, Projection } from './bodySilhouette';
import type { LatLng } from './geometry';
import { compassSectorFor } from './sectorGeometry';
import { COMPASS_SECTORS, type CompassSector } from './types';

export interface RingSegment {
  sector: CompassSector;
  /** The arc, as an SVG path (`M … A …`), from the sector's first bearing to its last, less the gaps. */
  d: string;
  /** Where the sector's letters sit, outside the arc. */
  label: [number, number];
  /** The tick at the sector's *first* bearing, inside → outside the ring. */
  tick: [[number, number], [number, number]];
}

export interface CompassRing {
  cx: number;
  cy: number;
  r: number;
  segments: RingSegment[];
}

export interface CompassRingOptions {
  /** Ring radius in px. Default: as large as fits around the origin inside the drawing, less the label room. */
  radius?: number;
  /** Degrees trimmed from each end of every arc so the eight read as eight. */
  gapDeg?: number;
  /** How far outside the arc the letters sit. */
  labelOffset?: number;
  /** Tick length, straddling the arc. */
  tickLength?: number;
}

const DEFAULT_GAP_DEG = 2.5;
const DEFAULT_LABEL_OFFSET = 14;
const DEFAULT_TICK = 8;
/** Below this the arcs are too short to hit; the caller should draw chips only. */
export const MIN_RING_RADIUS_PX = 36;

function pointAt(cx: number, cy: number, r: number, bearingDeg: number): [number, number] {
  const rad = (bearingDeg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
}

const f = (n: number) => n.toFixed(1);

/**
 * The ring for a projection and the lake's origin. `null` when no radius ≥ `MIN_RING_RADIUS_PX` fits
 * — an origin hard against the drawing's edge — so the surface falls back to the chips.
 */
export function compassRing(
  projection: Projection,
  origin: LatLng,
  opts: CompassRingOptions = {},
): CompassRing | null {
  const [cx, cy] = projection.toXY([origin.lng, origin.lat]);
  const labelOffset = opts.labelOffset ?? DEFAULT_LABEL_OFFSET;
  const room = Math.min(cx, cy, projection.width - cx, projection.height - cy);
  const r = opts.radius ?? Math.floor(room - labelOffset - 6);
  if (!(r >= MIN_RING_RADIUS_PX)) return null;
  const gap = opts.gapDeg ?? DEFAULT_GAP_DEG;
  const tick = opts.tickLength ?? DEFAULT_TICK;
  const step = 360 / COMPASS_SECTORS.length;
  const segments: RingSegment[] = COMPASS_SECTORS.map((sector, i) => {
    const mid = i * step;
    const a0 = mid - step / 2 + gap;
    const a1 = mid + step / 2 - gap;
    const [x0, y0] = pointAt(cx, cy, r, a0);
    const [x1, y1] = pointAt(cx, cy, r, a1);
    const [lx, ly] = pointAt(cx, cy, r + labelOffset, mid);
    const [tx0, ty0] = pointAt(cx, cy, r - tick / 2, mid - step / 2);
    const [tx1, ty1] = pointAt(cx, cy, r + tick / 2, mid - step / 2);
    return {
      sector,
      d: `M ${f(x0)} ${f(y0)} A ${f(r)} ${f(r)} 0 0 1 ${f(x1)} ${f(y1)}`,
      label: [lx, ly],
      tick: [
        [tx0, ty0],
        [tx1, ty1],
      ],
    };
  });
  return { cx, cy, r, segments };
}

/**
 * Which compass sector a point on the drawing means, by its bearing from the origin — the same
 * rule the wedges are cut by, so a click just outside the N arc, or on the water under it, is N.
 */
export function ringSectorAtXY(ring: Pick<CompassRing, 'cx' | 'cy'>, xy: LngLat): CompassSector {
  const dx = xy[0] - ring.cx;
  const dy = ring.cy - xy[1];
  const bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
  return compassSectorFor(bearing);
}

/** Is a point on the ring itself (within `tolerance` px of the arc), rather than on the water inside it? */
export function onRing(
  ring: Pick<CompassRing, 'cx' | 'cy' | 'r'>,
  xy: LngLat,
  tolerance = 12,
): boolean {
  const d = Math.hypot(xy[0] - ring.cx, xy[1] - ring.cy);
  return Math.abs(d - ring.r) <= tolerance;
}
