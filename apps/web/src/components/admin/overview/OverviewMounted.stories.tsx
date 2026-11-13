import { seasonOf } from '@skating/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, waitFor, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';

import { ConsoleShell } from '../shell/ConsoleShell';
import { CONSOLE_MODES, LEGACY_PAGES } from '../shell/consoleNav';
import { seasonTape } from '../shell/consoleTime';
import { OverviewView } from './OverviewView';
import { HOME, LAST_CHECKED_LIVE, NOW } from './overviewFixtures';
import type { OverviewTabValue } from './overviewSearch';
import { OverviewLamp } from './overviewStatus';

/**
 * The Overview as the app mounts it at `/admin`: the real console shell around the real page,
 * with what the reads that exist return today (the Inbox, Corpus and People counts and the feed —
 * board numbers here) and every block no read serves drawn *Not recorded yet*. Compare with boards
 * 1.1 and 1.4 for where the shell meets the page: the status bar, the tabs, the padding.
 */

/** What `useOverviewHome` returns: the Corpus rows no read counts are `null`, as in the app. */
const READS = {
  inbox: HOME.inbox,
  people: HOME.people && { ...HOME.people, totalUsers: null },
  corpus: HOME.corpus && {
    ...HOME.corpus,
    chordRefits: null,
    placeNames: null,
    preIcePass: null,
    enrichment: null,
    campaignAt: null,
  },
  feed: HOME.feed,
};

function Mounted({
  initialTab,
  fourUp,
  now = NOW,
}: {
  initialTab: OverviewTabValue;
  fourUp?: boolean;
  /** The page's clock; the season is the one it falls in. */
  now?: number;
}) {
  const [tab, setTab] = useState<OverviewTabValue>(initialTab);
  return (
    <ConsoleShell
      className={fourUp ? 'h-[56.25rem] w-[90rem]' : 'h-screen w-screen'}
      modes={CONSOLE_MODES.map((m) => ({ ...m, current: m.id === 'overview' }))}
      legacy={LEGACY_PAGES}
      onLegacy={() => {}}
      linkFor={(to) => (
        // biome-ignore lint/a11y/useAnchorContent: the rail item renders its icon and name into it
        <a href={`#${to}`} onClick={(e) => e.preventDefault()} />
      )}
      appHref="#app"
      viewer={{ name: 'Teagan Atwater' }}
      tape={seasonTape(now, 'America/New_York')}
      viewerId="t"
      onSearch={() => {}}
      lamp={<OverviewLamp state="live" />}
    >
      <OverviewView
        season={seasonOf(now)}
        tab={tab}
        onTabChange={setTab}
        reads={READS}
        now={now}
        live={{ state: 'live', lastCheckedAt: LAST_CHECKED_LIVE }}
        support
      />
    </ConsoleShell>
  );
}

const meta = {
  title: 'Admin/Overview/Mounted',
  component: Mounted,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: { initialTab: 'home' },
} satisfies Meta<typeof Mounted>;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));

/** Home as `/admin` draws it today, in the shell. */
export const Home: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(page.getByRole('tab', { name: 'Home' })).toHaveAttribute('aria-selected', 'true');
    // The page's status groups land in the shell's bar, and the lamp at its end.
    await expect(slot(canvasElement, 'console-status')).toHaveTextContent('1 safety');
    await expect(page.getByText('Convex live')).toBeVisible();
    await expect(page.getAllByText('Not recorded yet').length).toBeGreaterThanOrEqual(8);
  },
};

/** Metrics as `/admin?tab=metrics` draws it today: every section unread. */
export const Metrics: Story = {
  args: { initialTab: 'metrics' },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(page.getByRole('tab', { name: 'Metrics' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getAllByText('Not recorded yet').length).toBeGreaterThanOrEqual(11);
  },
};

/**
 * Metrics on a 900 px screen: the tab scrolls under the page head (the shell's main area doesn't),
 * so coverage by state, at the foot, is reachable.
 */
export const MetricsScrolls: Story = {
  name: 'Metrics scrolls on a short screen',
  args: { initialTab: 'metrics', fourUp: true },
  play: async ({ canvasElement }) => {
    const viewport = must(
      canvasElement.querySelector<HTMLElement>(
        '[data-slot="metrics-scroll"] [data-slot="scroll-area-viewport"]',
      ),
    );
    await waitFor(() => expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight));
    viewport.scrollTop = viewport.scrollHeight;
    const coverage = within(canvasElement).getByText('Coverage by state').getBoundingClientRect();
    const main = slot(canvasElement, 'shell-main').getBoundingClientRect();
    await expect(coverage.bottom).toBeLessThanOrEqual(main.bottom);
    // The page head stays put.
    await expect(slot(canvasElement, 'page-word').getBoundingClientRect().top).toBeGreaterThan(
      main.top,
    );
  },
};

/** Home in all four maps. */
export const HomeFourUp: Story = {
  name: 'Home, four-up',
  args: { fourUp: true },
  parameters: { fourUp: true },
};

/** Metrics in all four maps. */
export const MetricsFourUp: Story = {
  name: 'Metrics, four-up',
  args: { initialTab: 'metrics', fourUp: true },
  parameters: { fourUp: true },
};

/** 20 July 2027: the new season has begun (1 July) and its record hasn't (1 October). */
const JULY = Date.UTC(2027, 6, 20, 16);

/**
 * Home in July: the season's four show the new season, empty — the watch waiting and counting from
 * 1 October, the others saying when the record begins — never last winter's facts.
 */
export const HomeInJuly: Story = {
  name: 'Home in July',
  args: { now: JULY },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const tile = (label: string) =>
      must(page.getByText(label, { selector: '[data-slot="stat-label"]' }).parentElement);
    await expect(tile('Ice watch')).toHaveTextContent('WaitingCounting nights from 1 Oct');
    for (const label of ['Winter, region-wide', 'Imagery', 'First skated']) {
      await expect(tile(label)).toHaveTextContent('—Record begins 1 Oct');
    }
    await expect(page.getByText('Winter 2027–28')).toBeVisible();
  },
};

/** Metrics in July: every season-ranged section says when its record begins. */
export const MetricsInJuly: Story = {
  name: 'Metrics in July',
  args: { now: JULY, initialTab: 'metrics' },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    // Three charts, two histograms, eight strips, vantage, most-reported and coverage.
    await expect(page.getAllByText('Record begins 1 Oct').length).toBeGreaterThanOrEqual(14);
    await expect(page.queryByText('None resolved this season')).toBeNull();
  },
};
