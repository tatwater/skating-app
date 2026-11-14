import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, JUNCTION_TOLERANCE_PX, sameColor } from '@/components/kit/measure';
import { faceLoaded, must } from '@/components/kit/storyKit';
import { FAILED } from '../places/useTabReads';
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

/** A viewer with nothing to change: the same facts, no controls; what no read records says so. */
export const ReadOnly: Story = {
  args: { data: MASCOMA_NAMES_AS_READ },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(page.queryByRole('button')).toBeNull();
    await expect(page.queryByRole('combobox')).toBeNull();
    await expect(page.queryByRole('group', { name: 'Aliases' })).toBeNull();
    const location = slot(canvasElement, 'location');
    await expect(location).toHaveTextContent('Enfield');
    await expect(location).toHaveTextContent('Grafton County');
    await expect(location).toHaveTextContent('New Hampshire');
    await expect(slot(canvasElement, 'class-claims')).toHaveTextContent(
      'Each catalog’s class: Not recorded yet',
    );
    await expect(slot(canvasElement, 'per-catalog-claims')).toHaveTextContent('Not recorded yet');
  },
};

/**
 * The tab as the app draws it for a moderator today: the aliases' editor and the class change have
 * no server write yet, so each is drawn where the board draws it and says *Not available yet*.
 */
export const AsTheAppDrawsIt: Story = {
  args: {
    data: MASCOMA_NAMES_AS_READ,
    onChooseName: fn(),
    canEditAliases: true,
    canEditClass: true,
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const aliases = page.getByRole('group', { name: 'Aliases' });
    await expect(aliases).toHaveAttribute('aria-disabled', 'true');
    await userEvent.hover(aliases);
    await waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-title"]')).toHaveTextContent(
        'Not available yet',
      ),
    );
    await userEvent.unhover(aliases);
    await expect(page.getByRole('button', { name: /Another class/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  },
};

/** No boundary holds the body: its towns and county are not recorded, said so. */
export const NoBoundary: Story = {
  args: { data: LOW_PLAINS_NAMES },
  play: async ({ canvasElement }) => {
    const location = slot(canvasElement, 'location');
    await expect(location).toHaveTextContent('TownsNot recorded yet');
    await expect(location).toHaveTextContent('CountyNot recorded yet');
    await expect(location).not.toHaveTextContent('TIGER');
  },
};

/** The boundaries are on their way: their rows hold their place. */
export const BoundariesLoading: Story = {
  args: {
    data: { ...MASCOMA_NAMES_AS_READ, place: { ...MASCOMA_NAMES_AS_READ.place, admin: undefined } },
  },
  play: async ({ canvasElement }) => {
    const location = slot(canvasElement, 'location');
    await expect(location.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(2);
  },
};

/** The boundaries couldn't be read: said in place, and once at the top with Try again. */
export const BoundariesFailed: Story = {
  args: {
    data: {
      ...MASCOMA_NAMES_AS_READ,
      place: { ...MASCOMA_NAMES_AS_READ.place, admin: FAILED },
      failures: ['the towns and county'],
    },
    onRetry: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const note = slot(canvasElement, 'read-failures');
    await expect(note).toHaveTextContent('Couldn’t read the towns and county.');
    await expect(slot(canvasElement, 'location')).toHaveTextContent('TownsCouldn’t be read');
    await userEvent.click(within(note).getByRole('button', { name: 'Try again' }));
    await expect(args.onRetry).toHaveBeenCalled();
  },
};

/** The record itself couldn't be read: the tab says so, with Try again. */
export const RecordFailed: Story = {
  args: { data: FAILED, onRetry: fn() },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'retry-note')).toHaveTextContent(
      'Couldn’t read this body’s record.',
    );
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
