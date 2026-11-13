import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { faceLoaded, must } from '@/components/kit/storyKit';
import { ThemePair } from '../../../../../../.storybook/theme';
import { HazardsTabView } from './HazardsTabView';
import {
  FEB_ARCHIVED,
  FEB_HAZARDS,
  FEB_NOW,
  MASCOMA_FEATURE_ROWS,
  MASCOMA_WINTERS,
  SEASON,
  WATCH_OPENED,
} from './hazardsFixtures';
import { archivedRows, hazardRows } from './hazardsModel';

/**
 * Board 5.4.7, Body › Hazards' inspector on the Body row's pinned day (14 Oct 2026), at the
 * inspector's width, dark beside light. Render one beside `body-v5.html?tab=hazards` to compare.
 * The Winter and Live boards (the ring clocks) are not this tab's default view.
 */
const meta = {
  title: 'Admin/Body/Hazards',
  component: HazardsTabView,
  globals: { surface: 'admin', mode: 'dark' },
  args: {
    season: SEASON,
    currentSeason: SEASON,
    onSeasonChange: fn(),
    bodyName: 'Mascoma',
    watchOpenedAt: WATCH_OPENED,
    hazards: [],
    archived: [],
    features: MASCOMA_FEATURE_ROWS,
    winters: MASCOMA_WINTERS,
    patternsWaiting: 2,
    onOpenRecurrence: fn(),
    onDemote: fn(async () => {}),
    onMarkHazard: fn(),
    onAddFeature: fn(),
    onEditShape: fn(),
    lit: null,
    onLitChange: fn(),
  },
  render: (args) => (
    <Inspector>
      <HazardsTabView {...args} />
    </Inspector>
  ),
} satisfies Meta<typeof HazardsTabView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The inspector's pane: positioned (the action bar floats at its foot), its gutters, its height. */
function Inspector({ children }: { children: ReactNode }) {
  return (
    <ThemePair surface="admin" heading columns="lg">
      {() => (
        <div className="relative h-[46rem] w-inspector overflow-hidden px-gutter pt-(--space-5_5)">
          {children}
        </div>
      )}
    </ThemePair>
  );
}

const quad = (canvas: HTMLElement) => must(canvas.querySelector<HTMLElement>('[data-theme-scope]'));

/** The board: nothing marked yet, the two winters, two known features, Mark a hazard. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const q = quad(canvasElement);
    const chip = must(q.querySelector<HTMLElement>('[data-slot="section-chip"]'));
    const feature = must(q.querySelector<HTMLElement>('[data-slot="feature-row"] .text-body'));
    await faceLoaded(chip, 'ON THE LAKE');
    await faceLoaded(feature, 'Mascoma River inlet');
    await expect(must(q.querySelector('[data-slot="hazards-empty"]'))).toHaveTextContent(
      'Nothing marked yet',
    );
    // The season bar spans the pane, edge to edge.
    const bar = must(
      q.querySelector<HTMLElement>('[data-slot="hazards-seasons"]'),
    ).getBoundingClientRect();
    const pane = must(
      q.querySelector<HTMLElement>('[data-slot="hazards-tab"]')?.parentElement,
    ).getBoundingClientRect();
    await expect(Math.abs(bar.left - pane.left)).toBeLessThanOrEqual(1);
    await expect(Math.abs(bar.right - pane.right)).toBeLessThanOrEqual(1);
    // A known feature's kicker is the hazard red: it is a hazard that never fades.
    const kick = must(q.querySelector<HTMLElement>('[data-slot="feature-row"] .text-bad'));
    await expect(getComputedStyle(kick).color).toEqual(
      sameColor(computedColor(kick, 'var(--bad)')),
    );
    await expect(within(q).getByRole('button', { name: /Mark a hazard/ })).toBeVisible();
  },
};

/** A winter with hazards on the lake: the list, its states in words, the groups closed. */
export const OnTheLake: Story = {
  args: {
    hazards: hazardRows(FEB_HAZARDS, FEB_NOW),
    archived: archivedRows(FEB_ARCHIVED),
    lit: 'hazard:h-ridge',
  },
  play: async ({ canvasElement }) => {
    const q = within(quad(canvasElement));
    const ridge = must(q.getByText('Black Point to Wood Island').closest('button'));
    await expect(ridge).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(q.getByRole('button', { name: /Archived this winter/ }));
    await waitFor(() => expect(q.getByText('Last seen 9 Feb')).toBeVisible());
  },
};

/** A past winter: read-only, in a solid badge; no tools. */
export const PastWinter: Story = {
  args: { season: SEASON - 1, hazards: [] },
  play: async ({ canvasElement }) => {
    const badge = must(quad(canvasElement).querySelector<HTMLElement>('[data-slot="badge"]'));
    await expect(badge).toHaveTextContent('Read-only');
    await expect(getComputedStyle(badge).backgroundColor).toEqual(
      sameColor(computedColor(badge, 'var(--fg)')),
    );
  },
};

/** As the console wires it today: no per-day read, no watch date, no map modes. */
export const Wired: Story = {
  args: {
    winters: null,
    watchOpenedAt: null,
    onMarkHazard: undefined,
    onAddFeature: undefined,
    onEditShape: undefined,
  },
};
