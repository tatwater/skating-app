import { depthBandIndex } from '@skating/core';
import tokensCss from '@skating/design/tokens.css?raw';
import { type ReactNode, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MapPane } from '@/components/kit/map-controls';
import { CONTOUR_OPACITY } from '@/lib/contourMap';
import { FRESHNESS_FILL_OPACITY, PROVISIONAL_OPACITY_SCALE } from '@/lib/hazardMap';
import { mapEarth } from '@/lib/waterMap';
import type { ProjectingMap } from './MapMarksLayer';
import { mapMarkVars, mapPalette } from './mapPalette';
import type { Ring } from './mapStoryData';
import type { StoryContour, StoryHazard } from './mapStoryDepth';

/**
 * Story support (not a story): the skater surface in both modes, and a still map to lay the real
 * marks, labels and dock over — MapLibre needs WebGL and tiles, so the stories draw the water from
 * the dev outlines in SVG and hand `MapMarksLayer` a projection, exactly the seam the app's
 * canvas uses. Every GL layer the canvas paints has a still here, in the palette's own colors at
 * `skaterLayers`' widths, dashes and opacities, so a color nobody can see in a story doesn't exist.
 * Nothing in the app imports this file.
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
  hovered?: boolean;
  /** The lake's isobaths: the lines the canvas lays over the band fills. */
  contours?: readonly StoryContour[];
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

/** A framed bay (board 1.10): the chord that parts the lake, and which side is the bay. */
export interface StillBay {
  chord: Ring;
  /** A point inside the framed bay, to pick its side of the chord. */
  inside: readonly [number, number];
  names: ReadonlyArray<{ name: string; lng: number; lat: number; angle: number }>;
}

export interface StillOverlays {
  hazards?: readonly StoryHazard[];
  bay?: StillBay;
  landmarks?: ReadonlyArray<{ name: string; lng: number; lat: number }>;
  approach?: { path: Ring; label: string };
  track?: Ring;
}

type Project = (p: readonly [number, number]) => { x: number; y: number };

const pathOf = (project: Project, rings: readonly Ring[]) =>
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

