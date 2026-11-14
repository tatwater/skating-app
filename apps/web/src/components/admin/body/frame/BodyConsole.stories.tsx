import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { faceLoaded, must } from '@/components/kit/storyKit';
import { BodyBoard } from './bodyBoard';
import { CAPPED_HISTORY, NEIGHBOR_ID, NEIGHBOR_POLYGON } from './bodyFixtures';
import type { ReadFailure } from './consoleReads';
import { ReadFailed } from './kit-candidates/read-failed';

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
 * A body the record has no answer for yet: no stored completeness, no boundary around it, no one
 * vouching for its outline. Each is drawn as absent or *Not recorded yet* — never a zero, never a
 * guess, and never an amber square for a gap the record can't name.
 */
export const NotRecorded: Story = {
  name: 'Not recorded',
  args: { completeness: null, towns: null, trust: null },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(page.queryByText('Towns')).toBeNull();
    await expect(page.queryByText('Trusted')).toBeNull();
    await expect(page.getByText('Not recorded yet')).toBeVisible();
    await expect(page.queryByRole('meter', { name: /Complete/ })).toBeNull();
    await expect(canvasElement.querySelector('[data-slot="body-missing"]')).toBeNull();
    await expect(canvasElement.querySelector('[data-slot="tabs-flag"]')).toBeNull();
  },
};

const failure = (): ReadFailure => ({ failed: true, retry: fn() });

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
        <ReadFailed onRetry={fn()}>The map couldn’t read the bays and the lots</ReadFailed>
      </div>
    ),
  },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await faceLoaded(slot(canvasElement, 'record-lockup-name'));
    await expect(page.getByRole('heading', { level: 1, name: 'Mascoma Lake' })).toBeVisible();
    const notes = slots(canvasElement, 'read-failed');
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
