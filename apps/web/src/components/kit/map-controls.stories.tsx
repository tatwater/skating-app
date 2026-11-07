import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import {
  MapDock,
  MapHoverPlate,
  MapLayerRack,
  MapModeBar,
  MapPane,
  MapScaleBar,
  MapZoom,
  scaleStop,
} from './map-controls';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx, sameColor } from './measure';
import { must } from './storyKit';
import { SwitchRow } from './switch';

const meta = {
  title: 'Kit/MapControls',
  component: MapPane,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The chrome a map pane docks: the layer rack (switch rows on plates), the ice mode bar for a transient mode, the dock 56 px up (the scale bar on the map, then the zoom pair) and the one hover plate. Pure DOM and SVG — the stories lay it over a still of Mascoma Lake drawn from its real outline.',
      },
    },
  },
} satisfies Meta<typeof MapPane>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── The still: Mascoma Lake, from its dev outline (decimated) and its three islands ────────────

/** The outer shore, [lng, lat] — every second vertex of the dev outline (2026-10-13). */
const SHORE: ReadonlyArray<readonly [number, number]> = [
  [-72.18195, 43.6493],
  [-72.1819, 43.64893],
  [-72.18126, 43.64841],
  [-72.18075, 43.64729],
  [-72.17977, 43.64643],
  [-72.17947, 43.64599],
  [-72.17698, 43.64438],
  [-72.17587, 43.64356],
  [-72.17354, 43.64321],
  [-72.17113, 43.64239],
  [-72.16928, 43.64142],
  [-72.16762, 43.64027],
  [-72.16823, 43.6392],
  [-72.1682, 43.63846],
  [-72.16689, 43.63771],
  [-72.16591, 43.63766],
  [-72.16567, 43.63722],
  [-72.16518, 43.63641],
  [-72.16505, 43.63504],
  [-72.16303, 43.6337],
  [-72.16028, 43.63251],
  [-72.1581, 43.63118],
  [-72.15739, 43.6314],
  [-72.15687, 43.63186],
  [-72.1572, 43.63105],
  [-72.15559, 43.62939],
  [-72.15075, 43.62423],
  [-72.14709, 43.62283],
  [-72.14528, 43.62265],
  [-72.14449, 43.6219],
  [-72.14287, 43.62074],
  [-72.14189, 43.61914],
  [-72.14171, 43.6172],
  [-72.14065, 43.61588],
  [-72.13954, 43.61513],
  [-72.1386, 43.61391],
  [-72.13688, 43.61172],
  [-72.13602, 43.61056],
  [-72.13391, 43.61061],
  [-72.1333, 43.61021],
  [-72.13108, 43.6091],
  [-72.131, 43.60737],
  [-72.12951, 43.60623],
  [-72.1289, 43.6062],
  [-72.12535, 43.60656],
  [-72.12505, 43.60657],
  [-72.12317, 43.60712],
  [-72.12125, 43.60845],
  [-72.1207, 43.6092],
  [-72.12073, 43.60956],
  [-72.12231, 43.61072],
  [-72.12462, 43.61188],
  [-72.12819, 43.6147],
  [-72.12823, 43.6153],
  [-72.12769, 43.61611],
  [-72.12812, 43.61741],
  [-72.12964, 43.61802],
  [-72.13072, 43.61894],
  [-72.13141, 43.62055],
  [-72.13352, 43.62192],
  [-72.13514, 43.62368],
  [-72.13645, 43.62433],
  [-72.13849, 43.62443],
  [-72.13886, 43.62465],
  [-72.13764, 43.6253],
  [-72.13753, 43.62599],
  [-72.1372, 43.62633],
  [-72.13702, 43.62711],
  [-72.13725, 43.62779],
  [-72.13688, 43.62805],
  [-72.13898, 43.62975],
  [-72.1423, 43.6327],
  [-72.14348, 43.63436],
  [-72.14514, 43.63497],
  [-72.14857, 43.63688],
  [-72.14983, 43.63839],
  [-72.14995, 43.63921],
  [-72.15059, 43.6391],
  [-72.1523, 43.63726],
  [-72.15262, 43.6362],
  [-72.15533, 43.63371],
  [-72.15628, 43.63263],
  [-72.15657, 43.63267],
  [-72.15597, 43.63371],
  [-72.1563, 43.63409],
  [-72.15816, 43.63488],
  [-72.16002, 43.63557],
  [-72.16187, 43.63592],
  [-72.16202, 43.63687],
  [-72.1623, 43.64272],
  [-72.16297, 43.64429],
  [-72.16413, 43.64538],
  [-72.16579, 43.64631],
  [-72.16824, 43.64646],
  [-72.16977, 43.64723],
  [-72.17065, 43.64746],
  [-72.17393, 43.64758],
  [-72.17485, 43.64802],
  [-72.17661, 43.6484],
  [-72.17811, 43.64893],
  [-72.17986, 43.64955],
  [-72.18164, 43.64969],
];

