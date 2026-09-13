import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  formatSeason,
  groupFeedSections,
  hasWeatherFilter,
  interleaveLatest,
  seasonOf,
} from '@skating/core';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { usePaginatedQuery, useQuery } from 'convex/react';
import { BodyResultCard } from '../components/BodyResultCard';
import { FeedCard } from '../components/FeedCard';
import { FeedFilterBar } from '../components/FeedFilterBar';
import { MapSelectionProvider } from '../components/MapSelectionContext';
import { Panel } from '../components/Panel';
import { ProfileSearch } from '../components/ProfileSearch';
import { RecommendedFeed } from '../components/RecommendedFeed';
import { ReportDetail } from '../components/ReportDetail';
import { Button } from '../components/ui/button';
import { Sheet, SheetContent } from '../components/ui/sheet';
import { Skeleton } from '../components/ui/skeleton';
import { useFeedFilters } from '../lib/feedFiltersStore';

/** How many feed cards to fetch per page (`usePaginatedQuery` load). */
const PAGE_SIZE = 20;

/**
 * Latest — the chronological, cross-water-body co-primary page (D28; Phase 5), renamed from
 * *Newsfeed* when it stopped being only reports (N6h / D159, D165). Reads `reports.listFeed`
 * (global, newest skate-end time first) via `usePaginatedQuery`, renders infinite `FeedCard`s, and
 * opens the report in a **drawer** (URL-backed `?report=<id>`) so the feed scroll position survives
 * — a deep-linkable overlay, not a full navigation. All reports are public (D13); a blocked author's
 * report still shows, de-emphasized (D3).
 *
 * Under a weather filter the feed is heterogeneous: `weatherDiscovery.listBodyResults` supplies the
 * **lakes** whose cold chain matched, and `interleaveLatest` slots them among the reports by the day
 * each lake crossed the requested number of nights. *Newsfeed* named a source; *Latest* names an
 * ordering, and an ordering can admit a new card type without the name becoming a lie.
 */
export const Route = createFileRoute('/feed')({
  component: FeedPage,
  validateSearch: (search: Record<string, unknown>): { report?: string } => ({
    report: typeof search.report === 'string' ? search.report : undefined,
  }),
});

