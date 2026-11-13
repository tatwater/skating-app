import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { Button } from '@/components/kit/button';
import { computedColor, sameColor } from '@/components/kit/measure';
import { faceLoaded, must } from '@/components/kit/storyKit';

import { InspectorFrame } from '../tabStoryFrame';
import { WaterView } from './WaterView';
import { CHAMPLAIN_WATER, MASCOMA_WATER, MASCOMA_WATER_AS_READ } from './waterFixtures';

/**
 * Board 5.4.5, Body › Water: the tab's column at the board's size. Render `Board` beside
 * `body-v5.html?tab=water` (x 1060–1440, y 178–870) to compare.
 */
const meta = {
  title: 'Admin/Body/Water',
  component: WaterView,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  render: (args) => (
    <InspectorFrame>
      <WaterView {...args} />
    </InspectorFrame>
  ),
} satisfies Meta<typeof WaterView>;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));

/** Board 5.4.5 as drawn, with the two edits the board shows. */
export const Board: Story = {
  args: {
    data: MASCOMA_WATER,
    onChooseDepth: fn(),
    onSurvey: fn(),
    enrichmentLink: (
      <Button variant="link" size="xs">
        Enrichment
      </Button>
    ),
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await faceLoaded(slot(canvasElement, 'depth-source'));
    // Two columns of choices; the state survey is Now in both.
    const mean = within(slot(canvasElement, 'depth-mean')).getAllByRole('radio');
    const max = within(slot(canvasElement, 'depth-max')).getAllByRole('radio');
    await expect(mean.map((r) => r.textContent)).toEqual(['Now9.4m', '~8.1m']);
    await expect(max.map((r) => r.textContent)).toEqual(['Now24m', '23m', '22m']);
    await expect(mean[0]).toBeChecked();
    // A modeled source reads as an estimate.
    await expect(page.getByText('Modeled · an estimate')).toBeVisible();
    // The interior point, and why one point is enough.
    await expect(slot(canvasElement, 'sampling')).toHaveTextContent('43.6174°N 72.1360°W');
    await expect(slot(canvasElement, 'sampling')).toHaveTextContent(
      'Mascoma Lake is 4.9 km across',
    );
    // The gap turns the bathymetry chip amber.
    const chip = slot(slot(canvasElement, 'bathymetry'), 'section-chip');
    await expect(getComputedStyle(chip).backgroundColor).toEqual(
      sameColor(computedColor(chip, 'var(--warn)')),
    );
  },
};

/** Picking another source moves the pick; the button that names it applies it. */
export const ChooseASource: Story = {
  args: { data: MASCOMA_WATER, onChooseDepth: fn() },
  play: async ({ canvasElement, args }) => {
    const max = within(slot(canvasElement, 'depth-max'));
    await userEvent.click(max.getByRole('radio', { name: /LAGOS-US DEPTH/ }));
    await expect(args.onChooseDepth).not.toHaveBeenCalled();
    await userEvent.click(within(canvasElement).getByRole('button', { name: /for the max/ }));
    await expect(args.onChooseDepth).toHaveBeenCalledWith('max', 'lagos_us');
  },
};

/** Filing a survey for the next build. */
export const FileASurvey: Story = {
  args: { data: MASCOMA_WATER, onSurvey: fn() },
  play: async ({ canvasElement, args }) => {
    const field = within(canvasElement).getByRole('textbox', { name: /survey/ });
    await userEvent.type(field, 'NH Fish & Game bathymetry, 1998{Enter}');
    await expect(args.onSurvey).toHaveBeenCalledWith('NH Fish & Game bathymetry, 1998');
    await expect(field).toHaveValue('');
  },
};

/** As the app reads it today: the source in use, read-only; the bathymetry not recorded yet. */
export const AsRead: Story = {
  args: { data: MASCOMA_WATER_AS_READ },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(page.queryByRole('button')).toBeNull();
    await expect(page.queryByRole('textbox')).toBeNull();
    await expect(slot(canvasElement, 'bathymetry')).toHaveTextContent('Not recorded yet');
    // No gap known, so no amber: the chip is the plain inverted ink.
    const chip = slot(slot(canvasElement, 'bathymetry'), 'section-chip');
    await expect(getComputedStyle(chip).backgroundColor).toEqual(
      sameColor(computedColor(chip, 'var(--fg1)')),
    );
  },
};

/** A wide body, its points set by hand; no depth on record. */
export const WideBody: Story = {
  args: { data: CHAMPLAIN_WATER, lit: 'sample:1' },
  play: async ({ canvasElement }) => {
    const sampling = slot(canvasElement, 'sampling');
    await expect(sampling).toHaveTextContent('Weather sample points');
    await expect(sampling).toHaveTextContent('Set by hand');
    await expect(sampling).toHaveTextContent('can read a different forecast at each end');
    await expect(must(canvasElement.querySelector('[data-lit]'))).toHaveTextContent('44.5000°N');
    await expect(slot(canvasElement, 'depth')).toHaveTextContent('No depth on record');
  },
};

export const Loading: Story = {
  args: { data: undefined },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'water-tab')).toHaveAttribute('aria-busy', 'true');
  },
};

/** In all four maps: Now is the lit ink, never an accent. */
export const FourMaps: Story = {
  args: { data: MASCOMA_WATER },
  parameters: { fourUp: true },
  render: (args) => (
    <div className="w-(--size-inspector) px-(--space-5)">
      <WaterView {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const quad of quads) {
      const cell = must(quad.querySelector<HTMLElement>('[data-slot="radio-cell"][data-now]'));
      await expect(getComputedStyle(cell).color).toEqual(
        sameColor(computedColor(cell, 'var(--fg)')),
      );
    }
  },
};