const ISLANDS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [
    [-72.14371, 43.6305],
    [-72.1437, 43.63076],
    [-72.14352, 43.63089],
    [-72.14296, 43.63102],
    [-72.14272, 43.63098],
    [-72.14254, 43.63086],
    [-72.14232, 43.63031],
    [-72.1423, 43.63014],
    [-72.14245, 43.62977],
    [-72.14261, 43.62964],
    [-72.14336, 43.62975],
    [-72.14363, 43.62999],
  ],
  [
    [-72.14246, 43.62936],
    [-72.14228, 43.62953],
    [-72.14193, 43.62953],
    [-72.14147, 43.62965],
    [-72.14123, 43.6296],
    [-72.1406, 43.62879],
    [-72.14064, 43.62867],
    [-72.14088, 43.62851],
    [-72.1416, 43.62853],
    [-72.14186, 43.6287],
  ],
  [
    [-72.14001, 43.62513],
    [-72.13987, 43.62507],
    [-72.13947, 43.6253],
    [-72.1392, 43.62522],
    [-72.13879, 43.62544],
    [-72.13855, 43.62546],
    [-72.13857, 43.6252],
    [-72.13911, 43.62483],
    [-72.13994, 43.62498],
  ],
];

/** Named places on the lake (the dev landmarks), with their kind as the boards word it. */
const PLACES = [
  { name: 'Relham Island', kind: 'Island', lng: -72.1415285, lat: 43.6290789 },
  { name: 'Wood Island', kind: 'Island', lng: -72.13927585, lat: 43.625133 },
  { name: 'Shakoma Beach', kind: 'Beach', lng: -72.15783615, lat: 43.63109335 },
  { name: 'Mascoma River', kind: 'River', lng: -72.1498318, lat: 43.6390583 },
  { name: 'Lower Shaker Village', kind: 'Town', lng: -72.1467793, lat: 43.6217278 },
] as const;

const BBOX = { minLng: -72.1819521, maxLng: -72.1206902, minLat: 43.6061979, maxLat: 43.6497901 };
const MID_LAT = (BBOX.minLat + BBOX.maxLat) / 2;
const COS = Math.cos((MID_LAT * Math.PI) / 180);
/** Meters in a degree of latitude. */
const M_PER_DEG = 111_320;

/** An equirectangular fit of the lake into a `w` × `h` field, padded. */
function project(w: number, h: number, pad: number) {
  const k = Math.min(
    (w - 2 * pad) / ((BBOX.maxLng - BBOX.minLng) * COS),
    (h - 2 * pad) / (BBOX.maxLat - BBOX.minLat),
  );
  const ox = (w - (BBOX.maxLng - BBOX.minLng) * COS * k) / 2;
  const oy = (h - (BBOX.maxLat - BBOX.minLat) * k) / 2;
  return {
    x: (lng: number) => ox + (lng - BBOX.minLng) * COS * k,
    y: (lat: number) => oy + (BBOX.maxLat - lat) * k,
    /** Meters per px: a px is 1/k of a degree of latitude. */
    mpp: M_PER_DEG / k,
  };
}

const ringPath = (ring: ReadonlyArray<readonly [number, number]>, p: ReturnType<typeof project>) =>
  `M${ring.map(([lng, lat]) => `${p.x(lng).toFixed(1)} ${p.y(lat).toFixed(1)}`).join(' L')} Z`;

/** The pane's size in a story: 720 × 520 at the default root size. */
const W = 720;
const H = 520;
/** The foot strip and the longitude label line above it (the boards' 30 px foot). */
const FOOT = 30;

