import type { Meta, StoryObj } from '@storybook/react-vite';
import 'maplibre-gl/dist/maplibre-gl.css';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { type BandFeatureProperties, lakeBands } from '@/lib/depthBands';
import { FoldedAttributionControl } from '@/lib/mapAttribution';
import { OSM_ATTRIBUTION } from '@/lib/waterMap';
import { DEFAULT_MAP_LAYERS, useSkaterMapStore } from '@/stores/skaterMapStore';
import bandsStub from './fixtures/depthBands.stub.json';
import { LakeLabel } from './LakeLabel';
import { MapDockControls } from './MapDockControls';
import { MapMarksLayer } from './MapMarksLayer';
import type { HazardMarkModel, LakeLabelModel } from './mapDerive';
import { mapPalette } from './mapPalette';
import { DOCK_CONTROLS, type DockControls } from './mapSpec';
import { MapStill, SkaterPair, type StillView, stillBands } from './mapStill';
import { MASCOMA_INTERIOR, MASCOMA_PUT_INS, MASCOMA_RINGS, NEARBY_RINGS } from './mapStoryData';

/**
 * The region map's compositions (boards 1.1, 1.2, 3.16, 3.25), on the skater surface in both modes.
 * The water is a still drawn from the dev outlines; the labels, marks, legend and dock are the real
 * components, laid out by the same code the canvas runs. Real data: Mascoma 1,143 ac, Crystal Lake,
 * Smith Pond, George Pond (inactive on dev); the reports, bounties and the hazard are invented.
 */