const lineOf = (project: Project, ring: Ring) =>
  ring
    .map(([lng, lat], i) => {
      const p = project([lng, lat]);
      return `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    })
    .join(' ');

/** The half-plane on `inside`'s side of the chord, as a path (mock `northClip`). */
function halfPlane(
  project: Project,
  chord: Ring,
  inside: readonly [number, number],
  flip: boolean,
) {
  const [p, q] = chord.map((c) => project(c)) as [
    { x: number; y: number },
    { x: number; y: number },
  ];
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  let nx = -uy;
  let ny = ux;
  const c = project(inside);
  if ((c.x - p.x) * nx + (c.y - p.y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  if (flip) {
    nx = -nx;
    ny = -ny;
  }
  const F = 9000;
  const P = (x: number, y: number) => `${x.toFixed(1)} ${y.toFixed(1)}`;
  return `M${P(p.x - ux * F, p.y - uy * F)} L${P(q.x + ux * F, q.y + uy * F)} L${P(q.x + ux * F + nx * F, q.y + uy * F + ny * F)} L${P(p.x - ux * F + nx * F, p.y - uy * F + ny * F)} Z`;
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
  overlays = {},
  children,
}: {
  mode: Mode;
  view: StillView;
  water: readonly StillWater[];
  bands?: readonly StillBand[];
  overlays?: StillOverlays;
  children: (map: ProjectingMap) => ReactNode;
}) {
  const flavor = mode === 'dark' ? 'dark' : 'white';
  const palette = mapPalette(flavor);
  const project = useMemo(() => stillProjection(view), [view]);
  const pane = useRef<HTMLDivElement | null>(null);
  const [map, setMap] = useState<ProjectingMap | null>(null);
  const clipId = useId();
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

  const hazardColor = (tone: StoryHazard['tone']) => palette.hazard[tone];
  const bayLake = water.find((w) => w.selected) ?? water[0];
  const label = (
    key: string,
    text: string,
    at: { x: number; y: number },
    color: string,
    opts: { size: number; weight: number; spacing?: number; angle?: number; upper?: boolean },
  ) => (
    <text
      key={key}
      x={0}
      y={0}
      transform={`translate(${at.x.toFixed(1)} ${at.y.toFixed(1)}) rotate(${opts.angle ?? 0})`}
      textAnchor="middle"
      dominantBaseline="middle"
      fontFamily="Noto Sans, sans-serif"
      fontSize={opts.size}
      fontWeight={opts.weight}
      letterSpacing={opts.spacing ?? 0}
      fill={color}
      stroke={palette.places.halo}
      strokeWidth={3}
      strokeLinejoin="round"
      style={{ paintOrder: 'stroke' }}
    >
      {opts.upper ? text.toUpperCase() : text}
    </text>
  );

  return (
    <MapPane
      ref={pane}
      className="ph-no-capture shrink-0"
      style={{
        ...mapMarkVars(flavor),
        width: view.width,
        height: view.height,
        background: mapEarth(flavor),
      }}
    >
      <svg
        aria-hidden="true"
        width={view.width}
        height={view.height}
        className="absolute inset-0 block"
      >
        {overlays.bay && bayLake && (
          <defs>
            <clipPath id={`${clipId}-bay`}>
              <path d={halfPlane(project, overlays.bay.chord, overlays.bay.inside, false)} />
            </clipPath>
            <clipPath id={`${clipId}-rest`}>
              <path d={halfPlane(project, overlays.bay.chord, overlays.bay.inside, true)} />
            </clipPath>
            <clipPath id={`${clipId}-lake`}>
              <path d={pathOf(project, bayLake.rings)} clipRule="evenodd" />
            </clipPath>
          </defs>
        )}
        {/* water-fill, then the contours over the chosen lake, then water-outline / hover / selected */}
        {water.map((body, i) => (
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed fixture
            key={i}
            d={pathOf(project, body.rings)}
            fillRule="evenodd"
            fill={
              body.inactive
                ? palette.inactive.fill
                : body.depthGround || body.contours
                  ? palette.depth.fills[0]
                  : palette.water.fill
            }
            stroke="none"
          />
        ))}
        {bands.map((band) => (
          <path
            key={band.bandIndex}
            data-band={band.bandIndex}
            d={pathOf(project, band.rings)}
            fillRule="evenodd"
            fill={palette.depth.fills[band.bandIndex] ?? palette.depth.fills.at(-1)}
            stroke={palette.depth.lines[band.bandIndex] ?? palette.depth.lines.at(-1)}
            strokeWidth={0.8}
          />
        ))}
        {water.map((body, i) =>
          body.contours?.map((c) => {
            const band = depthBandIndex(c.depthFt);
            const index = c.depthFt > 0 && c.depthFt % 25 === 0;
            return (
              <path
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed fixture
                key={`${i}-${c.depthFt}-${c.ring[0]?.join()}`}
                d={pathOf(project, [c.ring])}
                fill="none"
                stroke={index ? palette.depth.indexes[band] : palette.depth.lines[band]}
                strokeWidth={index ? 1.2 : 0.8}
                strokeOpacity={CONTOUR_OPACITY}
                strokeLinejoin="round"
              />
            );
          }),
        )}
        {water.map((body, i) => (
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed fixture
            key={i}
            d={pathOf(project, body.rings)}
            fillRule="evenodd"
            fill="none"
            stroke={
              body.selected
                ? palette.selected
                : body.hovered
                  ? palette.hovered
                  : body.inactive
                    ? palette.inactive.shore
                    : palette.water.shore
            }
            strokeWidth={body.selected ? 1.6 : body.hovered ? 1.4 : 1}
          />
        ))}
        {/* sub-area-scrim, sub-area-outline, sub-area-selected, landmark-label, sub-area-label */}
        {overlays.bay && bayLake && (
          <g>
            <path
              d={pathOf(project, bayLake.rings)}
              fillRule="evenodd"
              clipPath={`url(#${clipId}-rest)`}
              fill={palette.scrim}
              fillOpacity={0.75}
            />
            <path
              d={pathOf(project, bayLake.rings)}
              fillRule="evenodd"
              clipPath={`url(#${clipId}-rest)`}
              fill="none"
              stroke={palette.places.outline}
              strokeWidth={1}
              strokeOpacity={0.7}
              strokeDasharray="4 3"
            />
            <path
              d={lineOf(project, overlays.bay.chord)}
              fill="none"
              stroke={palette.places.outline}
              strokeWidth={1}
              strokeOpacity={0.7}
              strokeDasharray="4 3"
            />
            <path
              d={pathOf(project, bayLake.rings)}
              fillRule="evenodd"
              clipPath={`url(#${clipId}-bay)`}
              fill="none"
              stroke={palette.selected}
              strokeWidth={2}
            />
            <path
              d={lineOf(project, overlays.bay.chord)}
              fill="none"
              stroke={palette.selected}
              strokeWidth={2}
            />
          </g>
        )}
        {overlays.landmarks?.map((l) =>
          label(l.name, l.name, project([l.lng, l.lat]), palette.places.landmark, {
            size: 11,
            weight: 400,
          }),
        )}
        {overlays.bay?.names.map((b) =>
          label(b.name, b.name, project([b.lng, b.lat]), palette.places.label, {
            size: 11,
            weight: 500,
            spacing: 3,
            angle: b.angle,
            upper: true,
          }),
        )}
        {/* approach + approach-label (the walk in, amber, dashed), then track-line */}
        {overlays.approach && (
          <g>
            <path
              d={lineOf(project, overlays.approach.path)}
              fill="none"
              stroke={palette.hazard.healing}
              strokeWidth={2.5}
              strokeOpacity={0.9}
              strokeDasharray="5 5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {label(
              'walk',
              overlays.approach.label,
              (() => {
                const mid = overlays.approach.path[Math.floor(overlays.approach.path.length / 2)];
                const p = project(mid ?? [0, 0]);
                return { x: p.x, y: p.y - 12 };
              })(),
              palette.hazard.healing,
              { size: 12, weight: 500 },
            )}
          </g>
        )}
        {overlays.track && (
          <path
            d={lineOf(project, overlays.track)}
            fill="none"
            stroke={palette.track}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {/* hazard-fill, hazard-outline-provisional / -confirmed: over everything (D82) */}
        {overlays.hazards?.map((h) => (
          <path
            key={h.id}
            d={pathOf(project, [h.ring])}
            fill={hazardColor(h.tone)}
            fillOpacity={
              FRESHNESS_FILL_OPACITY[h.freshness] * (h.provisional ? PROVISIONAL_OPACITY_SCALE : 1)
            }
            stroke={hazardColor(h.tone)}
            strokeWidth={1.4}
            strokeDasharray={h.provisional ? '2 2' : undefined}
          />
        ))}
      </svg>
      {map && children(map)}
    </MapPane>
  );
}