/**
 * The still a story lays the controls over: the field, the shore and islands, the graticule
 * labels (latitudes up the right, longitudes along the bottom, the full width — which is why the
 * dock sits 56 px up), the place marks and the foot strip with its symbol key.
 */
function MapStill({ hovered }: { hovered?: string }) {
  const p = project(W, H - FOOT - 24, 64);
  const lngs = [-72.18, -72.17, -72.16, -72.15, -72.14, -72.13];
  const lats = [43.61, 43.62, 43.63, 43.64];
  return (
    <>
      <svg
        aria-hidden="true"
        data-slot="map-still"
        viewBox={`0 0 ${W} ${H}`}
        className="absolute inset-0 size-full font-(family-name:--family-mono) text-kick"
      >
        <path d={ringPath(SHORE, p)} fill="var(--panel)" stroke="var(--fg2)" strokeWidth={1} />
        {ISLANDS.map((ring) => (
          <path
            key={ring[0]?.join()}
            d={ringPath(ring, p)}
            fill="var(--bg)"
            stroke="var(--fg2)"
            strokeWidth={1}
          />
        ))}
        {PLACES.map((pl) => (
          <rect
            key={pl.name}
            x={p.x(pl.lng) - 3}
            y={p.y(pl.lat) - 3}
            width={6}
            height={6}
            fill={pl.name === hovered ? 'var(--fg)' : 'var(--fg3)'}
          />
        ))}
        {lats.map((lat) => (
          <text key={lat} x={W - 12} y={p.y(lat)} textAnchor="end" fill="var(--fg3)">
            {lat.toFixed(2)}°
          </text>
        ))}
        {lngs.map((lng) => (
          <text key={lng} x={p.x(lng)} y={H - FOOT - 12} textAnchor="middle" fill="var(--fg3)">
            {lng.toFixed(2)}°
          </text>
        ))}
      </svg>
      <div
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 flex items-center gap-(--space-3) border-t border-line bg-map-foot px-(--space-3) text-kick tracking-micro text-fg3 uppercase"
        style={{ height: FOOT }}
      >
        <span>Island</span>
        <span>Beach</span>
        <span>Town</span>
        <span className="ms-auto font-(family-name:--family-mono)">Z 13.4</span>
      </div>
    </>
  );
}

/** The point a place lands on in the story's pane. */
function placePoint(name: string) {
  const p = project(W, H - FOOT - 24, 64);
  const pl = must(PLACES.find((x) => x.name === name));
  return { x: p.x(pl.lng), y: p.y(pl.lat) };
}

const STILL_MPP = project(W, H - FOOT - 24, 64).mpp;

/** The Body board's layers: four on, the rest off, Bathy disabled (Mascoma has no survey). */
function Rack({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <MapLayerRack collapsed={collapsed}>
      <SwitchRow label="Outline" kbd="1" defaultChecked />
      <SwitchRow label="Bays" kbd="2" defaultChecked />
      <SwitchRow label="Marks" kbd="3" defaultChecked />
      <SwitchRow label="Put-ins" kbd="4" defaultChecked />
      <SwitchRow label="Samples" kbd="5" />
      <SwitchRow label="Hazards" kbd="6" />
      <SwitchRow label="Features" kbd="7" />
      <SwitchRow label="Tracks" kbd="8" />
      <SwitchRow label="Aerial" kbd="⌥A" />
      <SwitchRow label="Bathy" kbd="⌥B" disabled />
    </MapLayerRack>
  );
}

function Board({
  mode = false,
  collapsed = false,
  hover = 'Relham Island',
  onExit,
  onZoomIn,
  onZoomOut,
}: {
  mode?: boolean;
  collapsed?: boolean;
  hover?: string | null;
  onExit?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
}) {
  const place = hover === null ? undefined : PLACES.find((pl) => pl.name === hover);
  return (
    <MapPane style={{ width: W, height: H }}>
      <MapStill {...(place ? { hovered: place.name } : {})} />
      {mode && (
        <MapModeBar
          mode="Measure"
          step="Step 2 of 3"
          {...(onExit ? { onExit } : {})}
          exitLabel="Leave Measure"
        >
          Click the second point
        </MapModeBar>
      )}
      <Rack collapsed={collapsed} />
      <MapDock>
        <MapScaleBar metersPerPixel={STILL_MPP} />
        <MapZoom {...(onZoomIn ? { onZoomIn } : {})} {...(onZoomOut ? { onZoomOut } : {})} />
      </MapDock>
      <MapHoverPlate
        at={place ? placePoint(place.name) : null}
        title={place ? `${place.kind} · OSM` : undefined}
      >
        {place?.name}
      </MapHoverPlate>
    </MapPane>
  );
}

