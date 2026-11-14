import { seasonOf, seasonRecordWindow } from '@skating/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, waitFor, within } from 'storybook/test';

import {
  BOARD_COVERAGE,
  BOARD_KEEPING_UP,
  BOARD_SHOWING_UP,
} from '@/components/admin/metrics/metricsFixtures';
import type { DayKey } from '@/components/admin/metrics/metricsModel';
import type { MetricsReads } from '@/components/admin/metrics/useOverviewMetrics';
import { must } from '@/components/kit/storyKit';

import { ConsoleShell } from '../shell/ConsoleShell';
import { CONSOLE_MODES, LEGACY_PAGES } from '../shell/consoleNav';
import { seasonTape, type TapeFacts } from '../shell/consoleTime';
import { OverviewView } from './OverviewView';
import { HOME, LAST_CHECKED_LIVE, NOW } from './overviewFixtures';
import type { OverviewTabValue } from './overviewSearch';
import { OverviewLamp } from './overviewStatus';
import type { HomeReads } from './useOverviewHome';

/**
 * The Overview as the app mounts it at `/admin`: the real console shell around the real page,
 * drawn from what the reads return — board numbers here, in the reads' own shapes (`HomeReads`,
 * `MetricsReads`) — and what no read serves drawn *Not recorded yet*: cost, and the Corpus rows the
 * server returns as `null` (the pre-ice pass, enrichment). Compare with boards 1.1 and 1.4.
 */

/** What `useOverviewHome` returns: everything but cost, and the Corpus rows no record serves. */
const READS: HomeReads = {
  inbox: HOME.inbox,
  people: HOME.people,
  corpus: HOME.corpus && { ...HOME.corpus, preIcePass: null, enrichment: null },
  machinery: HOME.machinery,
  watch: HOME.watch,
  winter: HOME.winter,
  imagery: HOME.imagery,
  firstSkate: HOME.firstSkate,
  feed: HOME.feed,
};

/** What `seasonWatch.tape` returns for the board's winter: opened 3 Oct by two of three sentinels. */
const tapeFacts = (season: number): TapeFacts => ({
  season,
  countsFrom: `${season}-10-01`,
  watch: {
    opensOn: `${season}-10-03`,
    openedBy: ['sentinel'],
    closesOn: null,
    opening: {
      sentinels: [
        { name: 'Upper Lake of the Clouds', lowC: -3 },
        { name: 'Eagle Lake', lowC: -2 },
      ],
    },
    sentinels: [
      { waterBodyId: 'clouds' as never, name: 'Upper Lake of the Clouds' },
      { waterBodyId: 'eagle' as never, name: 'Eagle Lake' },
      { waterBodyId: 'kinsman' as never, name: 'Kinsman Pond' },
    ],
  },
  imageryNudgeOn: `${season}-10-07`,
  imageryNudgeLowC: -7.2,
  winterFrom: `${season}-10-07`,
  lastWinterFirst: { source: 'report', at: Date.UTC(season, 11, 6, 15), body: 'Crystal Lake' },
});

/** The board's fourteen days, padded with unrecorded days back to the window's 1 October. */
function metricsReads(now: number): MetricsReads {
  const { days, opensOn } = seasonRecordWindow(seasonOf(now), now);
  const pad = <T,>(series: readonly (T | null)[]): Array<T | null> => [
    ...new Array<null>(Math.max(0, days.length - series.length)).fill(null),
    ...series,
  ];
  const base = { season: seasonOf(now), opensOn, days: days as DayKey[] };
  const pulse = Object.fromEntries(
    Object.entries(BOARD_SHOWING_UP.pulse).map(([key, series]) => [
      key,
      series && { ...series, daily: pad(series.daily) },
    ]),
  ) as typeof BOARD_SHOWING_UP.pulse;
  return {
    keepingUp: {
      ...base,
      keepingUp: {
        ...BOARD_KEEPING_UP,
        queueByDay: pad(BOARD_KEEPING_UP.queueByDay),
        support: BOARD_KEEPING_UP.support && {
          ...BOARD_KEEPING_UP.support,
          depthByDay: pad(BOARD_KEEPING_UP.support.depthByDay),
        },
      },
    },
    showingUp: { ...base, showingUp: { ...BOARD_SHOWING_UP, pulse } },
    coverage: { ...base, coverage: BOARD_COVERAGE },
  } as MetricsReads;
}

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
      tape={seasonTape(
        now,
        'America/New_York',
        // Before 3 October the board's watch hasn't opened: July draws the bare calendar.
        now >= Date.UTC(seasonOf(now), 9, 3) ? tapeFacts(seasonOf(now)) : undefined,
      )}
      colleagues={[
        { id: 'sarah', name: 'Sarah Berman', present: true },
        { id: 'matt', name: 'Matt Steinberg', present: false },
      ]}
      viewerId="t"
      onSearch={() => {}}
      lamp={<OverviewLamp state="live" />}
    >
      <OverviewView
        season={seasonOf(now)}
        tab={tab}
        onTabChange={setTab}
        reads={READS}
        metrics={metricsReads(now)}
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
    // Machinery's trouble reaches the bar, from the jobs the read returned.
    await expect(slot(canvasElement, 'console-status')).toHaveTextContent('1 stalled');
    // Cost is the one block no read serves: its tile and its section say so.
    await expect(page.getAllByText('Not recorded yet').length).toBeGreaterThanOrEqual(1);
    await expect(page.getByRole('region', { name: 'Machinery' })).toHaveTextContent('41 min');
  },
};

/** Metrics as `/admin?tab=metrics` draws it from its reads: the board's fortnight, the season before it unrecorded. */
export const Metrics: Story = {
  args: { initialTab: 'metrics' },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(page.getByRole('tab', { name: 'Metrics' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const tile = (label: string) =>
      must(page.getByText(label, { selector: '[data-slot="stat-label"]' }).parentElement);
    await expect(tile('Open flags')).toHaveTextContent('3');
    await expect(page.getByText('Coverage by state')).toBeVisible();
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