const meta = {
  title: 'Skater/Map',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The persistent region map: lake labels (a dot on the interior point, a fixed 45° leader, slug over name, mirrored near the right edge), put-ins and hazard marks with ground halos, the depth legend and the dock. MapLibre itself needs WebGL, so the water here is a still from the dev outlines.',
      },
    },
  },
  beforeEach: () => {
    localStorage.clear();
    useSkaterMapStore.setState({ layers: { ...DEFAULT_MAP_LAYERS }, awayFromRegion: false });
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const AREA: StillView = { bounds: [-72.195, 43.565, -72.07, 43.655], width: 1000, height: 640 };
const LAKE: StillView = { bounds: [-72.19, 43.603, -72.115, 43.652], width: 1000, height: 640 };

const ALL_WATER = [
  { rings: MASCOMA_RINGS },
  { rings: NEARBY_RINGS['Crystal Lake'] ?? [] },
  { rings: NEARBY_RINGS['Smith Pond'] ?? [] },
  { rings: NEARBY_RINGS['George Pond'] ?? [], inactive: true },
];

const centerOf = (ring: readonly (readonly [number, number])[]) => {
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  return {
    lng: (Math.min(...xs) + Math.max(...xs)) / 2,
    lat: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
};

const label = (
  over: Partial<LakeLabelModel> & Pick<LakeLabelModel, 'id' | 'name' | 'anchor'>,
): LakeLabelModel => ({
  slug: null,
  favorite: false,
  openBounties: 0,
  inactive: false,
  dim: false,
  priority: 1,
  ...over,
});

/** Board 1.1's labels: two favorites, two open bounties, an inactive pond. */
const AREA_LABELS: LakeLabelModel[] = [
  label({
    id: 'mascoma',
    name: 'Mascoma Lake',
    anchor: MASCOMA_INTERIOR,
    slug: '3 reports · today',
    favorite: true,
    priority: 5,
  }),
  label({
    id: 'crystal',
    name: 'Crystal Lake',
    anchor: centerOf(NEARBY_RINGS['Crystal Lake']?.[0] ?? []),
    slug: '1 report · Tuesday',
    openBounties: 3,
    priority: 4,
  }),
  label({
    id: 'smith',
    name: 'Smith Pond',
    anchor: centerOf(NEARBY_RINGS['Smith Pond']?.[0] ?? []),
    slug: 'No recent reports',
    favorite: true,
    openBounties: 1,
    priority: 3,
  }),
  label({
    id: 'george',
    name: 'George Pond',
    anchor: centerOf(NEARBY_RINGS['George Pond']?.[0] ?? []),
    slug: 'Inactive',
    inactive: true,
    priority: 0,
  }),
];

/** The lead at the Narrows, by Shaker Bridge (board 1.2). */
const NARROWS: HazardMarkModel = {
  id: 'narrows',
  hazardType: 'open_water',
  lng: -72.1566,
  lat: 43.6322,
  tone: 'danger',
  provisional: false,
};

const dockFor = (on: readonly (typeof DOCK_CONTROLS)[number][]): DockControls =>
  Object.fromEntries(DOCK_CONTROLS.map((c) => [c, on.includes(c)])) as DockControls;

const dockProps = {
  onZoomIn: fn(),
  onZoomOut: fn(),
  onLocate: fn(),
  onReturnToRegion: fn(),
  lakeName: 'Mascoma Lake',
  contourCredit: 'NH GRANIT',
};

/** 1.1 — nothing chosen: the lakes in view, labeled. */
export const NothingChosen: Story = {
  render: () => (
    <SkaterPair>
      {(mode) => (
        <MapStill mode={mode} view={AREA} water={ALL_WATER}>
          {(map) => (
            <>
              <MapMarksLayer
                map={map}
                labels={AREA_LABELS}
                putIns={[]}
                hazards={[]}
                onOpenHazard={fn()}
              />
              <MapDockControls
                {...dockProps}
                controls={dockFor(['zoom', 'layers', 'locate'])}
                depthShown={false}
                lakeName={null}
              />
            </>
          )}
        </MapStill>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const [dark] = canvasElement.querySelectorAll<HTMLElement>('section');
    const canvas = within(dark as HTMLElement);
    await waitFor(() => expect(canvas.getByText('Mascoma Lake')).toBeVisible());
    // Bounties are counted as bounties, in an outline badge — never points, never solid.
    const badge = canvas.getByRole('img', { name: '3 open bounties' });
    expect(getComputedStyle(badge).borderTopStyle).toBe('solid');
    expect(canvas.getByRole('img', { name: '1 open bounty' })).toBeVisible();
    // No two labels overlap.
    const boxes = [...(dark as HTMLElement).querySelectorAll('[data-slot="lake-label-lockup"]')]
      .filter((el) => getComputedStyle(el.parentElement as Element).visibility !== 'hidden')
      .map((el) => el.getBoundingClientRect());
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        const apart =
          a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
        expect(apart).toBe(true);
      }
    }
    // The leader runs a fixed 16 px up and to the side from the dot.
    const mascoma = canvas
      .getByText('Mascoma Lake')
      .closest('[data-slot="lake-label"]') as HTMLElement;
    const lockup = mascoma.querySelector('[data-slot="lake-label-lockup"]') as HTMLElement;
    const anchor = mascoma.getBoundingClientRect();
    expect(lockup.getBoundingClientRect().bottom).toBeCloseTo(anchor.top - 16, 0);
    // The keyboard reaches the dock.
    await userEvent.tab();
    expect(canvas.getByRole('button', { name: 'Zoom in' })).toHaveFocus();
  },
};

/** 1.2 — Mascoma chosen: its put-ins, the known hazard, the legend and the imagery entry. */
export const LakeChosen: Story = {
  render: () => (
    <SkaterPair>
      {(mode) => (
        <MapStill mode={mode} view={LAKE} water={[{ rings: MASCOMA_RINGS, selected: true }]}>
          {(map) => (
            <>
              <MapMarksLayer
                map={map}
                labels={[]}
                putIns={MASCOMA_PUT_INS.map((p, i) => ({ id: String(i), ...p }))}
                hazards={[NARROWS]}
                onOpenHazard={fn()}
              />
              <MapDockControls
                {...dockProps}
                controls={dockFor(['zoom', 'layers', 'imagery', 'legend'])}
                onOpenImagery={fn()}
                depthShown
              />
            </>
          )}
        </MapStill>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.querySelector('section') as HTMLElement);
    const hazard = await canvas.findByRole('button', { name: 'Hazard: Open water / lead' });
    // A mark is 16 px, on a 20 px halo in the map's ground.
    const squares = hazard.querySelectorAll('rect');
    expect(squares[1]?.getAttribute('width')).toBe('16');
    expect(squares[0]?.getAttribute('width')).toBe('20');
    expect(canvas.getAllByRole('img', { name: /^Put-in/ })).toHaveLength(6);
    expect(canvas.getByRole('img', { name: /Depth bands/ })).toBeVisible();
    // The hazard mark is a stop on the keyboard path.
    hazard.focus();
    expect(hazard).toHaveFocus();
  },
};

/**
 * Over a satellite picture the hazard marks stay on at full strength; the one the mouse rests on fades
 * so the ice under it shows, and comes back on pointer-out (founder, 2026-11-08). The still has no
 * picture under it — the fade is the point.
 */
export const HazardPeekOverImagery: Story = {
  render: () => (
    <SkaterPair>
      {(mode) => (
        <MapStill mode={mode} view={LAKE} water={[{ rings: MASCOMA_RINGS, selected: true }]}>
          {(map) => (
            <MapMarksLayer
              map={map}
              labels={[]}
              putIns={[]}
              hazards={[NARROWS]}
              onOpenHazard={fn()}
              imagery
            />
          )}
        </MapStill>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.querySelector('section') as HTMLElement);
    const hazard = await canvas.findByRole('button', { name: 'Hazard: Open water / lead' });
    expect(hazard).not.toHaveAttribute('data-peek');
    // Keyboard focus inspects the mark: no fade.
    hazard.focus();
    expect(hazard).not.toHaveAttribute('data-peek');
    await userEvent.hover(hazard);
    await waitFor(() => expect(hazard).toHaveAttribute('data-peek'));
    await userEvent.unhover(hazard);
    await waitFor(() => expect(hazard).not.toHaveAttribute('data-peek'));
  },
};

/**
 * The stub band archive's Mascoma (the shape `BANDS.md` promises: `bodyId`, `bandIndex`,
 * `minDepthFt`, `maxDepthFt`, `lane`): four nested bands inset from the real dev outline, on the real
 * lake's 10 ft contours — so no band 1, and the deepest open-ended. The insets are invented, so this
 * shows how filled bands read, not where Mascoma is deep.
 */
const BANDS_FC = bandsStub as GeoJSON.FeatureCollection;
const MASCOMA_BANDS = stillBands(BANDS_FC, 'stub-mascoma');
const MASCOMA_LEGEND = lakeBands(
  BANDS_FC.features.map((f) => f.properties as Partial<BandFeatureProperties>),
);

/**
 * 1.2 with filled depth bands (B03 §2): the band polygons in the seven-band fills on the shallow
 * ground, each edge in its band's line, the hazard over all of it, and the legend reading the lake's
 * real band depths. Drawn from the stub archive, so it renders without the pipeline's tiles.
 */
export const Bands: Story = {
  render: () => (
    <SkaterPair>
      {(mode) => (
        <MapStill
          mode={mode}
          view={LAKE}
          water={[{ rings: MASCOMA_RINGS, selected: true, depthGround: true }]}
          bands={MASCOMA_BANDS}
        >
          {(map) => (
            <>
              <MapMarksLayer
                map={map}
                labels={[]}
                putIns={MASCOMA_PUT_INS.map((p, i) => ({ id: String(i), ...p }))}
                hazards={[NARROWS]}
                onOpenHazard={fn()}
              />
              <MapDockControls
                {...dockProps}
                controls={dockFor(['zoom', 'layers', 'imagery', 'legend'])}
                onOpenImagery={fn()}
                depthShown
                depthBands={MASCOMA_LEGEND}
              />
            </>
          )}
        </MapStill>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const sections = [...canvasElement.querySelectorAll('section')];
    expect(sections).toHaveLength(2);
    for (const [i, section] of sections.entries()) {
      const palette = mapPalette(i === 0 ? 'dark' : 'white');
      const bands = [...section.querySelectorAll<SVGPathElement>('path[data-band]')];
      // Every stub band, shallow first so the deeper one draws over it, in its own token fill —
      // keyed on `bandIndex`, so the missing band 1 leaves no gap in the colors.
      expect(bands.map((b) => b.dataset.band)).toEqual(['0', '2', '3', '4']);
      for (const b of bands) {
        expect(b.getAttribute('fill')).toBe(palette.depth.fills[Number(b.dataset.band)]);
      }
      // The lake under them is the shallowest band, not plain water.
      const ground = section.querySelector('svg path:not([data-band])');
      expect(ground?.getAttribute('fill')).toBe(palette.depth.fills[0]);
      expect(ground?.getAttribute('fill-opacity')).toBe('1');
      const canvas = within(section);
      expect(
        canvas.getByRole('img', { name: 'Depth bands: 0–10 ft, 10–20 ft, 20–30 ft, 30+ ft' }),
      ).toBeVisible();
      // The hazard still draws over the depth: the marks layer sits above the still's SVG.
      expect(
        await canvas.findByRole('button', { name: 'Hazard: Open water / lead' }),
      ).toBeVisible();
    }
  },
};

/** 3.16 — the layers menu, opened on a press. */
export const MapLayers: Story = {
  render: () => (
    <SkaterPair>
      {(mode) => (
        <MapStill mode={mode} view={LAKE} water={[{ rings: MASCOMA_RINGS, selected: true }]}>
          {() => (
            <MapDockControls {...dockProps} controls={dockFor(['zoom', 'layers'])} depthShown />
          )}
        </MapStill>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.querySelector('section') as HTMLElement);
    const trigger = canvas.getByRole('button', { name: 'Map layers' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const body = within(document.body);
    const tracks = await body.findByRole('switch', { name: /Tracks/ });
    expect(tracks).not.toBeChecked();
    // Hazards are locked on.
    const hazards = body.getByRole('switch', { name: /Hazards/ });
    expect(hazards).toBeChecked();
    await userEvent.click(hazards);
    expect(hazards).toBeChecked();
    await userEvent.click(tracks);
    expect(useSkaterMapStore.getState().layers.tracks).toBe(true);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(body.queryByRole('switch', { name: /Tracks/ })).toBeNull());
    expect(trigger).toHaveFocus();
  },
};

/** 3.25 — far out of the five states: the way back. */
export const ReturnToTheRegion: Story = {
  beforeEach: () => {
    useSkaterMapStore.setState({ awayFromRegion: true });
  },
  render: () => (
    <SkaterPair>
      {(mode) => (
        <MapStill mode={mode} view={AREA} water={[]}>
          {() => (
            <MapDockControls {...dockProps} controls={dockFor(['locate'])} depthShown={false} />
          )}
        </MapStill>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.querySelector('section') as HTMLElement);
    const back = canvas.getByRole('button', { name: /Back to the Northeast/ });
    expect(back.closest('[role="status"]')).toHaveAttribute('aria-live', 'polite');
    await userEvent.click(back);
    expect(dockProps.onReturnToRegion).toHaveBeenCalled();
  },
};

/** The label lockups on their own, every state, with the mirror. */
export const Labels: Story = {
  render: () => (
    <SkaterPair>
      {() => (
        <div
          className="relative h-[120px] w-[960px]"
          style={{ ['--lab-sh' as string]: 'var(--bg)' }}
        >
          {[
            { name: 'Mascoma Lake', slug: '3 reports · today', favorite: true },
            { name: 'Crystal Lake', slug: '1 report · Tuesday', openBounties: 3 },
            { name: 'George Pond', slug: 'Inactive', inactive: true },
            { name: 'Smith Pond', slug: null, dim: true },
            { name: 'Halfmile Pond', slug: 'No recent reports', mirrored: true },
          ].map((props, i) => (
            <LakeLabel
              key={props.name}
              {...props}
              style={{
                transform: `translate(${40 + i * 190 + (props.mirrored ? 150 : 0)}px, 90px)`,
              }}
            />
          ))}
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.querySelector('section') as HTMLElement);
    const halfmile = canvas
      .getByText('Halfmile Pond')
      .closest('[data-slot="lake-label"]') as HTMLElement;
    const anchor = halfmile.getBoundingClientRect();
    const lockup = (
      halfmile.querySelector('[data-slot="lake-label-lockup"]') as HTMLElement
    ).getBoundingClientRect();
    // Mirrored: the lockup ends 18 px left of the anchor.
    expect(lockup.right).toBeCloseTo(anchor.left - 18, 0);
    // Review 4: the dot has no border.
    expect(halfmile.querySelector('circle')?.getAttribute('stroke')).toBeNull();
  },
};

/**
 * The smallest map MapLibre's attribution control will run against: events, a style whose sources
 * carry credits, the UI-string lookup, a container to measure. The control itself is the real one.
 */
function creditsMap(credits: readonly string[]) {
  const handlers = new Map<string, Set<(e: unknown) => void>>();
  const tileManagers: Record<string, unknown> = {};
  const stub = {
    style: { stylesheet: {}, tileManagers },
    on: (event: string, fn: (e: unknown) => void) => {
      handlers.set(event, (handlers.get(event) ?? new Set()).add(fn));
      return stub;
    },
    off: (event: string, fn: (e: unknown) => void) => {
      handlers.get(event)?.delete(fn);
      return stub;
    },
    getCanvasContainer: () => document.createElement('div'),
    _getUIString: () => 'Toggle attribution',
    /** The sources load after the control mounts, as they do on the real map. */
    load: () => {
      credits.forEach((attribution, i) => {
        tileManagers[`s${i}`] = { used: true, getSource: () => ({ attribution }) };
      });
      for (const fn of handlers.get('sourcedata') ?? []) fn({ sourceDataType: 'metadata' });
    },
  };
  return stub;
}

/** The real folded control, docked bottom right over a still, as `useMapCanvas` mounts it. */
function MapCredits({ credits, open }: { credits: readonly string[]; open: boolean }) {
  const corner = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = corner.current;
    if (!el) return;
    const map = creditsMap(credits);
    const control = new FoldedAttributionControl();
    el.append(control.onAdd(map as unknown as maplibregl.Map));
    map.load();
    if (open) el.querySelector('summary')?.click();
    return () => control.onRemove();
  }, [credits, open]);
  return (
    // MapLibre's stylesheet pins `.maplibregl-map` to `position: relative`, so it fills a
    // positioned wrapper rather than being positioned itself.
    <div className="pointer-events-none absolute inset-0">
      <div className="maplibregl-map h-full w-full">
        <div ref={corner} className="maplibregl-ctrl-bottom-right" />
      </div>
    </div>
  );
}

const CREDITS = [OSM_ATTRIBUTION, 'Copernicus Sentinel data 2025–2026'] as const;
const CREDITS_VIEW: StillView = {
  bounds: [-72.19, 43.6, -72.12, 43.64],
  width: 480,
  height: 200,
};

/**
 * The map's credits, folded (how every map opens) and open, in both modes: the ⓘ takes the dock's
 * plate, line and control corner; the open credits sit on a square plate in the theme's text.
 */
export const Credits: Story = {
  render: () => (
    <SkaterPair>
      {(mode) => (
        <div className="flex flex-wrap gap-3">
          {[false, true].map((open) => (
            <div key={String(open)} data-credits={open ? 'open' : 'folded'}>
              <MapStill mode={mode} view={CREDITS_VIEW} water={[{ rings: MASCOMA_RINGS }]}>
                {() => <MapCredits credits={CREDITS} open={open} />}
              </MapStill>
            </div>
          ))}
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const [dark, light] = [...canvasElement.querySelectorAll<HTMLElement>('section')];
    const part = (section: HTMLElement | undefined, state: string) =>
      section?.querySelector(`[data-credits="${state}"] .maplibregl-ctrl-attrib`) as HTMLElement;
    const button = (attrib: HTMLElement) =>
      attrib.querySelector('.maplibregl-ctrl-attrib-button') as HTMLElement;
    const inner = (attrib: HTMLElement) =>
      attrib.querySelector('.maplibregl-ctrl-attrib-inner') as HTMLElement;

    const folded = part(dark, 'folded');
    const open = part(dark, 'open');
    await waitFor(() => expect(inner(open)).toBeVisible());
    // Folded: the ⓘ alone, the credits one press behind it — and the credit wording exact.
    expect(inner(folded)).not.toBeVisible();
    expect(inner(folded).textContent).toBe(CREDITS.join(' | '));
    expect(inner(open).textContent).toBe(CREDITS.join(' | '));
    // The ⓘ is a pressable (the control corner); the open credits are a plate (square).
    expect(getComputedStyle(button(folded)).borderTopLeftRadius).toBe('2px');
    expect(getComputedStyle(open).borderTopLeftRadius).toBe('0px');
    // On the theme, not MapLibre's white: the two modes draw the ⓘ and the plate differently,
    // and neither in white.
    const lightFolded = part(light, 'folded');
    const lightOpen = part(light, 'open');
    for (const [d, l] of [
      [button(folded), button(lightFolded)],
      [open, lightOpen],
    ] as const) {
      expect(getComputedStyle(d).backgroundColor).not.toBe('rgb(255, 255, 255)');
      expect(getComputedStyle(d).backgroundColor).not.toBe(getComputedStyle(l).backgroundColor);
    }
    expect(getComputedStyle(open).color).not.toBe(getComputedStyle(lightOpen).color);
    // A labeled disclosure on a native `<summary>`: focusable with no tabindex, so Tab reaches it,
    // and Enter/Space activate it as a click — the browser's own behavior, which a synthetic key
    // can't trigger here, so the press below is the click those keys become.
    const toggle = button(folded);
    expect(toggle.tagName).toBe('SUMMARY');
    expect(toggle).toHaveAccessibleName('Toggle attribution');
    toggle.focus();
    expect(toggle).toHaveFocus();
    await userEvent.click(toggle);
    await waitFor(() => expect(inner(folded)).toBeVisible());
    expect(folded).toHaveAttribute('open');
    await userEvent.click(toggle);
    await waitFor(() => expect(inner(folded)).not.toBeVisible());
    expect(folded).not.toHaveAttribute('open');
  },
};