const pane = (el: HTMLElement) => must(el.querySelector<HTMLElement>('[data-slot="map-pane"]'));
const slot = (el: Element, name: string) =>
  must(el.querySelector<HTMLElement>(`[data-slot="${name}"]`));
const near = (a: number, b: number) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);

// ── The board ────────────────────────────────────────────────────────────────────────────────

/**
 * The Body board's map at rest: the rack top left, the dock 56 px up at the right (scale, then
 * zoom), and the one hover plate over Relham Island.
 */
export const Rest: Story = {
  render: () => <Board />,
  play: async ({ canvasElement }) => {
    const root = pane(canvasElement);
    const box = root.getBoundingClientRect();
    // The rack: 8 rem wide, `space-5` in, rows `btn-sm` tall and 3 px apart.
    const rack = slot(root, 'map-layer-rack');
    const rows = [...rack.querySelectorAll<HTMLElement>('[data-slot="switch-row"]')];
    await expect(rows).toHaveLength(10);
    const r = rack.getBoundingClientRect();
    near(r.width, resolvePx(root, '8rem'));
    near(r.left - box.left, resolvePx(root, 'var(--space-5)'));
    near(r.top - box.top, resolvePx(root, 'var(--space-5)'));
    const rowH = resolvePx(root, 'var(--size-btn-sm)');
    for (const row of rows) near(row.getBoundingClientRect().height, rowH);
    for (let i = 1; i < rows.length; i++)
      near(
        must(rows[i]).getBoundingClientRect().top -
          must(rows[i - 1]).getBoundingClientRect().bottom,
        3,
      );
    // The dock: 56 px up from the pane's foot, `space-2_5` in from its right.
    const dock = slot(root, 'map-dock').getBoundingClientRect();
    near(box.bottom - dock.bottom, resolvePx(root, 'var(--space-14)'));
    near(box.right - dock.right, resolvePx(root, 'var(--space-2_5)'));
    // The scale bar is bottom-aligned with the zoom pair and `space-3` left of it.
    const scale = slot(root, 'map-scale').getBoundingClientRect();
    const zoom = must(root.querySelector<HTMLElement>('[data-map-zoom]')).getBoundingClientRect();
    near(scale.bottom, zoom.bottom);
    near(zoom.left - scale.right, resolvePx(root, 'var(--space-3)'));
    // The zoom pair: one small button wide, two tall less the shared hairline.
    const btn = resolvePx(root, 'var(--size-btn-sm)');
    const hair = resolvePx(root, 'var(--stroke-hair)');
    near(zoom.width, btn);
    near(zoom.height, 2 * btn - hair);
    // One hover plate, on the map plate's ground.
    const plates = root.querySelectorAll('[data-slot="map-hover-plate"]');
    await expect(plates).toHaveLength(1);
    const ground = computedColor(root, 'var(--map-plate)');
    await expect(getComputedStyle(must(plates[0])).backgroundColor).toEqual(sameColor(ground));
    await expect(must(plates[0]).textContent).toContain('Relham Island');
  },
};

/** A layer toggles by a press or by Space; the disabled layer keeps its key and ignores both. */
export const ToggleLayers: Story = {
  render: () => <Board hover={null} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const hazards = canvas.getByRole('switch', { name: 'Hazards' });
    await userEvent.click(hazards);
    await expect(hazards).toHaveAttribute('aria-checked', 'true');
    hazards.focus();
    await userEvent.keyboard(' ');
    await expect(hazards).toHaveAttribute('aria-checked', 'false');
    const bathy = canvas.getByRole('switch', { name: 'Bathy' });
    await expect(bathy).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(bathy, { pointerEventsCheck: 0 });
    await expect(bathy).toHaveAttribute('aria-checked', 'false');
    // The rack is a named group of switches; no hover plate when nothing is hovered.
    await expect(canvas.getByRole('group', { name: 'Map layers' })).toBeVisible();
    await expect(canvasElement.querySelector('[data-slot="map-hover-plate"]')).toBeNull();
  },
};

