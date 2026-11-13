import { useId, useState } from 'react';

import { MapPane, MapZoom } from '@/components/kit/map-controls';
import { cn } from '@/lib/utils';

import type { BodyOutline } from './bodiesData';

/**
 * The preview's map still: the body's outline drawn in SVG from its polygon — no tiles, no WebGL,
 * one per preview however fast the operator moves down the list. Square, as a map beside a pane
 * head is (the founder's rule). The put-ins are ice squares (ice is geography); a faint graticule
 * gives it a scale; the label in the corner names where it is and what's on it.
 *
 * The zoom pair magnifies about the body's middle, within the body's reach (never past 4×, never
 * out past the whole outline) — the still is a look, not a map to wander.
 */

const VIEW = 100;
/** The outline's inset inside the square, in view units. */
const PAD = 9;
const ZOOM_MAX = 4;

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/** A Web Mercator fit of `bbox` into the square, centered, `PAD` in from each edge. */
export function stillProject(bbox: BodyOutline['bbox']) {
  const [w, s, e, n] = bbox;
  const spanX = Math.max(e - w, 1e-9);
  const spanY = Math.max(mercY(n) - mercY(s), 1e-9);
  const inner = VIEW - 2 * PAD;
  // One scale for both axes: degrees of longitude across, Mercator units (radians) down.
  const k = Math.min(inner / spanX, (inner / spanY) * (Math.PI / 180));
  const sx = k;
  const sy = (k * 180) / Math.PI;
  const ox = (VIEW - spanX * sx) / 2;
  const oy = (VIEW - spanY * sy) / 2;
  return ([lng, lat]: readonly [number, number]) => ({
    x: ox + (lng - w) * sx,
    y: oy + (mercY(n) - mercY(lat)) * sy,
  });
}

/** One ring as an SVG path, closed. */
function ringPath(
  ring: readonly (readonly [number, number])[],
  project: ReturnType<typeof stillProject>,
): string {
  return `${ring
    .map((pt, i) => {
      const { x, y } = project(pt);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ')} Z`;
}

/** "43.63 −72.15" — two decimals, a true minus. */
export function coordText(lat: number, lng: number): string {
  const f = (v: number) => v.toFixed(2).replace('-', '−');
  return `${f(lat)} ${f(lng)}`;
}

type OutlineStillProps = {
  outline: BodyOutline;
  putIns: readonly { lat: number; lng: number }[];
  /** The corner label ("43.63 −72.15 · 6 put-ins · 2 bays"). */
  label: string;
  /** The body's name, for a reader. */
  name: string;
  className?: string;
};

export function OutlineStill({ outline, putIns, label, name, className }: OutlineStillProps) {
  const [zoom, setZoom] = useState(1);
  const clip = useId();
  const project = stillProject(outline.bbox);
  const d = outline.polygons
    .map((rings) => rings.map((r) => ringPath(r, project)).join(' '))
    .join(' ');
  const size = VIEW / zoom;
  const origin = (VIEW - size) / 2;
  // A square a putin draws, in view units that stay one size whatever the zoom.
  const mark = 2.6 / zoom;
  return (
    <MapPane
      data-slot="outline-still"
      className={cn('aspect-square w-full border-0 border-b border-solid border-line', className)}
    >
      <svg
        role="img"
        aria-label={`Outline of ${name}`}
        viewBox={`${origin} ${origin} ${size} ${size}`}
        className="absolute inset-0 size-full"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <clipPath id={clip}>
            <rect x={origin} y={origin} width={size} height={size} />
          </clipPath>
        </defs>
        <g data-slot="still-graticule" className="stroke-line" strokeWidth={0.2 / zoom}>
          {[20, 40, 60, 80].map((v) => (
            <g key={v}>
              <line x1={v} y1={0} x2={v} y2={VIEW} />
              <line x1={0} y1={v} x2={VIEW} y2={v} />
            </g>
          ))}
        </g>
        <g clipPath={`url(#${clip})`}>
          <path
            data-slot="still-outline"
            d={d}
            fillRule="evenodd"
            className="fill-lift-03 stroke-fg"
            strokeWidth={0.45 / zoom}
            strokeLinejoin="round"
          />
          {putIns.map((p) => {
            const { x, y } = project([p.lng, p.lat]);
            return (
              <rect
                key={`${p.lng},${p.lat}`}
                data-slot="still-putin"
                x={x - mark / 2}
                y={y - mark / 2}
                width={mark}
                height={mark}
                className="fill-bg stroke-acc"
                strokeWidth={0.6 / zoom}
              />
            );
          })}
        </g>
      </svg>
      <span
        data-slot="still-label"
        className="absolute right-(--space-10) bottom-(--space-2_5) z-(--z-map-control) font-(family-name:--family-mono) text-kick leading-none tracking-key whitespace-nowrap text-fg3 uppercase"
      >
        {label}
      </span>
      <MapZoom
        className="absolute right-(--space-2_5) bottom-(--space-2_5) z-(--z-map-control)"
        onZoomIn={() => setZoom((z) => Math.min(ZOOM_MAX, z * 2))}
        onZoomOut={() => setZoom((z) => Math.max(1, z / 2))}
        atMax={zoom >= ZOOM_MAX}
        atMin={zoom <= 1}
      />
    </MapPane>
  );
}
