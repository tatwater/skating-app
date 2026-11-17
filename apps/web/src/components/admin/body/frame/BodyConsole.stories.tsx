import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useRef, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import type { ReadFailure } from '@/components/admin/reads/consoleReads';
import { computedColor, sameColor } from '@/components/kit/measure';
import { RetryNote } from '@/components/kit/retry-note';
import {
  expectControlsInside,
  expectNoSidewaysScroll,
  faceLoaded,
  must,
} from '@/components/kit/storyKit';
import { fitCamera } from '@/lib/mapSurface';
import { frameInRealBox, MAX_ZOOM } from '../map/bodyMapFraming';
import { FIT_PADDING } from '../map/useBodyMapCanvas';
import { BodyBoard } from './bodyBoard';
import { CAPPED_HISTORY, MASCOMA_BOUNDS, NEIGHBOR_ID, NEIGHBOR_POLYGON } from './bodyFixtures';
import { NOT_COMPUTED } from './bodyModel';

/**
 * Boards 5.4.1 Body | Shape and 5.4.1 Shape | Scrolled: the Body console as an admin first finds
 * it, in the console's frame at the boards' 1440 × 900, on the boards' day (14 Oct 2026). The map is
 * the still — the same chrome over an SVG of Mascoma's real dev outline. Render one beside its board
 * to compare.
 */
const meta = {
  title: 'Admin/Body/Console',
  component: BodyBoard,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof BodyBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));
