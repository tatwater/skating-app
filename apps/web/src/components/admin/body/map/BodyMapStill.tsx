import type { MapSurface } from '@/lib/mapSurface';
import {
  FIELD_DOT_RADIUS,
  FIELD_TONES,
  LINE_STYLES,
  LIT_STYLE,
  OUTLINE_STYLES,
  type StrokeSpec,
  tokenVar,
} from './bodyMapPalette';
import type { DrawnScene } from './bodyScene';

/**
 * The console map's outlines and lines drawn as SVG over the map's land, from the same scene and
 * the same style table MapLibre paints from — the ground a story stands the map's chrome on, since
 * a story can't fetch the basemap's tiles. Story support and test support only; the app draws
 * `BodyMapCanvas`.
 */

function dashOf(spec: StrokeSpec): string | undefined {
  return spec.dash ? spec.dash.map((d) => d * spec.width).join(' ') : undefined;
}

/**
 * The summer aerial's stand-in for a still: a story can't fetch the photograph, so a fixed field of
 * patches in the map's own quiet lifts stands where it would be — over the fills, under every line,
 * the band the live map puts it in — so the inks can be read over a busy ground. It stands for
 * where the photograph goes, not how it looks: the real one is in full color and only lightly
 * dimmed (`AERIAL_PAINT`), so the inks hold less contrast over it than over this; the
 * `Summer aerial (live)` stories draw it.
 */
function AerialStandIn({ width, height }: { width: number; height: number }) {
  // A fixed field (a small linear-congruential walk), so a still is the same on every render.
  let seed = 23;
  const next = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const patches = Array.from({ length: 36 }, (_, i) => {
    const w = 40 + next() * 160;
    const h = 30 + next() * 110;
    const x = next() * width - w / 2;
    const y = next() * height - h / 2;
    const fill = i % 4 === 0 ? 'var(--lift-08)' : 'var(--lift-05)';
    return { x, y, w, h, fill, angle: (next() - 0.5) * 50 };
  });
  return (
    <g data-slot="body-map-aerial-still">
      <rect width={width} height={height} fill="var(--raise)" />
      {patches.map((p, i) => (
        <rect
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed field's patches are positional
          key={i}
          x={p.x.toFixed(1)}
          y={p.y.toFixed(1)}
          width={p.w.toFixed(1)}
          height={p.h.toFixed(1)}
          fill={p.fill}
          transform={`rotate(${p.angle.toFixed(1)} ${(p.x + p.w / 2).toFixed(1)} ${(p.y + p.h / 2).toFixed(1)})`}
        />
      ))}
    </g>
  );
}

export function BodyMapStill({
  surface,
  drawn,
  aerial = false,
}: {
  surface: MapSurface;
  drawn: DrawnScene;
  /** The summer aerial is on: its stand-in over the fills. */
  aerial?: boolean;
}) {
  const pt = (c: GeoJSON.Position) => {
    const p = surface.project([c[0] ?? 0, c[1] ?? 0]);
    return `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  };
  const ringPath = (ring: GeoJSON.Position[]) =>
    `${ring.map((c, i) => `${i ? 'L' : 'M'}${pt(c)}`).join(' ')} Z`;
  const polyPath = (g: GeoJSON.Polygon | GeoJSON.MultiPolygon) =>
    (g.type === 'Polygon' ? [g.coordinates] : g.coordinates)
      .flatMap((poly) => poly.map(ringPath))
      .join(' ');
  return (
    <svg
      aria-hidden="true"
      data-slot="body-map-still"
      width={surface.width}
      height={surface.height}
      className="absolute top-0 left-0 block bg-map-earth"
    >
      {/* Fills first, then every line — MapLibre's order, so the body's water never covers a bay. */}
      {drawn.outlines.features.map((f) => {
        const base = OUTLINE_STYLES[f.properties.style as keyof typeof OUTLINE_STYLES];
        // A field footprint has no plate: its dots are the drawing.
        if (base === undefined || base.fill === null) return null;
        return (
          <path
            key={`fill:${f.properties.id}`}
            d={polyPath(f.geometry)}
            fillRule="evenodd"
            fill={tokenVar(base.fill)}
            stroke="none"
          />
        );
      })}
      {aerial && <AerialStandIn width={surface.width} height={surface.height} />}
      {drawn.outlines.features.map((f) => {
        const spec = f.properties.lit
          ? LIT_STYLE
          : OUTLINE_STYLES[f.properties.style as keyof typeof OUTLINE_STYLES];
        if (spec === undefined) return null;
        return (
          <path
            key={f.properties.id}
            data-id={f.properties.id}
            data-lit={f.properties.lit ? '' : undefined}
            d={polyPath(f.geometry)}
            fillRule="evenodd"
            fill={f.properties.lit && LIT_STYLE.fill ? tokenVar(LIT_STYLE.fill) : 'none'}
            stroke={tokenVar(spec.line)}
            strokeWidth={spec.width}
            strokeDasharray={dashOf(spec)}
          />
        );
      })}
      {/* The hazards' dot fields, under the lines — the GL order. */}
      {drawn.dots.features.map((f, i) => {
        const [x, y] = f.geometry.coordinates;
        const p = surface.project([x ?? 0, y ?? 0]);
        return (
          <circle
            // biome-ignore lint/suspicious/noArrayIndexKey: a field's dots are positional
            key={`dot:${f.properties.id}:${i}`}
            data-slot="body-map-dot"
            data-id={f.properties.id}
            cx={p.x.toFixed(1)}
            cy={p.y.toFixed(1)}
            r={FIELD_DOT_RADIUS}
            fill={tokenVar(FIELD_TONES[f.properties.tone])}
            fillOpacity={f.properties.opacity}
          />
        );
      })}
      {drawn.lines.features.map((f) => {
        const spec = f.properties.lit ? LIT_STYLE : LINE_STYLES[f.properties.style as never];
        return (
          <path
            key={f.properties.id}
            data-id={f.properties.id}
            d={f.geometry.coordinates.map((c, i) => `${i ? 'L' : 'M'}${pt(c)}`).join(' ')}
            fill="none"
            stroke={tokenVar((spec as StrokeSpec).line)}
            strokeWidth={(spec as StrokeSpec).width}
            strokeDasharray={dashOf(spec as StrokeSpec)}
          />
        );
      })}
    </svg>
  );
}
