import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

import type { GraticuleLayout } from './graticule';

/**
 * **Kit candidate** — the map's graticule: true parallels and meridians at a round step, faint, with
 * their labels at the pane's edges (`43.66°N` at the right, `72.20°W` along the foot). Pure SVG, no
 * map library: the pane computes the layout (`graticuleLayout`, from its size and its map's
 * projection) and this draws it, so a story's still and a live MapLibre pane draw the same thing.
 *
 * - **Lines are a lift, not a rule**: `lift-05`, the boards' 5 % grid — texture that encodes where,
 *   never louder than the water.
 * - **Labels are mono caps at the kicker step** in the quiet ink, on clear ground only (the layout
 *   leaves out any that would touch the pane's UI).
 * - It never takes a pointer, and a reader skips it: the coordinates are the map's furniture.
 *
 * Board: 5.4.1 Body | Shape (and every Body and Corpus map since Review 11).
 */

type MapGraticuleProps = Omit<ComponentProps<'svg'>, 'children'> & {
  layout: GraticuleLayout;
  /** The pane's size, px. */
  width: number;
  height: number;
  /** Draw the lines as well as the labels (default). */
  lines?: boolean;
};

function MapGraticule({
  layout,
  width,
  height,
  lines = true,
  className,
  ...props
}: MapGraticuleProps) {
  return (
    <svg
      aria-hidden="true"
      data-slot="map-graticule"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('pointer-events-none absolute top-0 left-0 block', className)}
      {...props}
    >
      {lines && (
        <g data-slot="map-graticule-lines" stroke="var(--lift-05)" strokeWidth={1}>
          {layout.meridians.map((x) => (
            <line key={`m${x.toFixed(2)}`} x1={x} x2={x} y1={0} y2={height} />
          ))}
          {layout.parallels.map((y) => (
            <line key={`p${y.toFixed(2)}`} x1={0} x2={width} y1={y} y2={y} />
          ))}
        </g>
      )}
      {layout.labels.map((l) => (
        <text
          key={l.text}
          data-slot="map-graticule-label"
          x={l.x}
          y={l.y}
          textAnchor={l.anchor}
          className="fill-fg3 font-(family-name:--family-mono) text-kick tracking-micro"
        >
          {l.text}
        </text>
      ))}
    </svg>
  );
}

export { MapGraticule, type MapGraticuleProps };