const slots = (root: ParentNode, name: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`),
];

/** Board 5.4.1 — Shape, as an admin first finds it: no task, no mode. */
export const Shape: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await faceLoaded(slot(canvasElement, 'record-lockup-name'));
    await expect(page.getByRole('heading', { level: 1, name: 'Mascoma Lake' })).toBeVisible();
    // The tab grid: nine tabs, Shape open, the amber square on Water alone.
    const tabs = page.getAllByRole('tab');
    await expect(tabs.map((t) => t.textContent?.replace('(Missing something)', '').trim())).toEqual(
      ['Shape', 'Names', 'Places', 'Access', 'Water', 'Imagery', 'Hazards', 'Standing', 'Links'],
    );
    await expect(page.getByRole('tab', { name: /Shape/ })).toHaveAttribute('aria-selected', 'true');
    const flagged = tabs.filter((t) => t.querySelector('[data-slot="tabs-flag"]') !== null);
    await expect(flagged.map((t) => t.textContent)).toEqual(['Water(Missing something)']);
    // Completeness: 9 / 10, bathymetry missing, said in amber.
    await expect(page.getByRole('meter', { name: /Complete/ })).toHaveAttribute(
      'aria-valuenow',
      '9',
    );
    const missing = slot(canvasElement, 'body-missing');
    await expect(missing).toHaveTextContent('Missing bathymetry');
    await expect(getComputedStyle(missing).color).toEqual(
      sameColor(computedColor(missing, 'var(--warn)')),
    );
    // The map: the graticule labeled at its edges, the key listing what the map draws.
    const labels = slots(canvasElement, 'map-graticule-label').map((l) => l.textContent ?? '');
    await expect(labels.some((l) => /^43\.\d{2}°N$/.test(l))).toBe(true);
    await expect(labels.some((l) => /^72\.\d{2}°W$/.test(l))).toBe(true);
    const key = [...slot(canvasElement, 'map-key').querySelectorAll('li')].map(
      (li) => li.textContent,
    );
    await expect(key).toEqual([
      'Put-in',
      'Lot',
      'Island',
      'Beach',
      'Bridge',
      'Dam',
      'River',
      'Town',
      'Camp',
      'Point',
    ]);
    // The bays, named along their basins.
    const bayNames = slots(canvasElement, 'body-map-label').map((l) => l.textContent);
    await expect(bayNames).toEqual(['Mascoma North', 'Mascoma South']);
    // Shape's three ways to start a bay, each with its key.
    await expect(
      slots(canvasElement, 'bay-way').map((b) => b.getAttribute('aria-keyshortcuts')),
    ).toEqual(['C', 'F', 'P']);
  },
};

/**
 * Board 5.4.1 Shape | Scrolled — the left column scrolled: the lockup folds to the name and its kind
 * on one line over its rule; the figures, completeness and boost scroll away with the record. The
 * board's one hover plate is Relham Island.
 */
export const ShapeScrolled: Story = {
  name: 'Shape | Scrolled',
  args: { hoverId: 'landmark:lm0' },
  play: async ({ canvasElement }) => {
    await faceLoaded(slot(canvasElement, 'record-lockup-name'));
    const scroller = slot(canvasElement, 'body-left-scroll');
    scroller.scrollTop = 506;
    scroller.dispatchEvent(new Event('scroll'));
    await waitFor(() =>
      expect(slot(canvasElement, 'record-lockup')).toHaveAttribute('data-folded'),
    );
    const plate = slot(canvasElement, 'map-hover-plate');
    await expect(plate).toHaveTextContent('Island · OSM');
    await expect(plate).toHaveTextContent('Relham Island');
  },
};

/** Board 5.4.1 in the console's light map. */
export const ShapeLight: Story = {
  globals: { surface: 'admin', mode: 'light' },
  play: async ({ canvasElement }) => {
    const name = slot(canvasElement, 'record-lockup-name');
    await faceLoaded(name);
    await expect(getComputedStyle(name).color).toEqual(sameColor(computedColor(name, 'var(--fg)')));
  },
};

/** Board 5.4.1 Scrolled in the light map. */
export const ShapeScrolledLight: Story = {
  ...ShapeScrolled,
  name: 'Shape | Scrolled · Light',
  globals: { surface: 'admin', mode: 'light' },
};

/**
 * An ask opened from the left: ⏎ on it opens its tab with the ask lit, and focus moves into the
 * inspector, where the tab's keys listen.
 */
export const OpenAnAsk: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const list = page.getByRole('listbox', { name: 'Asked of this body' });
    list.focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    await waitFor(() =>
      expect(page.getByRole('tab', { name: /Places/ })).toHaveAttribute('aria-selected', 'true'),
    );
    await expect(page.getByRole('option', { name: /the flats by the dam/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await waitFor(() => expect(slot(canvasElement, 'body-tab-panel')).toHaveFocus());
    // Places isn't built in this story's frame: its slot says so and links the old editor.
    await expect(page.getByRole('link', { name: 'Old editor →' })).toBeVisible();
  },
};

/** A bay lit from the table is lit on the map as well. */
export const LitBay: Story = {
  args: { lit: 'bay:bay-north' },
  play: async ({ canvasElement }) => {
    const row = must(canvasElement.querySelector('tr[data-id="bay:bay-north"]'));
    await expect(row).toHaveAttribute('data-selected');
    await expect(
      must(canvasElement.querySelector('[data-id="bay:bay-north"][data-lit]')),
    ).toBeTruthy();
  },
};

/**
 * A body the record has no answer for yet: no stored completeness, its towns not computed yet, no
 * one vouching for its outline. Each is drawn as absent, *Not recorded yet* or *Not computed yet* —
 * never a zero, never a guess, never "in no town", and never an amber square for a gap the record
 * can't name.
 */
export const NotRecorded: Story = {
  name: 'Not recorded',
  args: { completeness: null, towns: NOT_COMPUTED, trust: null },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(page.getByText('Not computed yet')).toBeVisible();
    await expect(page.queryByText('In no town')).toBeNull();
    await expect(page.queryByText('Trusted')).toBeNull();
    await expect(page.getByText('Not recorded yet')).toBeVisible();
    await expect(page.queryByRole('meter', { name: /Complete/ })).toBeNull();
    await expect(canvasElement.querySelector('[data-slot="body-missing"]')).toBeNull();
    await expect(canvasElement.querySelector('[data-slot="tabs-flag"]')).toBeNull();
  },
};

const failure = (): ReadFailure => ({ failed: true, pending: false, retry: fn() });

/**
 * Every read beside the body's own failed: each block says so in its own place, with *Try again*,
 * and the record, the tabs and the map still stand.
 */
export const ReadsFailed: Story = {
  name: 'Reads failed',
  args: {
    completeness: failure(),
    towns: failure(),
    trust: failure(),
    asks: failure(),
    history: failure(),
    foot: (
      <div className="m-(--space-3) max-w-(--size-inspector) border border-solid border-line bg-panel p-(--space-2_5)">
        <RetryNote onRetry={fn()}>The map couldn’t read the bays and the lots</RetryNote>
      </div>
    ),
  },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await faceLoaded(slot(canvasElement, 'record-lockup-name'));
    await expect(page.getByRole('heading', { level: 1, name: 'Mascoma Lake' })).toBeVisible();
    // Every block's note is mounted; the ones that speak are the failures.
    const notes = slots(canvasElement, 'retry-note').filter((n) => n.textContent !== '');
    await expect(notes.map((n) => n.textContent?.replace('Try again', ''))).toEqual([
      'Completeness couldn’t be read',
      'The towns and the outline’s trust couldn’t be read',
      'What is asked of this body couldn’t be read',
      'The history couldn’t be read',
      'The map couldn’t read the bays and the lots',
    ]);
    // Gray, never red at rest: a failed read is something worth knowing.
    const note = must(notes[0]?.querySelector<HTMLElement>('[data-slot="note"]'));
    await expect(note).toHaveAttribute('data-tone', 'default');
    await userEvent.click(page.getAllByRole('button', { name: 'Try again' })[3] as HTMLElement);
    await expect((args.history as ReadFailure).retry).toHaveBeenCalledTimes(1);
  },
};

/** A very large lake: the history read always stops short, and the page never draws it as whole. */
export const CappedHistory: Story = {
  name: 'History capped',
  args: { history: CAPPED_HISTORY },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'body-history-head')).toHaveTextContent('Latest 6');
    await expect(slot(canvasElement, 'body-history-capped')).toHaveTextContent(
      'More history exists than is shown here.',
    );
  },
};

/**
 * Another body touches this one: the map draws it quiet and dashed beside the shore, and Shape
 * offers the merge (not built here yet), the touching body lit from its row.
 */
export const Touching: Story = {
  args: {
    lit: `neighbor:${NEIGHBOR_ID}`,
    tabScene: {
      items: [
        {
          kind: 'outline',
          id: `neighbor:${NEIGHBOR_ID}`,
          layer: 'outline',
          geometry: NEIGHBOR_POLYGON,
          style: 'neighbor',
        },
      ],
      lit: `neighbor:${NEIGHBOR_ID}`,
    },
    shape: {
      merge: {
        touching: [{ lit: `neighbor:${NEIGHBOR_ID}`, id: NEIGHBOR_ID, name: 'Crystal Lake' }],
        note: null,
      },
      // biome-ignore lint/a11y/useAnchorContent: the link takes its words from what renders it.
      bodyLink: (id) => <a href={`#body-${id}`} />,
    },
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const merge = page.getByRole('region', { name: 'Merge into another body' });
    await expect(within(merge).getByText('Crystal Lake')).toBeVisible();
    await expect(
      must(merge.querySelector(`tr[data-id="neighbor:${NEIGHBOR_ID}"]`)),
    ).toHaveAttribute('data-selected');
    await expect(within(merge).getByRole('button', { name: 'Choose a body' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  },
};

/** Everything on its way: each block holds its place. */
export const Loading: Story = {
  args: { loading: true },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-slot="record-lockup"]')).toBeNull();
    await expect(slots(canvasElement, 'skeleton').length).toBeGreaterThan(0);
  },
};