/**
 * A transient mode: the ice band across the top, the rack dropped under it. Esc's cap is a
 * button (the pane binds Escape to the same call).
 */
export const ModeActive: Story = {
  args: { onClick: fn() },
  render: (args) => <Board mode hover={null} onExit={args.onClick as () => void} />,
  play: async ({ canvasElement, args }) => {
    const root = pane(canvasElement);
    const box = root.getBoundingClientRect();
    const bar = slot(root, 'map-mode-bar');
    const b = bar.getBoundingClientRect();
    near(b.top - box.top, resolvePx(root, 'var(--space-3_5)'));
    near(b.height, resolvePx(root, '1.875rem'));
    near(b.left - box.left, resolvePx(root, 'var(--space-5)'));
    near(box.right - b.right, resolvePx(root, 'var(--space-5)'));
    // Ice: the edge and the mode's name. A mode, never a verdict.
    const ice = computedColor(root, 'var(--acc)');
    await expect(getComputedStyle(bar).borderTopColor).toEqual(sameColor(ice));
    await expect(getComputedStyle(slot(bar, 'map-mode-bar-mode')).color).toEqual(sameColor(ice));
    await expect(slot(bar, 'map-mode-bar-mode').textContent).toBe('Measure');
    // The rack sits 16 px under the band: 60 px down on the console.
    const rack = slot(root, 'map-layer-rack').getBoundingClientRect();
    near(rack.top - b.bottom, resolvePx(root, 'var(--space-4)'));
    // Leaving: the cap is a named button, reachable by Tab, pressed by Enter.
    const exit = within(bar).getByRole('button', { name: 'Leave Measure' });
    await expect(exit).toHaveAttribute('aria-keyshortcuts', 'Escape');
    exit.focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onClick).toHaveBeenCalledOnce();
  },
};

/**
 * The rack collapsed: switches only, an even pad; a row's name and key come back while it's
 * hovered or focused. Every switch keeps its name for a reader.
 */
export const Collapsed: Story = {
  render: () => <Board collapsed hover={null} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rack = slot(canvasElement, 'map-layer-rack');
    const outline = canvas.getByRole('switch', { name: 'Outline' });
    const track = slot(outline, 'switch-track').getBoundingClientRect();
    const narrow = rack.getBoundingClientRect().width;
    // The row is the switch and its pad: much narrower than the open rack's 8 rem.
    await expect(narrow).toBeLessThan(resolvePx(rack, '4rem'));
    await expect(narrow).toBeGreaterThan(track.width);
    await expect(getComputedStyle(slot(outline, 'kbd')).display).toBe('none');
    // Focus brings the name back.
    outline.focus();
    await waitFor(() =>
      expect(slot(outline, 'switch-label').getBoundingClientRect().width).toBeGreaterThan(10),
    );
    await expect(getComputedStyle(slot(outline, 'kbd')).display).not.toBe('none');
    outline.blur();
  },
};

/**
 * The zoom pair is one tab stop: ↓ moves to Zoom out, Enter presses it. At the widest zoom the
 * out button rests disabled and focus skips it.
 */
export const Zoom: Story = {
  args: { onClick: fn(), onDoubleClick: fn() },
  render: (args) => (
    <div className="flex items-start gap-(--space-6) p-(--space-4)">
      <MapZoom onZoomIn={args.onClick as () => void} onZoomOut={args.onDoubleClick as () => void} />
      <MapZoom aria-label="Zoom at the widest" atMin />
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const [zin, zout] = canvas.getAllByRole('button', { name: /Zoom (in|out)/ });
    await userEvent.tab();
    await expect(zin).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(zout).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onDoubleClick).toHaveBeenCalledOnce();
    await userEvent.keyboard('{ArrowDown}');
    await expect(zin).toHaveFocus();
    await userEvent.keyboard(' ');
    await expect(args.onClick).toHaveBeenCalledOnce();
    const widest = canvas.getByRole('group', { name: 'Zoom at the widest' });
    await expect(within(widest).getByRole('button', { name: 'Zoom out' })).toBeDisabled();
  },
};