function FeedPage() {
  const { report } = Route.useSearch();
  const navigate = useNavigate();
  const filters = useFeedFilters();
  const { results, status, loadMore } = usePaginatedQuery(
    api.reports.listFeed,
    { filters: filters.value },
    { initialNumItems: PAGE_SIZE },
  );
  // Recommended filter-breakers (D50) — the container owns the query so it can both render the strip and
  // subtract those reports from the main feed below (a permissive-filter viewer must not see one twice).
  const recommended = useQuery(api.reports.recommended, {});
  const recommendedIds = new Set(
    recommended?.flatMap((rec) => rec.cards.map((c) => c.reportId)) ?? [],
  );
  // One clock per render for the relative-time labels (feed re-renders reactively as reports stream).
  const now = Date.now();

  // The lakes the weather filter matched (D165) — only under a weather filter, and not when the
  // viewer asked for reports only. A bounded list, interleaved below by event time.
  const weatherActive = hasWeatherFilter(filters.value);
  const discovery = useQuery(api.weatherDiscovery.status, {});
  const bodyResults = useQuery(
    api.weatherDiscovery.listBodyResults,
    weatherActive && !filters.value.onlyReports ? { filters: filters.value } : 'skip',
  );

  const openReport = (id: string) =>
    navigate({ to: '/feed', search: { report: id }, resetScroll: false });
  const closeReport = () => navigate({ to: '/feed', search: {}, resetScroll: false });
  const openBody = (id: string, focusSubAreaId: string | null) =>
    navigate({
      to: '/water/$id',
      params: { id },
      search: focusSubAreaId ? { sub: focusSubAreaId } : {},
    });

  // Load-more affordance, shared by both the populated and empty-results arms. When a filter is
  // active, the first page(s) can be entirely filtered out while `status` is still `CanLoadMore`;
  // without a button in the empty arm the user would be stranded on "no items" (`usePaginatedQuery`
  // never advances on its own — it needs an explicit `loadMore()`).
  const loadMoreFooter =
    status === 'CanLoadMore' ? (
      <Button variant="outline" onClick={() => loadMore(PAGE_SIZE)} className="self-center">
        Load more
      </Button>
    ) : status === 'LoadingMore' ? (
      <Skeleton className="h-28 w-full" />
    ) : null;

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Find a skater">
        <ProfileSearch />
      </Panel>

      <FeedFilterBar filters={filters.value} onChange={filters.set} weather={discovery} />

      {/* Recommended strip (D50) — breaks the viewer's filters, so it sits above the filtered feed
          and shows even when the main list is empty. Renders nothing when nothing qualifies. */}
      <RecommendedFeed recommended={recommended} now={now} onOpen={openReport} />

      {status === 'LoadingFirstPage' ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : results.length === 0 && (bodyResults?.results.length ?? 0) === 0 ? (
        <div className="flex flex-col gap-3">
          <Panel title="Latest">
            <p>
              {weatherActive && discovery?.available === false
                ? 'No weather data yet this season, so the weather filter cannot match any lake. It fills in once the region freezes.'
                : weatherActive
                  ? 'No lake matches that weather yet, and no matching reports on this page.'
                  : loadMoreFooter !== null
                    ? 'No matching reports on this page. Load more to keep looking further back.'
                    : 'No reports yet. When skaters post from the map, the freshest reads across every lake show up here — newest first.'}
            </p>
          </Panel>
          {loadMoreFooter}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <PastSeasonNotice results={results} now={now} />
          {/* Recency scroll-divider headers (Phase 4, decision #5): "Today / Yesterday / …", over
              the interleaved list — a matched lake's event day buckets exactly like a skate-end. */}
          {groupFeedSections(
            interleaveLatest(
              results.filter((d) => !recommendedIds.has(d.reportId)),
              (d) => d.skateEndTime,
              bodyResults?.results ?? [],
              status === 'Exhausted',
            ),
            (item) => (item.kind === 'report' ? item.data.skateEndTime : item.data.eventMs),
            now,
          ).map((section) => (
            <div key={section.key} className="flex flex-col gap-3">
              <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
                {section.label}
              </h2>
              {section.items.map((item) =>
                item.kind === 'report' ? (
                  <FeedCard
                    key={item.data.reportId}
                    data={item.data}
                    now={now}
                    onOpen={() => openReport(item.data.reportId)}
                  />
                ) : (
                  <BodyResultCard
                    key={`body:${item.data.waterBodyId}`}
                    data={item.data}
                    now={now}
                    onOpen={(sub) => openBody(item.data.waterBodyId, sub)}
                  />
                ),
              )}
            </div>
          ))}
          {bodyResults && !bodyResults.exhausted ? (
            <p className="text-foreground-muted text-xs">
              Showing the {bodyResults.results.length} most recently matched lakes. Narrow the drive
              time to see others.
            </p>
          ) : null}
          {loadMoreFooter}
        </div>
      )}

      {/* Report drawer — reuses the map's `ReportDetail`. It pushes map focus/highlight through
          `MapSelectionContext`, so we mount a throwaway provider here (no map is rendered on the
          feed, so those updates are inert). Modal drawer: the feed doesn't need a tappable backdrop. */}
      <Sheet open={report !== undefined} onOpenChange={(open) => !open && closeReport()}>
        {/* `aria-label` because `ReportDetail`'s heading is a plain `h2` now, not a `Dialog.Title` —
            it has to render in the map sidebar, which is a region of the page rather than a dialog
            (see `DetailPanel`). This is the one place it's still inside a real dialog, so this is
            where the accessible name has to come from. */}
        <SheetContent
          side="right"
          aria-label="Report"
          className="w-full gap-0 overflow-y-auto sm:max-w-md"
        >
          {report !== undefined ? (
            <MapSelectionProvider>
              <ReportDetail reportId={report as Id<'reports'>} />
            </MapSelectionProvider>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/**
 * The labelled fallback (D63, kickoff decision 3).
 *
 * Season-scoping the feed empties it on July 1 and leaves it empty until first ice — five months, not
 * a July curiosity — so the server serves the newest season that has anything in it. What it must
 * never do is serve last winter *silently*: a report from February under today's date, with nothing
 * saying so, is exactly the "tell the difference from opacity alone" problem this phase exists to fix.
 *
 * Derived from the cards rather than read off the query, because `usePaginatedQuery` hands back the
 * flattened pages and drops everything else the page carried. Every card in a fallback feed is from
 * the same season (the server bounds one season per read), so the first one answers it.
 */
function PastSeasonNotice({
  results,
  now,
}: {
  results: readonly { skateEndTime: number }[];
  now: number;
}) {
  const first = results[0];
  if (!first) return null;
  const season = seasonOf(first.skateEndTime);
  if (season === seasonOf(now)) return null;
  return (
    <Panel title={`From the ${formatSeason(season)} season`}>
      <p>
        Nothing has been reported yet this season, so this is the last one anybody skated. Open a
        lake to see what it looked like, or post the first report of the winter.
      </p>
    </Panel>
  );
}
