import type { FeedCardData, FeedFilters, PostCardData } from '@skating/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Button } from '../../kit/button';
import { must } from '../../kit/storyKit';
import { InsetCard } from '../panels/InsetCard';
import { BOARD_NOW, CARD_PAT, POST_ANA, REPORT_PAT } from '../panels/panelFixtures';
import { ReportPanelView } from '../panels/ReportPanelView';
import { StoryRouter } from '../panels/storyRouter';
import { SkaterPair } from '../storySupport';
import { FeedColumn, type FeedColumnProps } from './FeedColumn';
import { ChangeHomeLabel, FilterColumn } from './FilterColumn';
import { LatestFrame } from './LatestFrame';
import { MapBanner } from './LatestMapView';
import { MATCH as MATCH_NOW } from './latestFixtures';
import {
  type FeedState,
  groupWanted,
  latestSections,
  mapBannerLine,
  searchSummary,
} from './latestModel';
import { RecommendedStrip } from './RecommendedStrip';
import { SearchReportsInput } from './SearchReportsInput';
import { WantedColumn } from './WantedColumn';

/**
 * Row 4, Latest (4.1–4.18), props only: the filter column, the feed, Recommended and *Wanted near
 * you*, in the skater dark / light pair. The page wires these to Convex and the router; here the
 * filters are a story's own state, so the keyboard paths really change them.
 */