/** The record in, the frame's other reads on their way: completeness, towns and trust hold their places. */
export const ExtrasLoading: Story = {
  name: 'Extras loading',
  args: { extrasLoading: true },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(page.getByRole('heading', { level: 1, name: 'Mascoma Lake' })).toBeVisible();
    await expect(slot(canvasElement, 'body-complete')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByText('Towns')).toBeVisible();
    await expect(page.queryByText('Enfield, NH')).toBeNull();
  },
};

/**
 * A phone (360 px), with no board drawn for it yet: the console's narrow rule makes the page one pane
 * at a time — the body first, then the tabs or the map from its head, and back. Each pane takes the
 * page's width, nothing scrolls sideways, every control in it is inside the page, and focus moves
 * with the pane. Read afresh after every wait: nothing here holds a node across one.
 */
export const Phone: Story = {
  args: { bare: true, className: 'h-[52.75rem] w-[22.5rem]' },
  play: async ({ canvasElement }) => {
    const page = () => slot(canvasElement, 'body-console');
    const pane = (name: string) =>
      must(page().querySelector<HTMLElement>(`:scope > [data-pane="${name}"]`));
    const drawn = () =>
      ['body', 'map', 'inspector'].filter((n) => getComputedStyle(pane(n)).display !== 'none');
    const press = async (from: string, name: string) =>
      userEvent.click(within(pane(from)).getByRole('button', { name }));
    const whole = async (name: string) => {
      await expect(pane(name).getBoundingClientRect().width).toBeGreaterThanOrEqual(
        page().getBoundingClientRect().width - 1,
      );
      // The map key's row scrolls sideways on a phone by the kit's own design (never wraps).
      await expectNoSidewaysScroll(page(), { except: ['map-key'] });
      await expectControlsInside(page(), pane(name));
    };

    await waitFor(() => expect(page()).toHaveAttribute('data-narrow'));
    await faceLoaded(slot(canvasElement, 'record-lockup-name'));
    await expect(drawn()).toEqual(['body']);
    await whole('body');

    await press('body', 'Show the tabs');
    await waitFor(() => expect(drawn()).toEqual(['inspector']));
    await waitFor(() => expect(pane('inspector')).toHaveFocus());
    await expect(within(pane('inspector')).getAllByRole('tab')).toHaveLength(9);
    await whole('inspector');

    await press('inspector', 'Show the map');
    await waitFor(() => expect(drawn()).toEqual(['map']));
    await waitFor(() => expect(pane('map')).toHaveFocus());
    // The still is drawn at the pane's size once shown: the map has room, not a sliver.
    await waitFor(() =>
      expect(must(pane('map').querySelector('[data-slot="map-key"]'))).toBeVisible(),
    );
    await whole('map');

    await press('map', 'Back to the body');
    await waitFor(() => expect(drawn()).toEqual(['body']));
    await waitFor(() => expect(pane('body')).toHaveFocus());
  },
};

