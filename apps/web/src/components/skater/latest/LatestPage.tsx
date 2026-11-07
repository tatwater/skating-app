import { api } from '@skating/convex/api';
import {
  type FeedFilters,
  hasWeatherFilter,
  type PostCardData,
  withoutWeatherFilter,
} from '@skating/core';
import { useCanGoBack, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { usePaginatedQuery, useQuery } from 'convex/react';
import { useCallback, useMemo } from 'react';

import { useAnalytics } from '@/lib/analytics';
import { useFeatureFlag } from '@/lib/featureFlags';
import { activeFilterCount } from '@/lib/feedFilters';
import { useFeedFilters } from '@/lib/feedFiltersStore';

import { Button } from '../../kit/button';
import { markWaterBodyOpenSource } from '../lake/openSource';
import { panelLinkState, panelSourceOf } from '../panels/panelNavigation';
import { ReportPanel } from '../panels/ReportPanel';
import { FeedColumn } from './FeedColumn';
import { ChangeHomeLabel, FilterColumn } from './FilterColumn';
import { LatestFrame } from './LatestFrame';
import { LatestMapView } from './LatestMapView';
import {
  changedFilters,
  groupWanted,
  latestFeedState,
  latestSections,
  type OpenBountyRow,
  type PageStatus,
  RECENT_COLD,
  searchSummary,
} from './latestModel';
import type { LatestSearch } from './latestSearch';
import { RecommendedStrip } from './RecommendedStrip';
import { SearchReportsInput } from './SearchReportsInput';
import { WantedColumn } from './WantedColumn';

/** How many posts a page of the feed asks for. */
export const PAGE_SIZE = 20;

/** How many places *Wanted near you* lists, and how many open bounties it reads to find them. */
const WANTED_PLACES = 3;
const WANTED_READ = 24;

/** The first page only, for what `usePaginatedQuery` drops: `matched`, `truncated`, `skaterUnavailable`. */
const META_PAGE = { numItems: 1, cursor: null };

/**
 * `/latest` (B03 §1.2, row 4): filters left, the feed center, Recommended and *Wanted near you*
 * right. The filters are the saved D166 row (`useFeedFilters`) — the same store the Explore map dims
 * by — and only the transient view rides the URL (D242): `?report=` opens a report over the center
 * column, `?q=` searches (flagged), `?skater=` narrows to one person (flagged), `?view=map` puts
 * the matches on the region map.
 */
export function LatestPage({ search }: { search: LatestSearch }) {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const locationState = useRouterState({ select: (s) => s.location.state });
  const analytics = useAnalytics();
  const filters = useFeedFilters();
  const textSearch = useFeatureFlag('latest-text-search', false);
  const skaterFilter = useFeatureFlag('latest-skater-filter', false);

  const query = textSearch ? search.q : undefined;
  const skater = skaterFilter ? search.skater : undefined;
  const searching = query !== undefined;
  const value = filters.value;
  const skaterArg = skater !== undefined ? { skater } : {};

  // ── The feed: the filtered list, or the search over it ───────────────────────────────────────
  const feed = usePaginatedQuery(
    api.posts.listFeed,
    searching ? 'skip' : { filters: value, ...skaterArg },
    { initialNumItems: PAGE_SIZE },
  );
  const found = usePaginatedQuery(
    api.posts.searchFeed,
    query !== undefined ? { query, filters: value, ...skaterArg } : 'skip',
    { initialNumItems: PAGE_SIZE },
  );
  const page = searching ? found : feed;
  const searchMeta = useQuery(
    api.posts.searchFeed,
    query !== undefined
      ? { query, filters: value, ...skaterArg, paginationOpts: META_PAGE }
      : 'skip',
  );
  const skaterMeta = useQuery(
    api.posts.listFeed,
    !searching && skater !== undefined
      ? { filters: value, skater, paginationOpts: META_PAGE }
      : 'skip',
  );
  const skaterUnavailable =
    skater !== undefined &&
    ((searching ? searchMeta : skaterMeta) as { skaterUnavailable?: true } | undefined)
      ?.skaterUnavailable === true;

  // Recommended filter-breakers (D50): their own strip, and out of the feed so none shows twice.
  const recommended = useQuery(api.reports.recommended, {});
  const recommendedIds = useMemo(
    () => new Set(recommended?.flatMap((rec) => rec.cards.map((c) => c.reportId)) ?? []),
    [recommended],
  );

  // The lakes the weather filter matched (D165), among the posts — not under a search, and not
  // when the skater asked for reports only.
  const discovery = useQuery(api.weatherDiscovery.status, {});
  const weatherOn = hasWeatherFilter(value) && !searching && skater === undefined;
  const bodyResults = useQuery(
    api.weatherDiscovery.listBodyResults,
    weatherOn && !value.onlyReports ? { filters: value } : 'skip',
  );

  const wantedRows = useQuery(api.bounties.listOpen, { sortByHome: true, limit: WANTED_READ });
  const wanted = useMemo(
    () =>
      wantedRows === undefined
        ? undefined
        : groupWanted(wantedRows as readonly OpenBountyRow[], WANTED_PLACES),
    [wantedRows],
  );

  // One clock per render: the feed re-renders as reports stream, and its labels move with it.
  const now = Date.now();
  const status = page.status as PageStatus;
  const posts = page.results as PostCardData[];
  const bodies = bodyResults?.results ?? [];
  const sections = latestSections(
    posts,
    searching ? new Set<string>() : recommendedIds,
    bodies,
    status === 'Exhausted',
    now,
  );
  const rowCount = sections.reduce((n, s) => n + s.items.length, 0);
  const state = latestFeedState({
    status,
    rowCount,
    filters: value,
    weatherAvailable: discovery?.available,
    searching,
    skaterUnavailable,
  });

  // 4.10: nothing reported this season — show the lakes with a recent run of cold nights.
  const recentCold = useQuery(
    api.weatherDiscovery.listBodyResults,
    state === 'no-reports' && skater === undefined ? { filters: { weather: RECENT_COLD } } : 'skip',
  );

  // ── Navigation ───────────────────────────────────────────────────────────────────────────────
  const setFilters = useCallback(
    (next: FeedFilters) => {
      for (const filter of changedFilters(value, next)) {
        analytics.capture('latest_filter_changed', { filter });
      }
      filters.set(next);
    },
    [analytics, filters, value],
  );

  const setSearch = useCallback(
    (patch: Partial<LatestSearch>, options: { replace?: boolean; state?: unknown } = {}) =>
      void navigate({
        to: '/latest',
        search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
        resetScroll: false,
        ...(options.replace ? { replace: true } : {}),
        ...(options.state !== undefined ? { state: options.state as never } : {}),
      } as never),
    [navigate],
  );

  const reportHref = useCallback(
    (reportId: string) => `/latest?report=${encodeURIComponent(reportId)}`,
    [],
  );
  const openReport = useCallback(
    (reportId: string) => {
      analytics.capture('latest_report_opened');
      setSearch({ report: reportId }, { state: panelLinkState('latest') });
    },
    [analytics, setSearch],
  );
  // Esc and "Back to Latest": a step back when the card was opened from this feed; a deep link has
  // no step to take, so the param goes with `replace` (§1.8) — the feed's scroll is untouched.
  const openedHere = panelSourceOf(locationState) === 'latest';
  const closeReport = useCallback(() => {
    if (openedHere && canGoBack) router.history.back();
    else setSearch({ report: undefined }, { replace: true });
  }, [openedHere, canGoBack, router, setSearch]);

  const openLake = useCallback(
    (waterBodyId: string, sub: string | null) => {
      markWaterBodyOpenSource('latest');
      void navigate({
        to: '/water/$id',
        params: { id: waterBodyId },
        search: sub !== null ? { sub } : {},
      } as never);
    },
    [navigate],
  );
  const openBounty = useCallback(
    (bountyId: string) => {
      analytics.capture('wanted_bounty_opened');
      void navigate({
        to: '/bounty/$id',
        params: { id: bountyId },
        state: panelLinkState('latest'),
      } as never);
    },
    [analytics, navigate],
  );
  const goTo = useCallback((href: string) => router.history.push(href), [router]);

  if (search.view === 'map') {
    return (
      <LatestMapView
        filters={value}
        asOfDayMs={discovery?.asOfDayMs ?? null}
        onBack={() => setSearch({ view: undefined })}
        onClearWeather={() => setFilters(withoutWeatherFilter(value))}
      />
    );
  }

  const filtersOn = activeFilterCount(value) > 0;
  const header =
    query !== undefined ? (
      <ResultLine
        line={searchSummary({
          query,
          matched: searchMeta?.matched,
          truncated: searchMeta?.truncated === true,
          filtersOn,
        })}
        action="Clear search"
        attr="latest-search-clear-line"
        onAction={() => setSearch({ q: undefined }, { replace: true })}
      />
    ) : skater !== undefined && !skaterUnavailable ? (
      <ResultLine
        line={`Reports by @${skater}, newest first`}
        action="Show everyone"
        attr="latest-skater-clear-line"
        onAction={() => setSearch({ skater: undefined }, { replace: true })}
      />
    ) : undefined;

  return (
    <LatestFrame
      filters={
        <FilterColumn
          filters={value}
          onChange={setFilters}
          weather={discovery}
          search={
            textSearch ? (
              <SearchReportsInput
                value={query}
                onCommit={(q) => setSearch({ q }, { replace: true })}
              />
            ) : undefined
          }
          onShowOnMap={() => setSearch({ view: 'map' })}
          homeLink={
            <Button size="xs" data-attr="latest-change-home" onClick={() => goTo('/settings/home')}>
              <ChangeHomeLabel />
            </Button>
          }
        />
      }
      feed={
        <FeedColumn
          state={state}
          sections={sections}
          now={now}
          header={header}
          canLoadMore={status === 'CanLoadMore'}
          loadingMore={status === 'LoadingMore'}
          onLoadMore={() => page.loadMore(PAGE_SIZE)}
          exhausted={status === 'Exhausted'}
          bodiesShown={
            bodyResults !== undefined && !bodyResults.exhausted ? bodyResults.results.length : null
          }
          recentCold={recentCold?.results}
          firstPostEnd={searching ? null : (posts[0]?.latestSkateEndTime ?? null)}
          reportHref={reportHref}
          onOpenReport={openReport}
          selectedReportId={search.report}
          onOpenLake={openLake}
          onClearFilters={() => setFilters({})}
          onWeatherOff={() => setFilters(withoutWeatherFilter(value))}
          onOpenMap={() => goTo('/')}
          onClearSearch={() => setSearch({ q: undefined }, { replace: true })}
          onClearSkater={() => setSearch({ skater: undefined }, { replace: true })}
        />
      }
      aside={
        <>
          <RecommendedStrip
            bundles={recommended}
            now={now}
            reportHref={reportHref}
            onOpenReport={openReport}
          />
          <WantedColumn places={wanted} now={now} onOpenBounty={openBounty} />
        </>
      }
      report={
        search.report !== undefined ? (
          <ReportPanel
            key={search.report}
            reportId={search.report}
            host={{ backTo: 'Latest', onClose: closeReport }}
          />
        ) : undefined
      }
    />
  );
}

/** Over the feed: what this list is (a search, one person's reports) and the way back out. */
function ResultLine({
  line,
  action,
  attr,
  onAction,
}: {
  line: string;
  action: string;
  attr: string;
  onAction: () => void;
}) {
  return (
    <div data-slot="latest-result-line" className="flex items-center gap-(--space-3)">
      <p className="ph-no-capture m-0 min-w-0 text-body text-fg1" aria-live="polite">
        {line}
      </p>
      <Button size="xs" className="ml-auto shrink-0" data-attr={attr} onClick={onAction}>
        {action}
      </Button>
    </div>
  );
}