const MPPS = [0.6, 2.4, 9, 26, 60] as const;

/**
 * The scale bar at five zooms: the longest round distance (1, 2 or 5 × 10ⁿ m) that fits 96 px.
 * A hairline bracket, its mono label over it.
 */
export const ScaleSteps: Story = {
  render: () => (
    <div className="flex flex-col items-end gap-(--space-4) p-(--space-4)">
      {MPPS.map((mpp) => (
        <MapScaleBar key={mpp} metersPerPixel={mpp} />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const bars = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="map-scale"]')];
    await expect(bars.map((b) => slot(b, 'map-scale-label').textContent)).toEqual([
      '50 M',
      '200 M',
      '500 M',
      '2 KM',
      '5 KM',
    ]);
    const hair = resolvePx(canvasElement, 'var(--stroke-hair)');
    for (const [i, bar] of bars.entries()) {
      const stop = scaleStop(must(MPPS[i]), 96);
      const path = must(bar.querySelector('path'));
      await expect(Number(path.getAttribute('stroke-width'))).toBe(hair);
      await expect(path).not.toHaveAttribute('stroke-opacity');
      // The bar is the distance's true length (plus the hairline the ends sit on).
      near(slot(bar, 'map-scale-bar').getBoundingClientRect().width, stop.px + hair);
      await expect(stop.px).toBeLessThanOrEqual(96);
      await expect(getComputedStyle(slot(bar, 'map-scale-label')).fontFamily).toMatch(
        /Martian Mono/,
      );
    }
    await expect(bars[3]).toHaveAccessibleName('Scale: 2 kilometers');
  },
};

/**
 * All four maps: the rack, the zoom pair, the scale and the mode bar over a small field. The
 * plates follow each map (black under the dark, white under the light); the sizes follow each
 * surface.
 */
export const FourUp: Story = {
  render: () => (
    <MapPane className="h-[22rem] w-full min-w-[22rem]">
      <MapModeBar mode="Compare" step="2 winters">
        Pick a second winter
      </MapModeBar>
      <MapLayerRack>
        <SwitchRow label="Outline" kbd="1" defaultChecked />
        <SwitchRow label="Hazards" kbd="6" />
        <SwitchRow label="Bathy" kbd="⌥B" disabled />
      </MapLayerRack>
      <MapDock>
        <MapScaleBar metersPerPixel={9} />
        <MapZoom />
      </MapDock>
      <MapHoverPlate at={{ x: 180, y: 250 }} title="Island · OSM">
        Wood Island
      </MapHoverPlate>
    </MapPane>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const btn = resolvePx(q, 'var(--size-btn-sm)');
      const zoom = must(q.querySelector<HTMLElement>('[data-map-zoom]')).getBoundingClientRect();
      near(zoom.height, 2 * btn - resolvePx(q, 'var(--stroke-hair)'));
      for (const row of q.querySelectorAll('[data-slot="switch-row"]'))
        near(row.getBoundingClientRect().height, btn);
      const plate = slot(q, 'map-hover-plate');
      await expect(getComputedStyle(plate).backgroundColor).toEqual(
        sameColor(computedColor(q, 'var(--map-plate)')),
      );
      const ice = computedColor(q, 'var(--acc)');
      await expect(getComputedStyle(slot(q, 'map-mode-bar')).borderTopColor).toEqual(
        sameColor(ice),
      );
    }
  },
};

/** A story-local state for the founder to click through: zoom moves the scale. */
export const Live: Story = {
  render: function Live() {
    const [z, setZ] = useState(0);
    const mpp = STILL_MPP / 2 ** z;
    return (
      <MapPane style={{ width: W, height: H }}>
        <MapStill />
        <Rack />
        <MapDock>
          <MapScaleBar metersPerPixel={mpp} />
          <MapZoom
            onZoomIn={() => setZ((v) => v + 1)}
            onZoomOut={() => setZ((v) => v - 1)}
            atMax={z >= 3}
            atMin={z <= -2}
          />
        </MapDock>
      </MapPane>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = () => slot(canvasElement, 'map-scale-label').textContent;
    const before = label();
    await userEvent.click(canvas.getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(label()).not.toBe(before));
  },
};
