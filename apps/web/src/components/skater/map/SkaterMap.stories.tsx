import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { DEFAULT_MAP_LAYERS, useSkaterMapStore } from '@/stores/skaterMapStore';
import { LakeLabel } from './LakeLabel';
import { MapDockControls } from './MapDockControls';
import { MapMarksLayer } from './MapMarksLayer';
import type { HazardMarkModel, LakeLabelModel } from './mapDerive';
import { DOCK_CONTROLS, type DockControls } from './mapSpec';
import { MapStill, SkaterPair, type StillView } from './mapStill';
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