/** The phone in the light map. */
export const PhoneLight: Story = {
  ...Phone,
  name: 'Phone · Light',
  globals: { surface: 'admin', mode: 'light' },
};

/**
 * An ask opened on a phone: its tab takes the page, the ask lit, focus in the tab's panel — as at
 * the boards' width, with the body handing over the page.
 */
export const PhoneOpenAnAsk: Story = {
  name: 'Phone | Open an ask',
  args: { bare: true, className: 'h-[52.75rem] w-[22.5rem]' },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await waitFor(() => expect(slot(canvasElement, 'body-console')).toHaveAttribute('data-narrow'));
    page.getByRole('listbox', { name: 'Asked of this body' }).focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    await waitFor(() =>
      expect(page.getByRole('tab', { name: /Places/ })).toHaveAttribute('aria-selected', 'true'),
    );
    await waitFor(() => expect(slot(canvasElement, 'body-tab-panel')).toHaveFocus());
    await expect(getComputedStyle(slot(canvasElement, 'body-left')).display).toBe('none');
  },
};

/** The probe's controls, for the play: its map's load, which the story fires when it chooses. */
const PROBE = { load: () => {} };

/**
 * The map's framing over the pane's real box: a stand-in map whose container is the pane's own
 * element and whose resizes are the browser's (`ResizeObserver`, as MapLibre's), framed by the
 * console's one rule (`frameInRealBox`). Its zoom is written where the play can read it.
 */
function FramingProbe() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current as HTMLDivElement;
    const framed = { current: null as string | null };
    const map = {
      getContainer: () => el,
      setMinZoom: () => {},
      setMaxZoom: () => {},
      jumpTo: ({ zoom: z }: { zoom: number }) => setZoom(z),
    };
    let loaded = false;
    const observer = new ResizeObserver(() => {
      if (loaded) frameInRealBox(map, MASCOMA_BOUNDS, FIT_PADDING, framed);
    });
    observer.observe(el);
    PROBE.load = () => {
      loaded = true;
      frameInRealBox(map, MASCOMA_BOUNDS, FIT_PADDING, framed);
    };
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} data-slot="framing-probe" data-zoom={zoom ?? ''} className="size-full" />;
}

