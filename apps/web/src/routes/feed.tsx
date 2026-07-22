import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { type FeedFilters, groupFeedSections } from '@skating/core';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import { useEffect, useRef, useState } from 'react';
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
import { readStoredFilters, reconcileFilters, writeStoredFilters } from '../lib/feedFilters';

/** How many feed cards to fetch per page (`usePaginatedQuery` load). */
const PAGE_SIZE = 20;

/**
 * Newsfeed — the chronological, cross-water-body co-primary page (D28; Phase 5). Reads
 * `reports.listFeed` (global, newest skate-end time first) via `usePaginatedQuery`, renders infinite
 * `FeedCard`s, and opens the report in a **drawer** (URL-backed `?report=<id>`) so the feed scroll
 * position survives — a deep-linkable overlay, not a full navigation. All reports are public (D13);
 * a blocked author's report still shows, de-emphasized (D3).
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

  const openReport = (id: string) =>
    navigate({ to: '/feed', search: { report: id }, resetScroll: false });
  const closeReport = () => navigate({ to: '/feed', search: {}, resetScroll: false });

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

      <FeedFilterBar filters={filters.value} onChange={filters.set} />

      {/* Recommended strip (D50) — breaks the viewer's filters, so it sits above the filtered feed
          and shows even when the main list is empty. Renders nothing when nothing qualifies. */}
      <RecommendedFeed recommended={recommended} now={now} onOpen={openReport} />

      {status === 'LoadingFirstPage' ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : results.length === 0 ? (
        <div className="flex flex-col gap-3">
          <Panel title="Newsfeed">
            <p>
              {loadMoreFooter !== null
                ? 'No matching reports on this page. Load more to keep looking further back.'
                : 'No reports yet. When skaters post from the map, the freshest reads across every lake show up here — newest first.'}
            </p>
          </Panel>
          {loadMoreFooter}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Recency scroll-divider headers (Phase 4, decision #5): "Today / Yesterday / …". */}
          {groupFeedSections(
            results.filter((d) => !recommendedIds.has(d.reportId)),
            (d) => d.skateEndTime,
            now,
          ).map((section) => (
            <div key={section.key} className="flex flex-col gap-3">
              <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
                {section.label}
              </h2>
              {section.items.map((data) => (
                <FeedCard
                  key={data.reportId}
                  data={data}
                  now={now}
                  onOpen={() => openReport(data.reportId)}
                />
              ))}
            </div>
          ))}
          {loadMoreFooter}
        </div>
      )}

      {/* Report drawer — reuses the map's `ReportDetail`. It pushes map focus/highlight through
          `MapSelectionContext`, so we mount a throwaway provider here (no map is rendered on the
          feed, so those updates are inert). Modal drawer: the feed doesn't need a tappable backdrop. */}
      <Sheet open={report !== undefined} onOpenChange={(open) => !open && closeReport()}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-md">
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
 * Feed-filter state (Phase 4, decision #6): local storage is the working copy (instant, offline-safe),
 * `profiles.feedFilterPrefs` is the durable server-sync copy. On mount we read local; once the profile
 * loads we reconcile (LWW — a non-empty local copy wins, else adopt the server copy) exactly once.
 * Every change writes local immediately and syncs the server copy. SSR-safe: `localStorage` is only
 * touched inside effects/handlers.
 */
function useFeedFilters(): { value: FeedFilters; set: (next: FeedFilters) => void } {
  const [value, setValue] = useState<FeedFilters>({});
  const profile = useQuery(api.profiles.current, {});
  const setServer = useMutation(api.profiles.setFeedFilterPrefs);
  const reconciled = useRef(false);

  // Load the local working copy on mount (client-only).
  useEffect(() => {
    setValue(readStoredFilters(window.localStorage));
  }, []);

  // Reconcile against the server copy once the profile arrives (LWW), a single time.
  useEffect(() => {
    if (reconciled.current || profile === undefined) return;
    reconciled.current = true;
    const local = readStoredFilters(window.localStorage);
    const merged = reconcileFilters(local, profile?.feedFilterPrefs);
    setValue(merged);
    writeStoredFilters(window.localStorage, merged);
  }, [profile]);

  const set = (next: FeedFilters) => {
    setValue(next);
    writeStoredFilters(window.localStorage, next);
    // Best-effort server sync; the local copy already drives this session.
    if (profile) void setServer({ filters: next });
  };

  return { value, set };
}
