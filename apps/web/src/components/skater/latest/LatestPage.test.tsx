import type { FeedFilters } from '@skating/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSkaterMapStore } from '@/stores/skaterMapStore';

import { takeWaterBodyOpenSource } from '../lake/openSource';
import {
  panelFakes,
  panelRouter,
  polyfillAnimate,
  resetPanelFakes,
} from '../panels/panelTestMocks';
import { convexReact, fakes, resetFakes } from '../testMocks';

const m = vi.hoisted(() => ({
  filters: {} as Record<string, unknown>,
  setFilters: (() => {}) as (next: Record<string, unknown>) => void,
  flags: {} as Record<string, boolean>,
  hosts: [] as Array<{ reportId: string; host: { backTo: string; onClose: () => void } }>,
}));

vi.mock('convex/react', () => convexReact);
vi.mock('@tanstack/react-router', () => panelRouter);
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: fakes.capture }),
}));
vi.mock('@/lib/featureFlags', () => ({
  useFeatureFlag: (flag: string, fallback: boolean) => m.flags[flag] ?? fallback,
}));
vi.mock('@/lib/feedFiltersStore', () => ({
  useFeedFilters: () => ({ value: m.filters, set: m.setFilters }),
}));
vi.mock('../panels/ReportPanel', () => ({
  ReportPanel: (props: { reportId: string; host: { backTo: string; onClose: () => void } }) => {
    m.hosts.push(props);
    return (
      <button type="button" onClick={props.host.onClose}>
        Back to {props.host.backTo}
      </button>
    );
  },
}));
vi.mock('../lake/InViewList', () => ({ InViewList: () => <p>In view</p> }));

import { LatestPage } from './LatestPage';
import { MATCH, POST, REPORT } from './latestFixtures';

beforeAll(() => {
  polyfillAnimate();
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
});

const setFilters = vi.fn();
beforeEach(() => {
  resetFakes();
  resetPanelFakes();
  m.filters = {};
  m.flags = {};
  m.hosts = [];
  setFilters.mockReset();
  m.setFilters = setFilters;
  useSkaterMapStore.setState({ specs: { view: null, flow: null } });
  fakes.paginated = { results: [POST], status: 'Exhausted', loadMore: vi.fn() };
  fakes.queries.set('reports:recommended', []);
  fakes.queries.set('weatherDiscovery:status', { available: true, asOfDayMs: Date.now() });
  fakes.queries.set('bounties:listOpen', []);
});

/** The last navigation, with its `search` updater applied to `prev`. */
function lastNavigation(prev: Record<string, unknown> = {}) {
  const call = panelFakes.navigate.mock.calls.at(-1)?.[0] as {
    search?: unknown;
    [key: string]: unknown;
  };
  const search =
    typeof call.search === 'function'
      ? (call.search as (p: Record<string, unknown>) => unknown)(prev)
      : call.search;
  return { ...call, search };
}

const page = (search: Record<string, unknown> = {}) => render(<LatestPage search={search} />);

