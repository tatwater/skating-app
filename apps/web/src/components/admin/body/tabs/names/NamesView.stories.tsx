import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, JUNCTION_TOLERANCE_PX, sameColor } from '@/components/kit/measure';
import { faceLoaded, must } from '@/components/kit/storyKit';
import { InspectorFrame } from '../tabStoryFrame';
import { NamesView } from './NamesView';
import {
  AUBURN_NAMES,
  LOW_PLAINS_NAMES,
  MASCOMA_NAMES,
  MASCOMA_NAMES_AS_READ,
} from './namesFixtures';

/**
 * Board 5.4.2, Body › Names: the tab's column at the board's size. Render `Board` beside the
 * board's right column (`body-v5.html?tab=names`, x 1060–1440, y 178–870) to compare.
 */
const meta = {
  title: 'Admin/Body/Names',
  component: NamesView,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  render: (args) => (
    <InspectorFrame>
      <NamesView {...args} />
    </InspectorFrame>
  ),
} satisfies Meta<typeof NamesView>;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));
const slots = (root: ParentNode, name: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`),
];

/** Board 5.4.2 as drawn, every control a moderator holds. */
export const Board: Story = {
  args: {
    data: MASCOMA_NAMES,
    onChooseName: fn(),
    onAliasesChange: fn(),
    onClassChange: fn(),
  },
  play: async ({ canvasElement }) => {
    const rungs = slots(canvasElement, 'name-rung');
    await faceLoaded(must(rungs[0]));
    await expect(rungs).toHaveLength(3);
    // Now sits on the displayed spelling only, and no rung offers to display the same name.
    await expect(within(must(rungs[0])).getByText('Now')).toBeVisible();
    await expect(within(canvasElement).queryByRole('button', { name: 'Display this' })).toBeNull();
    // Each catalog is written out under its spelling.
    await expect(rungs.map((r) => r.textContent)).toEqual([
      expect.stringContaining('National Hydrography Dataset'),
      expect.stringContaining('3D Hydrography Program'),
      expect.stringContaining('OpenStreetMap'),
    ]);
    // The aliases end their rule in the count, 0 when empty.
    await expect(slot(slot(canvasElement, 'aliases'), 'section-count')).toHaveTextContent('0');
    // The class: Reservoir is Now and picked.
    const reservoir = within(canvasElement).getByRole('radio', { name: /Reservoir/ });
    await expect(reservoir).toBeChecked();
    // The location names the towns, county and state.
    await expect(slot(canvasElement, 'location')).toHaveTextContent('New Hampshire');
    await expect(slot(canvasElement, 'location')).toHaveTextContent('Grafton');
  },
};

/** Picking another class moves the pick; only the button that names it applies it. */
export const PickAClass: Story = {
  args: { data: MASCOMA_NAMES, onClassChange: fn() },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await userEvent.click(page.getByRole('radio', { name: /Lake or pond/ }));
    await expect(args.onClassChange).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole('button', { name: 'Set as Lake or pond' }));
    await expect(args.onClassChange).toHaveBeenCalledWith('lakePond');
  },
};

/** A viewer with nothing to change, or no write to change it with: the same facts, no controls. */
export const ReadOnly: Story = {
  args: { data: MASCOMA_NAMES_AS_READ },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(page.queryByRole('button')).toBeNull();
    await expect(page.queryByRole('combobox')).toBeNull();
    // Not recorded is absent, never "none": no towns, no county, no source line.
    const location = slot(canvasElement, 'location');
    await expect(location).not.toHaveTextContent('Towns');
    await expect(location).not.toHaveTextContent('County');
    await expect(location).toHaveTextContent('New Hampshire');
  },
};

/** The catalogs disagree and a moderator chose: the other spelling can be displayed instead. */
export const ChosenName: Story = {
  args: { data: AUBURN_NAMES, onChooseName: fn() },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await userEvent.click(page.getByRole('button', { name: 'Display this' }));
    await expect(args.onChooseName).toHaveBeenCalledWith('The Basin');
    await userEvent.click(page.getByRole('button', { name: 'Back to the catalogs’ ranking' }));
    await expect(args.onChooseName).toHaveBeenLastCalledWith(null);
  },
};

/** No catalog names it: the community's name, typed. */
export const CommunityName: Story = {
  args: { data: LOW_PLAINS_NAMES, onCommunityName: fn() },
  play: async ({ canvasElement, args }) => {
    const field = within(canvasElement).getByRole('textbox', { name: 'Community name' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Low Plains Pond{Enter}');
    await waitFor(() => expect(args.onCommunityName).toHaveBeenCalledWith('Low Plains Pond'));
  },
};

/** The deep link's highlight: `?lit=class:lakePond` washes that row. */
export const Lit: Story = {
  args: { data: MASCOMA_NAMES, lit: 'class:lakePond' },
  play: async ({ canvasElement }) => {
    const lit = must(canvasElement.querySelector<HTMLElement>('[data-lit]'));
    await expect(lit).toHaveTextContent('Lake or pond');
  },
};

/** Loading: every section holds its place. */
export const Loading: Story = {
  args: { data: undefined },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'names-tab')).toHaveAttribute('aria-busy', 'true');
  },
};

/** The section heads sit 12 px over their content, in all four maps. */
export const FourMaps: Story = {
  args: { data: MASCOMA_NAMES, onAliasesChange: fn(), onClassChange: fn() },
  parameters: { fourUp: true },
  render: (args) => <NamesView {...args} />,
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads.length).toBe(4);
    for (const quad of quads) {
      const chip = slot(slot(quad, 'location'), 'section-chip');
      await faceLoaded(chip);
      await waitFor(() => {
        // Re-queried on every retry: a held node can go stale across a re-render.
        const c = slot(slot(quad, 'location'), 'section-chip').getBoundingClientRect();
        const first = slot(slot(quad, 'location'), 'key-value-row').getBoundingClientRect();
        expect(Math.abs(first.top - c.bottom - 12)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
      });
      // Now is the lit ink, never an accent.
      const now = must(
        [...quad.querySelectorAll<HTMLElement>('[data-slot="badge"]')].find(
          (b) => b.textContent === 'Now',
        ),
      );
      await expect(getComputedStyle(now).color).toEqual(sameColor(computedColor(now, 'var(--fg)')));
    }
  },
};