/**
 * Greptile's P1 on #144, over the real layout: the map's pane is left before its map loads, so the
 * load lands in a hidden pane — a box the browser measures zero. Nothing is framed then; shown
 * again, the body is framed for the pane's real size, once.
 */
export const PhoneMapLoadsHidden: Story = {
  name: 'Phone | Map loads hidden',
  args: { bare: true, className: 'h-[52.75rem] w-[22.5rem]', map: <FramingProbe /> },
  play: async ({ canvasElement }) => {
    const page = () => slot(canvasElement, 'body-console');
    const pane = (name: string) =>
      must(page().querySelector<HTMLElement>(`:scope > [data-pane="${name}"]`));
    const probe = () => slot(canvasElement, 'framing-probe');
    await waitFor(() => expect(page()).toHaveAttribute('data-narrow'));
    await userEvent.click(within(pane('body')).getByRole('button', { name: 'Show the map' }));
    await waitFor(() => expect(probe().clientWidth).toBeGreaterThan(0));
    await userEvent.click(within(pane('map')).getByRole('button', { name: 'Back to the body' }));
    await waitFor(() => expect(probe().clientWidth).toBe(0));
    PROBE.load();
    await expect(probe().dataset.zoom).toBe('');
    await userEvent.click(within(pane('body')).getByRole('button', { name: 'Show the map' }));
    await waitFor(() => expect(probe().dataset.zoom).not.toBe(''));
    const expected = fitCamera(
      MASCOMA_BOUNDS,
      probe().clientWidth,
      probe().clientHeight,
      FIT_PADDING,
    ).zoom;
    await expect(Number(probe().dataset.zoom)).toBeCloseTo(Math.min(MAX_ZOOM, expected), 6);
    // Framed for a real pane, not one pixel of room: past the zoom a 1 px box would give.
    await expect(Number(probe().dataset.zoom)).toBeGreaterThan(
      fitCamera(MASCOMA_BOUNDS, 1, 1, FIT_PADDING).zoom + 5,
    );
  },
};

/**
 * Going to another pane and back keeps each pane's place: a hidden box keeps its scroll in the
 * browser, and nothing here resets it, so the body's column (and its folded lockup) comes back where
 * the operator left it — a switch is not a tab change, which opens a tab at its top.
 */
export const PhoneKeepsThePlace: Story = {
  name: 'Phone | Coming back keeps the place',
  args: { bare: true, className: 'h-[52.75rem] w-[22.5rem]' },
  play: async ({ canvasElement }) => {
    const page = () => slot(canvasElement, 'body-console');
    const pane = (name: string) =>
      must(page().querySelector<HTMLElement>(`:scope > [data-pane="${name}"]`));
    const scroller = () => slot(canvasElement, 'body-left-scroll');
    await waitFor(() => expect(page()).toHaveAttribute('data-narrow'));
    await faceLoaded(slot(canvasElement, 'record-lockup-name'));
    scroller().scrollTop = 400;
    scroller().dispatchEvent(new Event('scroll'));
    await waitFor(() =>
      expect(slot(canvasElement, 'record-lockup')).toHaveAttribute('data-folded'),
    );
    const left = scroller().scrollTop;
    await expect(left).toBeGreaterThan(0);
    await userEvent.click(within(pane('body')).getByRole('button', { name: 'Show the tabs' }));
    await waitFor(() => expect(getComputedStyle(pane('inspector')).display).not.toBe('none'));
    await userEvent.click(
      within(pane('inspector')).getByRole('button', { name: 'Back to the body' }),
    );
    await waitFor(() => expect(getComputedStyle(pane('body')).display).not.toBe('none'));
    await waitFor(() => expect(scroller().scrollTop).toBeCloseTo(left, 0));
    await expect(slot(canvasElement, 'record-lockup')).toHaveAttribute('data-folded');
  },
};