const meta = {
  title: 'Skater/Latest',
  component: LatestFrame,
  globals: { surface: 'skater', mode: 'light' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof LatestFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

const NOW = BOARD_NOW;
const HOUR = 3_600_000;
/** The boards' clock: Smith Pond crossed its fifth night this morning, read as of yesterday. */
const MATCH = {
  ...MATCH_NOW,
  eventMs: NOW + 5 * HOUR,
  eventDayMs: NOW + 5 * HOUR,
  asOfDayMs: NOW - 24 * HOUR,
};

const quads = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>('[data-skater-pair] > section'),
];

const PAT: PostCardData = {
  postId: 'post-pat',
  title: 'Mascoma South, first real day',
  body: 'Black ice from the Shaker Bridge launch to the islands, a skim of new snow past them. Drilled 5″ off the beach and 4″ near the islands. Wind came up from the northwest around noon and the surface went from glass to a little rough.',
  latestSkateEndTime: CARD_PAT.skateEndTime,
  author: CARD_PAT.author,
  blocked: false,
  isFavorite: false,
  omittedCount: 0,
  reports: [CARD_PAT],
} as PostCardData;

const CRYSTAL: FeedCardData = {
  ...CARD_PAT,
  reportId: 'rec-crystal',
  waterBodyId: 'crystal',
  bodyName: 'Crystal Lake',
  subAreaName: undefined,
  skateQuality: 'great',
  iceTypes: [],
  surfaceTags: ['glass'],
} as FeedCardData;

const WANTED = groupWanted(
  [
    {
      _id: 'b1',
      waterBodyId: 'mascoma',
      waterBodyName: 'Mascoma Lake',
      subAreaName: 'Mascoma North',
      requester: { displayName: 'Rob Tremblay' },
      fulfillingCount: 0,
      createdAt: 1,
      expiresAt: NOW + 5 * 86_400_000 + 60_000,
    },
    {
      _id: 'b2',
      waterBodyId: 'mascoma',
      waterBodyName: 'Mascoma Lake',
      subAreaName: 'Mascoma North',
      requester: { displayName: 'Ana Morales' },
      fulfillingCount: 0,
      createdAt: 2,
      expiresAt: NOW + 3 * 86_400_000,
    },
    {
      _id: 'b3',
      waterBodyId: 'mascoma',
      waterBodyName: 'Mascoma Lake',
      subAreaName: 'Mascoma North',
      requester: { displayName: 'Matt Ochs' },
      fulfillingCount: 0,
      createdAt: 3,
      expiresAt: NOW + 2 * 86_400_000,
    },
  ],
  3,
);

const noop = () => {};

/** One Latest page from props, its filters held in story state. */
function Page({
  initial = { qualityFloor: 'good', radiusMinutes: 60 },
  state = 'feed',
  weatherAvailable = true,
  search,
  wanted = false,
  report,
  feed,
  onFilters,
}: {
  initial?: FeedFilters;
  state?: FeedState;
  weatherAvailable?: boolean;
  search?: string;
  wanted?: boolean;
  report?: ReactNode;
  feed?: Partial<FeedColumnProps>;
  onFilters?: (next: FeedFilters) => void;
}) {
  const [filters, setFilters] = useState<FeedFilters>(initial);
  const weatherOn = filters.weather !== undefined;
  const props: FeedColumnProps = {
    state,
    sections: latestSections(
      search !== undefined ? [PAT] : [PAT, POST_ANA],
      new Set(),
      weatherOn ? [MATCH] : [],
      true,
      NOW,
    ),
    now: NOW,
    canLoadMore: true,
    loadingMore: false,
    onLoadMore: noop,
    exhausted: false,
    bodiesShown: weatherOn ? 1 : null,
    recentCold: undefined,
    firstPostEnd: PAT.latestSkateEndTime,
    reportHref: (id) => `/latest?report=${id}`,
    onOpenReport: noop,
    onOpenLake: noop,
    onClearFilters: () => setFilters({}),
    onWeatherOff: noop,
    onOpenMap: noop,
    onClearSearch: noop,
    onClearSkater: noop,
    header:
      search !== undefined ? (
        <p className="m-0 text-body text-fg1">
          {searchSummary({ query: search, matched: 3, truncated: false, filtersOn: false })}
        </p>
      ) : undefined,
    ...feed,
  };
  return (
    <StoryRouter>
      <LatestFrame
        filters={
          <FilterColumn
            filters={filters}
            onChange={(next) => {
              setFilters(next);
              onFilters?.(next);
            }}
            weather={{ available: weatherAvailable, asOfDayMs: NOW - 86_400_000 }}
            search={
              search !== undefined ? (
                <SearchReportsInput value={search} onCommit={noop} />
              ) : undefined
            }
            onShowOnMap={noop}
            homeLink={
              <Button size="xs">
                <ChangeHomeLabel />
              </Button>
            }
          />
        }
        feed={<FeedColumn {...props} />}
        aside={
          state === 'no-reports' || state === 'loading' ? null : (
            <>
              <RecommendedStrip
                bundles={[
                  { waterBodyId: 'crystal', cards: [CRYSTAL, { ...CRYSTAL, reportId: 'c2' }] },
                ]}
                now={NOW}
                reportHref={(id) => `/latest?report=${id}`}
                onOpenReport={noop}
              />
              <WantedColumn places={wanted ? WANTED : []} now={NOW} onOpenBounty={noop} />
            </>
          )
        }
        report={report}
      />
    </StoryRouter>
  );
}

/** 4.1 (4.3 is the light quad): the three columns. Keyboard: the quality segment and Clear all. */
export const Default: Story = {
  args: {} as never,
  render: () => {
    const onFilters = fn();
    return (
      <SkaterPair height="82rem">
        {(mode) => <Page onFilters={mode === 'dark' ? onFilters : undefined} />}
      </SkaterPair>
    );
  },
  play: async ({ canvasElement }) => {
    const [dark] = quads(canvasElement);
    const q = within(must(dark));
    await expect(q.getByRole('heading', { name: 'Filters · 2' })).toBeVisible();
    // Only what you press is rounded: the segment is 2 px, the plates square.
    const good = q.getByRole('button', { name: 'Good or better' });
    await expect(good).toHaveAttribute('aria-pressed', 'true');
    const recommended = must(dark?.querySelector<HTMLElement>('[data-slot="recommended-card"]'));
    await expect(getComputedStyle(recommended).borderRadius).toBe('0px');
    // Arrow along the segment, Enter chooses.
    good.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(q.getByRole('button', { name: 'Great' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(q.getByRole('button', { name: 'Great' })).toHaveAttribute('aria-pressed', 'true'),
    );
    // Tab reaches Clear all from the search-less column's head, and Enter clears.
    q.getByRole('button', { name: 'Clear all' }).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(q.getByRole('heading', { name: 'Filters' })).toBeVisible());
  },
};

/** 4.2: the weather filter on — its box, and the matched lakes among the posts. */
export const WeatherFilter: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="92rem">
      {() => <Page initial={{ weather: { thresholdF: 20, minNights: 3, noSnowSince: true } }} />}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const [dark] = quads(canvasElement);
    const q = within(must(dark));
    const box = q.getByRole('group', { name: 'Weather' });
    await expect(within(box).getByText(/never the ice/)).toBeVisible();
    const match = q.getByRole('link', { name: /^Weather match: Smith Pond/ });
    await expect(getComputedStyle(match).borderRadius).toBe('0px');
    await expect(q.getByText(/Showing the 1 most recently matched lakes/)).toBeVisible();
  },
};

