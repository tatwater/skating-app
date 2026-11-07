import tokensCss from '@skating/design/tokens.css?raw';
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MapPane } from '@/components/kit/map-controls';
import type { ProjectingMap } from './MapMarksLayer';
import { mapGround, mapMarkVars, mapPalette } from './mapPalette';
import type { Ring } from './mapStoryData';

/**
 * Story support (not a story): the skater surface in both modes, and a still map to lay the real
 * marks, labels and dock over — MapLibre needs WebGL and tiles, so the stories draw the water from
 * the dev outlines in SVG and hand `MapMarksLayer` a projection, exactly the seam the app's
 * canvas uses. Nothing in the app imports this file.
 */

type Mode = 'dark' | 'light';
const SCOPE = 'data-theme-scope';

/** The bench's scoped token copy (the same one its four-up injects), so two modes sit side by side. */
function useScopedTokens() {
  useLayoutEffect(() => {
    if (document.querySelector('style[data-kit-scoped-tokens]')) return;
    const style = document.createElement('style');
    style.setAttribute('data-kit-scoped-tokens', '');
    style.textContent = tokensCss.replaceAll(':root', `[${SCOPE}]`);
    document.head.append(style);
  }, []);
}

/** A story on the skater surface in dark, then light: the composition's two real themes. */
export function SkaterPair({ children }: { children: (mode: Mode) => ReactNode }) {
  useScopedTokens();
  return (
    <div className="grid grid-cols-1 gap-px bg-line">
      {(['dark', 'light'] as const).map((mode) => (
        <section
          key={mode}
          {...{ [SCOPE]: '' }}
          data-surface="skater"
          data-mode={mode}
          aria-label={`Skater ${mode}`}
          className="flex flex-col gap-3 bg-bg p-4 font-(family-name:--family-sans) text-fg"
        >
          <h2 className="text-kick leading-none font-semibold tracking-kick text-fg3 uppercase">
            Skater · {mode === 'dark' ? 'Dark' : 'Light'}
          </h2>
          {children(mode)}
        </section>
      ))}
    </div>
  );
}

export interface StillView {
  /** West, south, east, north. */
  bounds: [number, number, number, number];
  width: number;
  height: number;
}

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/** A Web Mercator fit of `bounds` into the box, centered: the still's projection. */
export function stillProjection(view: StillView) {
  const [w, s, e, n] = view.bounds;
  const sx = view.width / (e - w);
  const sy = view.height / (mercY(n) - mercY(s));
  const k = Math.min(sx, (sy * Math.PI) / 180);
  const kx = k;
  const ky = (k * 180) / Math.PI;
  const ox = (view.width - (e - w) * kx) / 2;
  const oy = (view.height - (mercY(n) - mercY(s)) * ky) / 2;
  return ([lng, lat]: readonly [number, number]) => ({
    x: ox + (lng - w) * kx,
    y: oy + (mercY(n) - mercY(lat)) * ky,
  });
}

export interface StillWater {
  rings: readonly Ring[];
  inactive?: boolean;
  selected?: boolean;
  /** Depth is drawn on this lake: it takes the shallowest band's fill, as the canvas grounds it. */
  depthGround?: boolean;
}

/** One band polygon, as the band layer draws it: its band's token fill, its edge in its line. */
export interface StillBand {
  bandIndex: number;
  rings: readonly Ring[];
}

/**
 * The band polygons of one lake out of a band collection, as the canvas's layer picks and paints
 * them: filtered on the contours' `bodyId`, deeper over shallower. Polygons and multipolygons both
 * flatten to one even-odd path, so an annulus keeps its hole.
 */
export function stillBands(fc: GeoJSON.FeatureCollection, bodyId: string): StillBand[] {
  return fc.features
    .filter((f) => f.properties?.bodyId === bodyId)
    .map((f) => {
      const g = f.geometry;
      const polygons =
        g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      return {
        bandIndex: Number(f.properties?.bandIndex ?? 0),
        rings: polygons.flat() as unknown as Ring[],
      };
    })
    .sort((a, b) => a.bandIndex - b.bandIndex);
}

/**
 * A still map: the basemap's ground, the water drawn the way the canvas paints it, and whatever
 * the story lays over it. `children` gets the projecting map once the pane has measured.
 */
export function MapStill({
  mode,
  view,
  water,
  bands = [],
  children,
}: {
  mode: Mode;
  view: StillView;
  water: readonly StillWater[];
  bands?: readonly StillBand[];
  children: (map: ProjectingMap) => ReactNode;
}) {
  const flavor = mode === 'dark' ? 'dark' : 'white';
  const palette = mapPalette(flavor);
  const project = useMemo(() => stillProjection(view), [view]);
  const pane = useRef<HTMLDivElement | null>(null);
  const [map, setMap] = useState<ProjectingMap | null>(null);
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el) return;
    setMap({
      project: ([lng, lat]) => project([lng, lat]),
      getContainer: () => el,
      on: () => undefined,
      off: () => undefined,
    });
  }, [project]);

  const path = (rings: readonly Ring[]) =>
    rings
      .map(
        (ring) =>
          `${ring
            .map(([lng, lat], i) => {
              const p = project([lng, lat]);
              return `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
            })
            .join(' ')} Z`,
      )
      .join(' ');

  return (
    <MapPane
      ref={pane}
      className="ph-no-capture shrink-0"
      style={{
        ...mapMarkVars(flavor),
        width: view.width,
        height: view.height,
        background: mapGround(flavor),
      }}
    >
      <svg
        aria-hidden="true"
        width={view.width}
        height={view.height}
        className="absolute inset-0 block"
      >
        {water.map((body, i) => (
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed fixture
            key={i}
            d={path(body.rings)}
            fillRule="evenodd"
            fill={
              body.inactive
                ? palette.inactive.fill
                : body.depthGround
                  ? palette.depth.fills[0]
                  : palette.water.fill
            }
            fillOpacity={
              body.depthGround
                ? 1
                : body.inactive
                  ? 0.18
                  : body.selected
                    ? 0
                    : palette.water.fillOpacity
            }
            stroke={
              body.selected
                ? palette.selected
                : body.inactive
                  ? palette.inactive.outline
                  : palette.water.outline
            }
            strokeWidth={body.selected ? 1.6 : 1}
          />
        ))}
        {bands.map((band) => (
          <path
            key={band.bandIndex}
            data-band={band.bandIndex}
            d={path(band.rings)}
            fillRule="evenodd"
            fill={palette.depth.fills[band.bandIndex] ?? palette.depth.fills.at(-1)}
            stroke={palette.depth.lines[band.bandIndex] ?? palette.depth.lines.at(-1)}
            strokeWidth={0.8}
          />
        ))}
      </svg>
      {map && children(map)}
    </MapPane>
  );
}
