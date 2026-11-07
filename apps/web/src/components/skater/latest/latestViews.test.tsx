import type { FeedCardData, FeedFilters } from '@skating/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { polyfillAnimate } from '../panels/panelTestMocks';
import { FeedColumn, type FeedColumnProps } from './FeedColumn';
import { FilterColumn } from './FilterColumn';
import { LatestFrame } from './LatestFrame';
import { MapBanner } from './LatestMapView';
import { MATCH, NOW, POST, REPORT } from './latestFixtures';
import { latestSections } from './latestModel';
import { RecommendedStrip } from './RecommendedStrip';
import { SEARCH_DEBOUNCE_MS, SearchReportsInput } from './SearchReportsInput';
import { WantedColumn } from './WantedColumn';
import { WeatherMatchCard, weatherMatchHref } from './WeatherMatchCard';

beforeAll(() => {
  polyfillAnimate();
  // jsdom has no font loading; the list-end tab re-fits once the fonts land.
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
});
afterEach(() => vi.useRealTimers());

const HOUR = 3_600_000;

/** Base UI's select takes a mouse click only when the press started on the option. */
async function pick(name: string) {
  const option = await screen.findByRole('option', { name });
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
}

describe('FilterColumn', () => {
  const renderColumn = (
    filters: FeedFilters,
    weather: { available: boolean; asOfDayMs: number | null } = { available: true, asOfDayMs: NOW },
  ) => {
    const onChange = vi.fn();
    const onShowOnMap = vi.fn();
    render(
      <FilterColumn
        filters={filters}
        onChange={onChange}
        weather={weather}
        onShowOnMap={onShowOnMap}
        homeLink={<button type="button">Change home</button>}
      />,
    );
    return { onChange, onShowOnMap };
  };

  it('counts what is on and clears it all', () => {
    const { onChange } = renderColumn({ qualityFloor: 'good', recencyHours: 24 });
    expect(screen.getByRole('heading', { name: 'Filters · 2' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onChange).toHaveBeenCalledWith({});
  });

  it('has no clear-all when nothing is on, and says filters are floors', () => {
    renderColumn({});
    expect(screen.getByRole('heading', { name: 'Filters' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
    expect(screen.getByText(/filters only set a floor/)).toBeInTheDocument();
  });

  it('sets quality and posted from their segments, and Any drops them', () => {
    const { onChange } = renderColumn({ qualityFloor: 'good' });
    fireEvent.click(screen.getByRole('button', { name: 'Great' }));
    expect(onChange).toHaveBeenLastCalledWith({ qualityFloor: 'great' });
    fireEvent.click(screen.getByRole('button', { name: 'Any' }));
    expect(onChange).toHaveBeenLastCalledWith({});
    fireEvent.click(screen.getByRole('button', { name: '48 h' }));
    expect(onChange).toHaveBeenLastCalledWith({ qualityFloor: 'good', recencyHours: 48 });
  });

  it('clears posted from Any time', () => {
    const { onChange } = renderColumn({ recencyHours: 24 });
    fireEvent.click(screen.getByRole('button', { name: 'Any time' }));
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('picks a drive time, and Any distance drops it', async () => {
    const { onChange } = renderColumn({});
    fireEvent.click(screen.getByRole('combobox', { name: 'Drive time' }));
    await pick('Within 60 minutes');
    expect(onChange).toHaveBeenLastCalledWith({ radiusMinutes: 60 });
  });

  it('drops the drive time from Any distance', async () => {
    const { onChange } = renderColumn({ radiusMinutes: 30 });
    expect(screen.getByRole('combobox', { name: 'Drive time' })).toHaveTextContent(
      'Within 30 minutes',
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Drive time' }));
    await pick('Any distance');
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('keeps ideal ice split into ice types and surface tags', () => {
    const { onChange } = renderColumn({ iceTypes: ['black_ice'] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Glass' }));
    expect(onChange).toHaveBeenLastCalledWith({ iceTypes: ['black_ice'], surfaceTags: ['glass'] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Black ice' }));
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('commits a thickness floor in inches, stored in cm, and blank drops it', () => {
    const { onChange } = renderColumn({});
    const input = screen.getByRole('textbox', { name: 'Thickness at least' });
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith({ thicknessFloorCm: 10.16 });
  });

  it('shows a saved thickness in inches and drops it when cleared', () => {
    const { onChange } = renderColumn({ thicknessFloorCm: 10.16 });
    const input = screen.getByRole('textbox', { name: 'Thickness at least' });
    expect(input).toHaveValue('4');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('toggles no snow cover', () => {
    const { onChange } = renderColumn({ noSnow: true });
    fireEvent.click(screen.getByRole('checkbox', { name: 'No snow cover' }));
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('turns the weather filter on at three nights', async () => {
    const { onChange } = renderColumn({});
    fireEvent.click(screen.getByRole('combobox', { name: 'Weather' }));
    await pick('Below 20°F');
    expect(onChange).toHaveBeenLastCalledWith({ weather: { minNights: 3, thresholdF: 20 } });
  });

  it('draws the weather box when on: its date, nights, no snow since, reports only, the map', async () => {
    const filters: FeedFilters = {
      weather: { thresholdF: 20, minNights: 3, noSnowSince: true },
    };
    const { onChange, onShowOnMap } = renderColumn(filters, {
      available: true,
      asOfDayMs: Date.UTC(2027, 0, 15, 12),
    });
    const box = screen.getByRole('group', { name: 'Weather' });
    expect(within(box).getByText(/^As of Jan 1[45]$/)).toBeInTheDocument();
    expect(within(box).getByText(/never the ice/)).toBeInTheDocument();
    fireEvent.click(within(box).getByRole('checkbox', { name: 'No snow since the first night' }));
    expect(onChange).toHaveBeenLastCalledWith({ weather: { thresholdF: 20, minNights: 3 } });
    fireEvent.click(within(box).getByRole('checkbox', { name: 'Only show reports' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, onlyReports: true });
    fireEvent.click(within(box).getByRole('button', { name: 'Show on the map' }));
    expect(onShowOnMap).toHaveBeenCalled();
    fireEvent.click(within(box).getByRole('combobox', { name: 'At least' }));
    await pick('5 nights in a row');
    expect(onChange).toHaveBeenLastCalledWith({ weather: { ...filters.weather, minNights: 5 } });
  });

  it('turns weather off from Any weather, taking the reports-only hatch with it', async () => {
    const { onChange } = renderColumn({
      weather: { thresholdF: 20, minNights: 3 },
      onlyReports: true,
      qualityFloor: 'good',
    });
    fireEvent.click(screen.getByRole('combobox', { name: 'Nights below' }));
    await pick('Any weather');
    expect(onChange).toHaveBeenLastCalledWith({ qualityFloor: 'good' });
  });

  it('turns the no-snow-since box back on', () => {
    const { onChange } = renderColumn({ weather: { thresholdF: 10, minNights: 2 } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'No snow since the first night' }));
    expect(onChange).toHaveBeenLastCalledWith({
      weather: { thresholdF: 10, minNights: 2, noSnowSince: true },
    });
  });

  it('disables weather out of season and says why (4.13)', () => {
    renderColumn(
      { weather: { thresholdF: 20, minNights: 3 } },
      { available: false, asOfDayMs: null },
    );
    expect(screen.getByRole('combobox', { name: 'Nights below' })).toHaveAttribute('data-disabled');
    expect(screen.getByText('No weather data yet this season.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show on the map' })).toBeNull();
  });

  it('disables the off weather select too, with the same reason', () => {
    renderColumn({}, { available: false, asOfDayMs: null });
    expect(screen.getByRole('combobox', { name: 'Weather' })).toHaveAttribute('data-disabled');
    expect(screen.getByText('No weather data yet this season.')).toBeInTheDocument();
  });

  it('puts the search on top when the page passes one', () => {
    render(
      <FilterColumn
        filters={{}}
        onChange={vi.fn()}
        weather={undefined}
        onShowOnMap={vi.fn()}
        homeLink={null}
        search={<input aria-label="Search reports" />}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Search reports' })).toBeInTheDocument();
  });
});

describe('SearchReportsInput', () => {
  it('waits for typing to rest 300 ms, then commits the trimmed words', () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    render(<SearchReportsInput value={undefined} onCommit={onCommit} />);
    const input = screen.getByRole('searchbox', { name: 'Search reports' });
    fireEvent.change(input, { target: { value: 'narr' } });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1));
    fireEvent.change(input, { target: { value: ' narrows ' } });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1));
    expect(onCommit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('narrows');
  });

  it('clears from its button and from Esc, and follows the URL', () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    const { rerender } = render(<SearchReportsInput value="narrows" onCommit={onCommit} />);
    const input = screen.getByRole('searchbox', { name: 'Search reports' });
    expect(input).toHaveValue('narrows');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onCommit).toHaveBeenCalledWith(undefined);
    rerender(<SearchReportsInput value={undefined} onCommit={onCommit} />);
    expect(input).toHaveValue('');

    rerender(<SearchReportsInput value="bridge" onCommit={onCommit} />);
    expect(input).toHaveValue('bridge');
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(outer).not.toHaveBeenCalled();
    expect(input).toHaveValue('');
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(onCommit).toHaveBeenLastCalledWith(undefined);
    // An empty field lets Esc through to whatever is above it.
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(outer).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', outer);
  });

  it('keeps a trailing space the URL already agrees with', () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    const { rerender } = render(<SearchReportsInput value={undefined} onCommit={onCommit} />);
    const input = screen.getByRole('searchbox', { name: 'Search reports' });
    fireEvent.change(input, { target: { value: 'black ' } });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    rerender(<SearchReportsInput value="black" onCommit={onCommit} />);
    expect(input).toHaveValue('black ');
  });
});

function feedProps(over: Partial<FeedColumnProps> = {}): FeedColumnProps {
  return {
    state: 'feed',
    sections: latestSections([POST], new Set(), [MATCH], true, NOW),
    now: NOW,
    canLoadMore: false,
    loadingMore: false,
    onLoadMore: vi.fn(),
    exhausted: true,
    bodiesShown: null,
    recentCold: undefined,
    firstPostEnd: POST.latestSkateEndTime,
    reportHref: (id) => `/latest?report=${id}`,
    onOpenReport: vi.fn(),
    onOpenLake: vi.fn(),
    onClearFilters: vi.fn(),
    onWeatherOff: vi.fn(),
    onOpenMap: vi.fn(),
    onClearSearch: vi.fn(),
    onClearSkater: vi.fn(),
    ...over,
  };
}

describe('FeedColumn', () => {
  it('draws the sections, the posts and the matched lakes, and ends the list', () => {
    const props = feedProps();
    render(<FeedColumn {...props} />);
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByText('Mascoma South, first real day')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Weather match: Smith Pond/ })).toBeInTheDocument();
    expect(screen.getByText('That’s everything')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: /^Report on Mascoma South/ }));
    expect(props.onOpenReport).toHaveBeenCalledWith('rep1');
  });

  it('offers Load more, a skeleton while it loads, and the matched-lakes cap', () => {
    const props = feedProps({ canLoadMore: true, exhausted: false, bodiesShown: 2 });
    const { rerender } = render(<FeedColumn {...props} />);
    expect(screen.getByText(/Showing the 2 most recently matched lakes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(props.onLoadMore).toHaveBeenCalled();
    expect(screen.queryByText('That’s everything')).toBeNull();
    rerender(<FeedColumn {...props} canLoadMore={false} loadingMore />);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('says when it is showing last season (D63)', () => {
    render(<FeedColumn {...feedProps({ firstPostEnd: NOW - 400 * 24 * HOUR })} />);
    expect(screen.getByText(/^From the .* season$/)).toBeInTheDocument();
  });

  it('draws the header it is given (a search line)', () => {
    render(<FeedColumn {...feedProps({ header: <p>3 reports mention “x”</p> })} />);
    expect(screen.getByText('3 reports mention “x”')).toBeInTheDocument();
  });

  it('loads in the boards’ shapes (4.15)', () => {
    render(<FeedColumn {...feedProps({ state: 'loading' })} />);
    expect(screen.getByText('Loading reports')).toBeInTheDocument();
  });

  it.each([
    [
      'skater-unavailable',
      /reports aren’t available here/,
      'Show everyone’s reports',
      'onClearSkater',
    ],
    ['search-empty', /No reports mention that/, 'Clear search', 'onClearSearch'],
    [
      'no-weather-data',
      /No weather data yet this season/,
      'Turn off the weather filter',
      'onWeatherOff',
    ],
    [
      'no-lake-match',
      /No lake matches that weather yet/,
      'Turn off the weather filter',
      'onWeatherOff',
    ],
    [
      'nothing-on-page',
      /Load more to keep looking further back/,
      'Clear all filters',
      'onClearFilters',
    ],
    [
      'nothing-matches',
      /No reports this season match these filters/,
      'Clear all filters',
      'onClearFilters',
    ],
    ['no-reports', /^No reports yet\. They show up here/, 'Open the map', 'onOpenMap'],
  ] as const)('%s says so, with its way out', (state, line, action, handler) => {
    const props = feedProps({ state, canLoadMore: true });
    render(<FeedColumn {...props} />);
    expect(screen.getByText(line)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: action }));
    expect(props[handler]).toHaveBeenCalled();
  });

  it('offers Load more in the empty states that can look further back', () => {
    const props = feedProps({ state: 'nothing-on-page', canLoadMore: true });
    render(<FeedColumn {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(props.onLoadMore).toHaveBeenCalled();
  });

  it('fills an empty season with recent cold weather (4.10), or says there is none (4.18)', () => {
    const props = feedProps({ state: 'no-reports', recentCold: [MATCH] });
    const { rerender } = render(<FeedColumn {...props} />);
    expect(screen.getByRole('heading', { name: 'Recent cold weather' })).toBeInTheDocument();
    expect(screen.getByText('3 nights below 20°F')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: /Smith Pond/ }));
    expect(props.onOpenLake).toHaveBeenCalledWith('wb2', null);
    rerender(<FeedColumn {...props} recentCold={[]} />);
    expect(screen.getByText(/no lake has had a run of cold nights/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Recent cold weather' })).toBeNull();
  });
});

describe('WeatherMatchCard', () => {
  it('links the lake, or the bay the match was read at', () => {
    expect(weatherMatchHref({ waterBodyId: 'wb 1', focusSubAreaId: null })).toBe('/water/wb%201');
    expect(weatherMatchHref({ waterBodyId: 'wb1', focusSubAreaId: 's1' })).toBe(
      '/water/wb1?sub=s1',
    );
  });

  it('names the weather, never the ice, with the hike-in, the star and the caveat', () => {
    const onOpen = vi.fn();
    render(
      <WeatherMatchCard
        data={{
          ...MATCH,
          isFavorite: true,
          oneSampleForALargeBody: true,
          otherBayNames: ['Shelburne Bay'],
        }}
        now={NOW}
        onOpen={onOpen}
      />,
    );
    const card = screen.getByRole('link');
    expect(card).toHaveAttribute('href', '/water/wb2');
    expect(within(card).getByText('Weather match')).toBeInTheDocument();
    expect(within(card).getByRole('img', { name: 'Favorite' })).toBeInTheDocument();
    expect(within(card).getByText('Hike-in')).toBeInTheDocument();
    expect(within(card).getByText(/one point near the middle/)).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/safe|skateable|good to go/i);
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledWith('wb2', null);
  });
});

describe('RecommendedStrip', () => {
  it('is absent with nothing to recommend', () => {
    const { container } = render(
      <RecommendedStrip bundles={[]} now={NOW} reportHref={String} onOpenReport={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
    render(
      <RecommendedStrip bundles={undefined} now={NOW} reportHref={String} onOpenReport={vi.fn()} />,
    );
  });

  it('labels itself a filter-breaker and opens the newest report of each lake', () => {
    const onOpen = vi.fn();
    render(
      <RecommendedStrip
        bundles={[
          { waterBodyId: 'wb1', cards: [REPORT, { ...REPORT, reportId: 'rep2' }] },
          { waterBodyId: 'wb9', cards: [] },
        ]}
        now={NOW}
        reportHref={(id) => `/latest?report=${id}`}
        onOpenReport={onOpen}
      />,
    );
    expect(screen.getByText(/outside your usual filters/)).toBeInTheDocument();
    const card = screen.getByRole('link', {
      name: /^Recommended: Mascoma Lake, 2 reports · Great · Today/,
    });
    expect(card).toHaveAttribute('href', '/latest?report=rep1');
    expect(within(card).getByRole('img', { name: 'Favorite' })).toBeInTheDocument();
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledWith('rep1');
  });

  it('says one report, and leaves out a quality it was not given', () => {
    render(
      <RecommendedStrip
        bundles={[
          {
            waterBodyId: 'wb1',
            cards: [
              { ...REPORT, skateQuality: undefined, isFavorite: false } as unknown as FeedCardData,
            ],
          },
        ]}
        now={NOW}
        reportHref={String}
        onOpenReport={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('link', { name: 'Recommended: Mascoma Lake, 1 report · Today' }),
    ).toBeInTheDocument();
  });
});

describe('WantedColumn', () => {
  const place = {
    key: 'w1|Mascoma North',
    bountyId: 'b1',
    place: 'Mascoma North',
    lake: 'Mascoma Lake',
    count: 3,
    firstAsker: { displayName: 'Rob Tremblay' },
    expiresAt: NOW + 5 * 24 * HOUR + 60_000,
    answered: 0,
  };

  it('is absent entirely when nobody wants a look (4.17)', () => {
    const { container, rerender } = render(
      <WantedColumn places={[]} now={NOW} onOpenBounty={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<WantedColumn places={undefined} now={NOW} onOpenBounty={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('draws a place with its asks, who asked first, and opens the bounty (4.16)', () => {
    const onOpen = vi.fn();
    render(
      <WantedColumn
        places={[
          place,
          {
            ...place,
            key: 'k2',
            bountyId: 'b2',
            place: 'Crystal Lake',
            lake: null,
            count: 1,
            firstAsker: null,
          },
        ]}
        now={NOW}
        onOpenBounty={onOpen}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Wanted near you' })).toBeInTheDocument();
    expect(screen.getByText('open bounties', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Rob Tremblay')).toBeInTheDocument();
    expect(screen.getAllByText('Expires in 5 days · No reports yet')).toHaveLength(2);
    expect(screen.getByText(/open\s+bounty$/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Open the bounty at Mascoma North on the map' }),
    );
    expect(onOpen).toHaveBeenCalledWith('b1');
  });
});

describe('MapBanner', () => {
  it('says what the map dims by, goes back, and clears the weather', () => {
    const onBack = vi.fn();
    const onClear = vi.fn();
    const { rerender } = render(
      <MapBanner
        line="Showing lakes with 3+ nights below 20°F"
        weatherOn
        onBack={onBack}
        onClearWeather={onClear}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Showing lakes with 3+ nights below 20°F');
    fireEvent.click(screen.getByRole('button', { name: 'Back to Latest' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onBack).toHaveBeenCalled();
    expect(onClear).toHaveBeenCalled();
    rerender(<MapBanner line="x" weatherOn={false} onBack={onBack} onClearWeather={onClear} />);
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });
});

describe('LatestFrame', () => {
  it('lays out three named columns, and makes the feed inert under an open report', () => {
    const { rerender } = render(
      <LatestFrame
        filters={<p>f</p>}
        feed={<button type="button">in the feed</button>}
        aside={<p>a</p>}
      />,
    );
    expect(screen.getByRole('complementary', { name: 'Filters' })).toBeInTheDocument();
    expect(screen.getByRole('main', { name: 'Latest' })).toBeInTheDocument();
    expect(
      screen.getByRole('complementary', { name: 'Recommended and wanted' }),
    ).toBeInTheDocument();
    const scroller = document.querySelector('[data-slot="latest-feed-scroll"]');
    expect(scroller).not.toHaveAttribute('inert');
    rerender(
      <LatestFrame
        filters={<p>f</p>}
        feed={<button type="button">in the feed</button>}
        aside={<p>a</p>}
        report={<p>the card</p>}
      />,
    );
    expect(document.querySelector('[data-slot="latest-feed-scroll"]')).toBe(scroller);
    expect(scroller).toHaveAttribute('inert');
    expect(document.querySelector('[data-slot="panel-column"]')).toHaveTextContent('the card');
  });
});