/**
 * 4.5–4.7: a report open over the center column. Keyboard: Enter on a feed card opens it, Esc closes
 * it, and the feed is where it was — its scroll survives, and focus comes back to the card.
 */
function ReportHarness() {
  const [open, setOpen] = useState(false);
  return (
    <Page
      feed={{
        onOpenReport: () => setOpen(true),
        selectedReportId: open ? CARD_PAT.reportId : undefined,
      }}
      report={
        open ? (
          <InsetCard
            backTo="Latest"
            label="Report"
            returnKey={`report:${CARD_PAT.reportId}`}
            onClose={() => setOpen(false)}
          >
            <ReportPanelView data={REPORT_PAT} />
          </InsetCard>
        ) : undefined
      }
    />
  );
}

export const ReportOpen: Story = {
  args: {} as never,
  render: () => <SkaterPair height="60rem">{() => <ReportHarness />}</SkaterPair>,
  play: async ({ canvasElement }) => {
    const [dark] = quads(canvasElement);
    const root = must(dark);
    const q = within(root);
    const scroller = must(root.querySelector<HTMLElement>('[data-slot="latest-feed-scroll"]'));
    scroller.scrollTop = 120;
    const scrolled = scroller.scrollTop;
    await expect(scrolled).toBeGreaterThan(0);
    const card = q.getByRole('link', { name: /^Report on Mascoma South/ });
    card.focus();
    await userEvent.keyboard('{Enter}');
    const inset = await q.findByRole('dialog');
    await expect(within(inset).getByRole('button', { name: /Back to Latest/ })).toBeVisible();
    await expect(scroller).toHaveAttribute('inert');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(q.queryByRole('dialog')).toBeNull());
    await expect(scroller.scrollTop).toBe(scrolled);
    await waitFor(() => expect(card).toHaveFocus());
  },
};

/** 4.9: text search — the line, the words in the box (behind `latest-text-search`). */
export const SearchReports: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="60rem">{() => <Page initial={{}} search="narrows" />}</SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const q = within(must(quads(canvasElement)[0]));
    await expect(q.getByText('3 reports mention “narrows”, newest first')).toBeVisible();
    const box = q.getByRole('searchbox', { name: 'Search reports' });
    box.focus();
    await userEvent.keyboard('{Escape}');
    await expect(box).toHaveValue('');
  },
};

/** 4.10: no reports this season — the lakes with a recent run of cold nights fill the feed. */
export const NoReportsYet: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="56rem">
      {() => (
        <Page
          initial={{}}
          state="no-reports"
          feed={{
            recentCold: [
              MATCH,
              { ...MATCH, waterBodyId: 'crystal', name: 'Crystal Lake', isFavorite: true },
            ],
          }}
        />
      )}
    </SkaterPair>
  ),
};