describe('LatestPage', () => {
  it('draws the three columns: filters, the feed, Recommended and Wanted (4.1, 4.16)', () => {
    fakes.queries.set('reports:recommended', [
      { waterBodyId: 'wb1', cards: [{ ...REPORT, reportId: 'rec1' }] },
    ]);
    fakes.queries.set('bounties:listOpen', [
      {
        _id: 'b1',
        waterBodyId: 'w1',
        waterBodyName: 'Mascoma Lake',
        subAreaName: 'Mascoma North',
        requester: { displayName: 'Rob Tremblay' },
        fulfillingCount: 0,
        createdAt: 1,
        expiresAt: Date.now() + 5 * 86_400_000 + 60_000,
      },
    ]);
    page();
    expect(screen.getByRole('heading', { name: 'Filters' })).toBeInTheDocument();
    expect(screen.getByText('Mascoma South, first real day')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recommended' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Wanted near you' })).toBeInTheDocument();
    // The wanted read is bounded and sorted by the viewer's home, server-side.
    expect(fakes.calls.find((c) => c.name === 'bounties:listOpen')?.args).toEqual({
      sortByHome: true,
      limit: 24,
    });
    // Flags off: no search box, and the feed reads with the saved filters only.
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(fakes.paginatedArgs.at(-1)).toEqual('skip');
    expect(fakes.paginatedArgs.at(-2)).toEqual({ filters: {} });
  });

  it('subtracts recommended reports from the feed (D50)', () => {
    fakes.queries.set('reports:recommended', [{ waterBodyId: 'wb1', cards: [REPORT] }]);
    page();
    expect(screen.queryByText('Mascoma South, first real day')).toBeNull();
    expect(screen.getByText(/No reports yet/)).toBeInTheDocument();
  });

  it('writes a filter to the saved store and counts which control, never the value', () => {
    m.filters = { qualityFloor: 'good' };
    page();
    fireEvent.click(screen.getByRole('button', { name: 'Great' }));
    expect(setFilters).toHaveBeenCalledWith({ qualityFloor: 'great' });
    expect(fakes.capture).toHaveBeenCalledWith('latest_filter_changed', { filter: 'quality' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(setFilters).toHaveBeenLastCalledWith({});
  });

  it('opens a report in the center column, from the feed, without resetting scroll', () => {
    page();
    fireEvent.click(screen.getByRole('link', { name: /^Report on Mascoma South/ }));
    expect(fakes.capture).toHaveBeenCalledWith('latest_report_opened');
    expect(lastNavigation({ post: 'new' })).toMatchObject({
      to: '/latest',
      search: { post: 'new', report: 'rep1' },
      state: { panelSource: 'latest' },
      resetScroll: false,
    });
  });

  it('keeps the feed’s scroll under the open report, and closes back to it with Esc', () => {
    const { rerender } = page();
    const scroller = document.querySelector('[data-slot="latest-feed-scroll"]') as HTMLElement;
    scroller.scrollTop = 640;

    rerender(<LatestPage search={{ report: 'rep1' }} />);
    expect(m.hosts.at(-1)).toMatchObject({ reportId: 'rep1', host: { backTo: 'Latest' } });
    expect(document.querySelector('[data-slot="latest-feed-scroll"]')).toBe(scroller);
    expect(scroller).toHaveAttribute('inert');
    // The selected report is marked in the feed under the card.
    expect(document.querySelector('[aria-current="true"]')).not.toBeNull();

    // Opened from the feed: Back is one step back in history.
    panelFakes.state = { panelSource: 'latest' };
    panelFakes.canGoBack = true;
    rerender(<LatestPage search={{ report: 'rep1' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to Latest' }));
    expect(panelFakes.back).toHaveBeenCalledTimes(1);

    rerender(<LatestPage search={{}} />);
    expect(document.querySelector('[data-slot="latest-feed-scroll"]')).toBe(scroller);
    expect(scroller.scrollTop).toBe(640);
    expect(scroller).not.toHaveAttribute('inert');
  });

  it('closes a deep-linked report by dropping the param with replace', () => {
    page({ report: 'rep1' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to Latest' }));
    expect(panelFakes.back).not.toHaveBeenCalled();
    expect(lastNavigation({ report: 'rep1', post: 'new' })).toMatchObject({
      to: '/latest',
      search: { report: undefined, post: 'new' },
      replace: true,
      resetScroll: false,
    });
  });

  it('interleaves the matched lakes under a weather filter, and opens one marked as from Latest', () => {
    m.filters = { weather: { thresholdF: 20, minNights: 3 } } satisfies FeedFilters;
    fakes.queries.set('weatherDiscovery:listBodyResults', {
      results: [MATCH],
      exhausted: false,
      asOfDayMs: null,
    });
    page();
    expect(screen.getByText(/Showing the 1 most recently matched lakes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: /^Weather match: Smith Pond/ }));
    expect(lastNavigation()).toMatchObject({ to: '/water/$id', params: { id: 'wb2' }, search: {} });
    expect(takeWaterBodyOpenSource('/water/wb2')).toBe('latest');
  });

  it('opens a matched bay with its sub-area', () => {
    m.filters = { weather: { thresholdF: 20, minNights: 3 } } satisfies FeedFilters;
    fakes.queries.set('weatherDiscovery:listBodyResults', {
      results: [{ ...MATCH, place: { kind: 'subArea', subAreaId: 's1', name: 'North Bay' } }],
      exhausted: true,
      asOfDayMs: null,
    });
    page();
    fireEvent.click(screen.getByRole('link', { name: /^Weather match:/ }));
    expect(lastNavigation()).toMatchObject({ search: { sub: 's1' } });
  });

  it('skips the lakes when the skater asked for reports only', () => {
    m.filters = { weather: { thresholdF: 20, minNights: 3 }, onlyReports: true };
    page();
    expect(fakes.calls.some((c) => c.name === 'weatherDiscovery:listBodyResults')).toBe(false);
  });

  it('says there is no weather data yet, and turns the filter off (4.13)', () => {
    m.filters = { weather: { thresholdF: 20, minNights: 3 }, onlyReports: true };
    fakes.queries.set('weatherDiscovery:status', { available: false, asOfDayMs: null });
    fakes.paginated = { results: [], status: 'Exhausted', loadMore: vi.fn() };
    page();
    expect(screen.getByText(/No weather data yet this season, so/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off the weather filter' }));
    expect(setFilters).toHaveBeenCalledWith({});
    expect(fakes.capture).toHaveBeenCalledWith('latest_filter_changed', {
      filter: 'weather_match',
    });
  });

  it('fills an empty season with recent cold weather (4.10)', () => {
    fakes.paginated = { results: [], status: 'Exhausted', loadMore: vi.fn() };
    fakes.queries.set('weatherDiscovery:listBodyResults', (args: { filters: FeedFilters }) =>
      args.filters.weather?.thresholdF === 20 && args.filters.weather.minNights === 3
        ? { results: [MATCH], exhausted: true, asOfDayMs: null }
        : undefined,
    );
    page();
    expect(screen.getByRole('heading', { name: 'Recent cold weather' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open the map' }));
    expect(fakes.push).toHaveBeenCalledWith('/');
  });

  it('loads more when a filtered page came back empty (4.11)', () => {
    m.filters = { thicknessFloorCm: 15 };
    const loadMore = vi.fn();
    fakes.paginated = { results: [], status: 'CanLoadMore', loadMore };
    page();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(loadMore).toHaveBeenCalledWith(20);
  });

  it('shows the first page loading (4.15)', () => {
    fakes.paginated = { results: [], status: 'LoadingFirstPage', loadMore: vi.fn() };
    page();
    expect(screen.getByText('Loading reports')).toBeInTheDocument();
  });

  it('changes home in Settings', () => {
    page();
    fireEvent.click(screen.getByRole('button', { name: 'Change home' }));
    expect(fakes.push).toHaveBeenCalledWith('/settings/home');
  });

  it('opens a wanted place’s bounty over its lake, counted as from Latest', () => {
    fakes.queries.set('bounties:listOpen', [
      {
        _id: 'b1',
        waterBodyId: 'w1',
        waterBodyName: 'Crystal Lake',
        requester: null,
        fulfillingCount: 1,
        createdAt: 1,
        expiresAt: Date.now() + 86_400_000 * 2,
      },
    ]);
    page();
    fireEvent.click(screen.getByRole('button', { name: /Open the bounty at Crystal Lake/ }));
    expect(fakes.capture).toHaveBeenCalledWith('wanted_bounty_opened');
    expect(lastNavigation()).toMatchObject({
      to: '/bounty/$id',
      params: { id: 'b1' },
      state: { panelSource: 'latest' },
    });
  });

  it('opens a recommended report in the center column too', () => {
    fakes.queries.set('reports:recommended', [{ waterBodyId: 'wb1', cards: [REPORT] }]);
    page();
    fireEvent.click(screen.getByRole('link', { name: /^Recommended: Mascoma Lake/ }));
    expect(lastNavigation()).toMatchObject({ search: { report: 'rep1' } });
  });
});

describe('LatestPage · the empty states’ ways out', () => {
  beforeEach(() => {
    fakes.paginated = { results: [], status: 'Exhausted', loadMore: vi.fn() };
  });

  it('clears every filter when nothing this season matches them', () => {
    m.filters = { noSnow: true };
    page();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
    expect(setFilters).toHaveBeenCalledWith({});
  });

  it('clears an empty search', () => {
    m.flags['latest-text-search'] = true;
    page({ q: 'zzz' });
    const plate = document.querySelector('[data-slot="latest-empty"]') as HTMLElement;
    fireEvent.click(within(plate).getByRole('button', { name: 'Clear search' }));
    expect(lastNavigation({ q: 'zzz' })).toMatchObject({ search: { q: undefined }, replace: true });
  });

  it('shows everyone again when one skater’s reports can’t be shown', () => {
    m.flags['latest-skater-filter'] = true;
    fakes.queries.set('posts:listFeed', { page: [], isDone: true, skaterUnavailable: true });
    page({ skater: 'private' });
    fireEvent.click(screen.getByRole('button', { name: 'Show everyone’s reports' }));
    expect(lastNavigation({ skater: 'private' })).toMatchObject({
      search: { skater: undefined },
      replace: true,
    });
  });
});

describe('LatestPage · text search (latest-text-search)', () => {
  it('ignores ?q= while the flag is off', () => {
    page({ q: 'narrows' });
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(fakes.calls.some((c) => c.name === 'posts:searchFeed')).toBe(false);
  });

  it('searches, counts the matches when no filter is on, and clears', () => {
    m.flags['latest-text-search'] = true;
    fakes.queries.set('posts:searchFeed', { matched: 3, truncated: false, page: [] });
    page({ q: 'narrows' });
    expect(screen.getByRole('searchbox', { name: 'Search reports' })).toHaveValue('narrows');
    expect(fakes.paginatedArgs.at(-1)).toEqual({ query: 'narrows', filters: {} });
    expect(screen.getByText('3 reports mention “narrows”, newest first')).toBeInTheDocument();
    const line = document.querySelector('[data-slot="latest-result-line"]') as HTMLElement;
    fireEvent.click(within(line).getByRole('button', { name: 'Clear search' }));
    expect(lastNavigation({ q: 'narrows' })).toMatchObject({
      search: { q: undefined },
      replace: true,
    });
  });

  it('says it is showing the closest hundred, and never counts under a filter', () => {
    m.flags['latest-text-search'] = true;
    m.filters = { qualityFloor: 'good' };
    fakes.queries.set('posts:searchFeed', { matched: 100, truncated: true, page: [] });
    const { rerender } = page({ q: 'ice' });
    expect(
      screen.getByText(/Showing the closest 100 reports that mention “ice”/),
    ).toBeInTheDocument();
    fakes.queries.set('posts:searchFeed', { matched: 40, truncated: false, page: [] });
    rerender(<LatestPage search={{ q: 'ice' }} />);
    expect(
      screen.getByText('Reports that mention “ice” under your filters, newest first'),
    ).toBeInTheDocument();
  });

  it('has its own empty state', () => {
    m.flags['latest-text-search'] = true;
    fakes.paginated = { results: [], status: 'Exhausted', loadMore: vi.fn() };
    page({ q: 'zzz' });
    expect(screen.getByText(/No reports mention that/)).toBeInTheDocument();
  });

  it('puts debounced typing in the URL with replace', () => {
    vi.useFakeTimers();
    m.flags['latest-text-search'] = true;
    page();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search reports' }), {
      target: { value: 'bridge' },
    });
    act(() => vi.advanceTimersByTime(300));
    vi.useRealTimers();
    expect(lastNavigation()).toMatchObject({ search: { q: 'bridge' }, replace: true });
  });
});

describe('LatestPage · skater filter (latest-skater-filter)', () => {
  it('ignores ?skater= while the flag is off', () => {
    page({ skater: 'sberman' });
    expect(fakes.paginatedArgs.at(-2)).toEqual({ filters: {} });
  });

  it('narrows the feed to one person and says so', () => {
    m.flags['latest-skater-filter'] = true;
    fakes.queries.set('posts:listFeed', { page: [], isDone: true });
    page({ skater: 'sberman' });
    expect(fakes.paginatedArgs.at(-2)).toEqual({ filters: {}, skater: 'sberman' });
    expect(screen.getByText('Reports by @sberman, newest first')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show everyone' }));
    expect(lastNavigation({ skater: 'sberman' })).toMatchObject({ search: { skater: undefined } });
  });

  it('says when that person’s reports can’t be shown (skaterUnavailable)', () => {
    m.flags['latest-skater-filter'] = true;
    fakes.queries.set('posts:listFeed', { page: [], isDone: true, skaterUnavailable: true });
    page({ skater: 'private' });
    expect(screen.getByText(/reports aren’t available here/)).toBeInTheDocument();
    expect(screen.queryByText('Reports by @private, newest first')).toBeNull();
  });

  it('carries the skater into a search', () => {
    m.flags['latest-skater-filter'] = true;
    m.flags['latest-text-search'] = true;
    fakes.queries.set('posts:searchFeed', {
      matched: 0,
      truncated: false,
      skaterUnavailable: true,
    });
    page({ skater: 'gone', q: 'x' });
    expect(fakes.paginatedArgs.at(-1)).toEqual({ query: 'x', filters: {}, skater: 'gone' });
    expect(screen.getByText(/reports aren’t available here/)).toBeInTheDocument();
  });
});

describe('LatestPage · on the map (4.4)', () => {
  it('declares the Latest map spec, shows the In view list and the banner', () => {
    m.filters = { weather: { thresholdF: 20, minNights: 3 }, radiusMinutes: 60 };
    page({ view: 'map' });
    expect(useSkaterMapStore.getState().specs.view?.id).toBe('latest');
    expect(useSkaterMapStore.getState().specs.view?.visible).toBe(true);
    expect(screen.getByText('In view')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      /Showing lakes with 3\+ nights below 20°F · within 60 min/,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(setFilters).toHaveBeenCalledWith({ radiusMinutes: 60 });
    fireEvent.click(screen.getByRole('button', { name: 'Back to Latest' }));
    expect(lastNavigation({ view: 'map' })).toMatchObject({ search: { view: undefined } });
  });

  it('is reached from the weather box', () => {
    m.filters = { weather: { thresholdF: 20, minNights: 3 } };
    fakes.queries.set('weatherDiscovery:listBodyResults', { results: [], exhausted: true });
    page();
    fireEvent.click(screen.getByRole('button', { name: 'Show on the map' }));
    expect(lastNavigation()).toMatchObject({ search: { view: 'map' } });
  });

  it('takes its map with it when it leaves', () => {
    const { unmount } = page({ view: 'map' });
    unmount();
    expect(useSkaterMapStore.getState().specs.view).toBeNull();
  });
});
