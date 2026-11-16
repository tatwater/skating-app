import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { faceLoaded, must } from '@/components/kit/storyKit';
import { ThemePair } from '../../../../../../.storybook/theme';
import { StandingTabView } from './StandingTabView';
import {
  ACTIVE,
  ACTIVE_SINCE,
  BODY_NOW,
  DORMANT_BY_HAND,
  MASCOMA_RETENTION,
  REMOVED,
  RETENTION_FAVORITES_FLOOR,
  RETENTION_PART_UNREAD,
} from './standingFixtures';

/**
 * Board 5.4.8, Body › Standing's inspector, on the Body row's pinned day (14 Oct 2026), at the
 * inspector's width, dark beside light. Render one beside `body-v5.html?tab=standing` to compare.
 */
const meta = {
  title: 'Admin/Body/Standing',
  component: StandingTabView,
  globals: { surface: 'admin', mode: 'dark' },
  args: {
    standing: ACTIVE,
    activeSince: ACTIVE_SINCE,
    retention: MASCOMA_RETENTION,
    now: BODY_NOW,
    canSetStanding: true,
    canRemove: true,
    onSetDormant: fn(async () => true),
    onSetActive: fn(async () => true),
    onRemove: fn(async () => true),
    onRestore: fn(async () => true),
  },
  render: (args) => (
    <Inspector>
      <StandingTabView {...args} />
    </Inspector>
  ),
} satisfies Meta<typeof StandingTabView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The inspector's column: its width and gutters, in both modes. */
function Inspector({ children }: { children: ReactNode }) {
  return (
    <ThemePair surface="admin" heading columns="lg">
      {() => <div className="w-inspector px-gutter py-(--space-5_5)">{children}</div>}
    </ThemePair>
  );
}

const quad = (canvas: HTMLElement) => must(canvas.querySelector<HTMLElement>('[data-theme-scope]'));

/** The board: Active is Now; four lanes, three holding, the report stopping at 1 Jul 2030. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const q = quad(canvasElement);
    const now = must(q.querySelector<HTMLElement>('[data-slot="badge"]'));
    const lane = must(q.querySelector<HTMLElement>('[data-slot="lane-label"] span'));
    await faceLoaded(now, 'NOW');
    await faceLoaded(lane, 'Map boost');
    await expect(now).toHaveTextContent('Now');
    const lanes = [...q.querySelectorAll<HTMLElement>('[data-slot="lane"]')];
    await expect(lanes).toHaveLength(4);
    await expect(lanes.filter((l) => l.hasAttribute('data-open'))).toHaveLength(3);
    // The report's bar stops on the 2030 gridline: its right edge meets that line.
    const labels = [...q.querySelectorAll<HTMLElement>('[data-slot="lane-axis-label"]')];
    await expect(labels.map((l) => l.textContent)).toEqual(['2027', '2028', '2029', '2030']);
    const bar = must(lanes[3]?.querySelector<HTMLElement>('[data-slot="lane-bar"]'));
    const line2030 = must(labels[3]);
    const barEnd = bar.getBoundingClientRect().right;
    const labelMid =
      line2030.getBoundingClientRect().left + line2030.getBoundingClientRect().width / 2;
    await expect(Math.abs(barEnd - labelMid)).toBeLessThanOrEqual(1);
  },
};

/** `&pick=dormant`: the pick moved, the note's form open under the list, its button naming it. */
export const PickDormant: Story = {
  play: async ({ canvasElement }) => {
    const q = within(quad(canvasElement));
    await userEvent.click(q.getByRole('radio', { name: /^Dormant/ }));
    await waitFor(() => expect(q.getByRole('button', { name: /Set dormant/ })).toBeVisible());
    await expect(q.getByText('0 / 160')).toBeVisible();
    // Active still wears Now: picking moves the pick, not the standing.
    await expect(q.getByRole('radio', { name: /^Active/ })).toHaveAccessibleName(/Now/);
  },
};

/** `&pick=removed`: the reason first; the destructive button waits, armed, until there is one. */
export const PickRemoved: Story = {
  play: async ({ canvasElement }) => {
    const q = within(quad(canvasElement));
    await userEvent.click(q.getByRole('radio', { name: /^Removed/ }));
    await waitFor(() =>
      expect(q.getByRole('button', { name: 'Remove from the map' })).toBeDisabled(),
    );
  },
};

/** Facts a read didn't serve draw no lanes and are named, never drawn as zero. */
export const NotRecordedYet: Story = {
  args: { retention: RETENTION_PART_UNREAD },
  play: async ({ canvasElement }) => {
    const q = quad(canvasElement);
    await expect(q.querySelectorAll('[data-slot="lane"]')).toHaveLength(2);
    await expect(must(q.querySelector('[data-slot="standing-not-recorded"]'))).toHaveTextContent(
      'Not recorded yet: favorites and the last report.',
    );
  },
};

/** More favorites than the server counts: the lane reads a floor. */
export const FavoritesFloor: Story = {
  args: { retention: RETENTION_FAVORITES_FLOOR },
  play: async ({ canvasElement }) => {
    await expect(within(quad(canvasElement)).getByText('1,000+ skaters')).toBeVisible();
  },
};

/** The retention read on its way: the lanes hold their place, and nothing is claimed. */
export const RetentionLoading: Story = {
  args: { retention: undefined },
  play: async ({ canvasElement }) => {
    const q = quad(canvasElement);
    await expect(q.querySelector('[data-slot="lane"]')).toBeNull();
    await expect(q.querySelector('[data-slot="standing-foot"]')).toBeNull();
  },
};

/** The retention read failed: it says so, with Try again. */
export const RetentionFailed: Story = {
  args: { retention: 'error', onRetry: fn() },
  play: async ({ canvasElement, args }) => {
    const q = within(quad(canvasElement));
    await userEvent.click(q.getByRole('button', { name: 'Try again' }));
    await expect(args.onRetry).toHaveBeenCalled();
  },
};

/** Set dormant by hand: the note is what skaters read. */
export const Dormant: Story = { args: { standing: DORMANT_BY_HAND } };

/** Taken off the map: an admin's Restore is the way back. */
export const Removed: Story = { args: { standing: REMOVED } };

/** A moderator: no Removed option at all. */
export const Moderator: Story = {
  args: { canRemove: false },
  play: async ({ canvasElement }) => {
    await expect(within(quad(canvasElement)).queryByRole('radio', { name: /^Removed/ })).toBeNull();
  },
};