/** 4.18: no reports, and no lake has had a run of cold nights. */
export const NoReportsNoWeather: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="56rem">
      {() => <Page initial={{}} state="no-reports" feed={{ recentCold: [] }} />}
    </SkaterPair>
  ),
};

/** 4.11: the filters emptied this page. Keyboard: Tab to Clear all filters, Enter clears. */
export const NothingMatches: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="56rem">
      {() => (
        <Page
          initial={{ thicknessFloorCm: 15.24, qualityFloor: 'great' }}
          state="nothing-on-page"
        />
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const q = within(must(quads(canvasElement)[0]));
    q.getByRole('button', { name: 'Clear all filters' }).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(q.getByRole('heading', { name: 'Filters' })).toBeVisible());
  },
};

/** 4.12: a weather filter that matched no lake. */
export const NoLakeMatches: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="70rem">
      {() => <Page initial={{ weather: { thresholdF: 20, minNights: 3 } }} state="no-lake-match" />}
    </SkaterPair>
  ),
};

/** 4.13: a weather filter with no weather data this season — the knobs disabled, and why. */
export const NoWeatherData: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="62rem">
      {() => (
        <Page
          initial={{ weather: { thresholdF: 20, minNights: 3 } }}
          state="no-weather-data"
          weatherAvailable={false}
        />
      )}
    </SkaterPair>
  ),
};

/** 4.15: the first page loading. */
export const Loading: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="56rem">{() => <Page initial={{}} state="loading" />}</SkaterPair>
  ),
};

/**
 * 4.16 (4.17 is Default: none, so the section is absent): the right column on its own, at its
 * board width — the page hides it below `xl`, which a side-by-side pair always is.
 */
export const WantedNearYou: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="40rem">
      {() => (
        <div className="flex w-[18.75rem] flex-col gap-(--space-6) p-(--space-7)">
          <RecommendedStrip
            bundles={[{ waterBodyId: 'crystal', cards: [CRYSTAL, { ...CRYSTAL, reportId: 'c2' }] }]}
            now={NOW}
            reportHref={(id) => `/latest?report=${id}`}
            onOpenReport={noop}
          />
          <WantedColumn places={WANTED} now={NOW} onOpenBounty={noop} />
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const [dark] = quads(canvasElement);
    const q = within(must(dark));
    await expect(q.getByRole('heading', { name: 'Wanted near you' })).toBeVisible();
    await expect(q.getByText('Rob Tremblay')).toBeVisible();
    const card = must(dark?.querySelector<HTMLElement>('[data-slot="wanted-card"]'));
    await expect(getComputedStyle(card).borderRadius).toBe('0px');
    // Keyboard: the bounty opens from its button.
    q.getByRole('button', { name: /Open the bounty at Mascoma North/ }).focus();
    await userEvent.keyboard('{Enter}');
  },
};

/** 4.4: the banner over the map (the map itself is the layout's one instance — see SkaterMap). */
export const OnTheMapBanner: Story = {
  args: {} as never,
  render: () => {
    const back = fn();
    return (
      <SkaterPair height="8rem">
        {(mode) => (
          <div className="relative h-full">
            <MapBanner
              line={mapBannerLine(
                { weather: { thresholdF: 20, minNights: 3, noSnowSince: true }, radiusMinutes: 60 },
                NOW - 86_400_000,
              )}
              weatherOn
              onBack={mode === 'dark' ? back : noop}
              onClearWeather={noop}
            />
          </div>
        )}
      </SkaterPair>
    );
  },
  play: async ({ canvasElement }) => {
    const q = within(must(quads(canvasElement)[0]));
    await expect(q.getByRole('status')).toHaveTextContent(/never|Showing lakes with 3\+ nights/);
    q.getByRole('button', { name: 'Back to Latest' }).focus();
    await userEvent.keyboard('{Enter}');
  },
};
