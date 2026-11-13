import {
  LINE_STYLES,
  LIT_STYLE,
  OUTLINE_STYLES,
  type StrokeSpec,
  tokenVar,
} from './bodyMapPalette';
import type { DrawnScene } from './bodyScene';
import type { MapSurface } from './mapSurface';

/**
 * The console map's outlines and lines drawn as SVG over the map's land, from the same scene and
 * the same style table MapLibre paints from — the ground a story stands the map's chrome on, since
 * a story can't fetch the basemap's tiles. Story support and test support only; the app draws
 * `BodyMapCanvas`.
 */

function dashOf(spec: StrokeSpec): string | undefined {
  return spec.dash ? spec.dash.map((d) => d * spec.width).join(' ') : undefined;
}

export function BodyMapStill({ surface, drawn }: { surface: MapSurface; drawn: DrawnScene }) {
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
        if (base.fill === null) return null;
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
      {drawn.outlines.features.map((f) => {
        const spec = f.properties.lit
          ? LIT_STYLE
          : OUTLINE_STYLES[f.properties.style as keyof typeof OUTLINE_STYLES];
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
