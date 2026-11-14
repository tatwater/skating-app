import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { faceLoaded, must } from '@/components/kit/storyKit';
import { UNAVAILABLE } from '@/components/kit/unavailable-button';
import { ThemePair } from '../../../../../../.storybook/theme';
import { HazardsTabView, type HazardsTabViewProps } from './HazardsTabView';
import {
  dailyFrom,
  FEB_ARCHIVED,
  FEB_HAZARDS,
  FEB_NOW,
  LAST_WINTER_DAILY,
  MASCOMA_FEATURE_ROWS,
  MASCOMA_WINTERS,
  PAST_WINTERS,
  SEASON,
  WATCH_OPENED,
} from './hazardsFixtures';
import { archivedRows, hazardRows, wintersFrom, winterWindow } from './hazardsModel';

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
    onRetry: fn(),
    onOpenRecurrence: fn(),
    onDemote: fn(async () => {}),
    onMarkHazard: fn() as HazardsTabViewProps['onMarkHazard'],
    onAddFeature: fn() as HazardsTabViewProps['onAddFeature'],
    onEditShape: fn() as HazardsTabViewProps['onEditShape'],
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
      'No hazard reports yet',
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
  args: { season: SEASON - 1, hazards: [], winters: PAST_WINTERS },
  play: async ({ canvasElement }) => {
    const badge = must(quad(canvasElement).querySelector<HTMLElement>('[data-slot="badge"]'));
    await expect(badge).toHaveTextContent('Read-only');
    await expect(getComputedStyle(badge).backgroundColor).toEqual(
      sameColor(computedColor(badge, 'var(--fg)')),
    );
  },
};

/**
 * As the console wires it today: the tools with no writer drawn, each saying *Not available yet*;
 * last winter's archived hazards unknown to the winter's end, said in words under the strips.
 */
export const Wired: Story = {
  args: {
    onMarkHazard: UNAVAILABLE,
    onAddFeature: UNAVAILABLE,
    onEditShape: UNAVAILABLE,
  },
  play: async ({ canvasElement }) => {
    const q = within(quad(canvasElement));
    await expect(q.getByRole('button', { name: /Mark a hazard/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(q.getByText(/archived reports have no recorded end/)).toBeVisible();
  },
};

/** Every read on its way: each section holds its place, and nothing is claimed. */
export const Loading: Story = {
  args: {
    hazards: undefined,
    archived: undefined,
    features: undefined,
    winters: undefined,
    patternsWaiting: undefined,
  },
  play: async ({ canvasElement }) => {
    const q = quad(canvasElement);
    await expect(q.querySelector('[data-slot="hazards-empty"]')).toBeNull();
    await expect(within(q).getByRole('region', { name: 'On the lake' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  },
};

/** Every read failed: each says so in its place, with Try again; nothing reads as empty. */
export const Failed: Story = {
  args: { hazards: 'error', features: 'error', patternsWaiting: 'error' },
  play: async ({ canvasElement, args }) => {
    const q = within(quad(canvasElement));
    await expect(q.queryByText(/No hazard reports/)).toBeNull();
    await userEvent.click(must(q.getAllByRole('button', { name: 'Try again' })[0]));
    await expect(args.onRetry).toHaveBeenCalled();
  },
};

const FEB_START = winterWindow(SEASON - 1).start;

/**
 * A winter's strip over its list, with days that are only floors: two hazards still up, three
 * archived (unknown from the day after each first report), and a count that stopped short.
 */
export const UnknownDays: Story = {
  args: {
    season: SEASON - 1,
    hazards: hazardRows(FEB_HAZARDS, FEB_NOW),
    archived: archivedRows(FEB_ARCHIVED),
    winters: wintersFrom(
      [
        dailyFrom(
          SEASON - 1,
          [
            { first: FEB_START + 70 * 86_400_000, active: false },
            { first: FEB_START + 95 * 86_400_000, active: true },
            { first: FEB_START + 110 * 86_400_000, active: false },
            { first: FEB_START + 120 * 86_400_000, active: false },
            { first: FEB_START + 130 * 86_400_000, active: true },
          ],
          FEB_NOW,
          { capped: true },
        ),
      ],
      FEB_NOW,
    ) as NonNullable<ReturnType<typeof wintersFrom>>,
  },
  play: async ({ canvasElement }) => {
    const q = quad(canvasElement);
    const unknown = q.querySelectorAll('[data-slot="day-strip-unknown"]');
    await expect(unknown.length).toBeGreaterThan(0);
    await expect(within(q).getByText(/each day is at least what it shows/)).toBeVisible();
  },
};

/** Between 1 July and 1 October: this winter is honestly empty and says when its record begins. */
export const BeforeTheRecord: Story = {
  args: {
    watchOpenedAt: null,
    winters: wintersFrom(
      [
        { season: SEASON, days: [], unknownEnds: 0, capped: false, watchOpensOn: null },
        LAST_WINTER_DAILY,
      ],
      new Date(2026, 7, 20, 12, 0).getTime(),
    ) as NonNullable<ReturnType<typeof wintersFrom>>,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(quad(canvasElement)).getByText('The record for 2026–27 begins 1 Oct 2026.'),
    ).toBeVisible();
  },
};
