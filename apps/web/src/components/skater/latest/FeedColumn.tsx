import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMap } from '@fortawesome/sharp-light-svg-icons';
import {
  type BodyResultData,
  type FeedSection,
  formatSeason,
  type PostCardData,
  seasonOf,
  thresholdLabel,
} from '@skating/core';
import type { ReactNode } from 'react';

import { Button } from '../../kit/button';
import { ListEnd } from '../../kit/list-end';
import { Section } from '../../kit/section-slug';
import { Skeleton } from '../../kit/skeleton';
import { FeedCard } from '../cards/FeedCard';
import { type FeedState, type LatestRow, RECENT_COLD } from './latestModel';
import { WeatherMatchCard } from './WeatherMatchCard';

/**
 * Latest's center column (boards 4.1, 4.2, 4.9–4.13, 4.15, 4.18): the feed, its recency sections,
 * the matched lakes among the posts, Load more, and — when there's nothing to draw — the empty
 * state that says which of the old page's reasons it is, with the one or two ways out. Props only.
 */
export interface FeedColumnProps {
  state: FeedState;
  sections: readonly FeedSection<LatestRow>[];
  now: number;
  /** Over the feed: the search's result line, or whose reports these are. */
  header?: ReactNode;
  /** `usePaginatedQuery`'s paging. */
  canLoadMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** Every page is in. */
  exhausted: boolean;
  /** The matched lakes are a bounded list; when it was cut, how many it holds. */
  bodiesShown: number | null;
  /** 4.10: lakes with a recent run of cold nights, when nothing's been reported. */
  recentCold: readonly BodyResultData[] | undefined;
  /** The posts as served, for the past-season notice (D63). */
  firstPostEnd: number | null;
  reportHref: (reportId: string) => string;
  onOpenReport: (reportId: string) => void;
  selectedReportId?: string | undefined;
  onOpenLake: (waterBodyId: string, focusSubAreaId: string | null) => void;
  onClearFilters: () => void;
  onWeatherOff: () => void;
  onOpenMap: () => void;
  onClearSearch: () => void;
  onClearSkater: () => void;
}

export function FeedColumn(props: FeedColumnProps) {
  const { state, header } = props;
  return (
    <div data-slot="latest-feed" className="flex flex-col gap-(--space-8)">
      {header}
      {state === 'loading' ? (
        <FeedLoading />
      ) : state === 'feed' ? (
        <Feed {...props} />
      ) : (
        <FeedEmpty {...props} />
      )}
    </div>
  );
}

/** 4.15: the first page loading — a section's slug and three cards, the sizes of what comes. */
function FeedLoading() {
  return (
    <div data-slot="latest-loading" aria-busy="true" className="flex flex-col gap-(--space-3)">
      <span className="sr-only">Loading reports</span>
      <Skeleton className="h-[1.125rem] w-[5.625rem]" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}

function Feed({
  sections,
  now,
  canLoadMore,
  loadingMore,
  onLoadMore,
  exhausted,
  bodiesShown,
  firstPostEnd,
  reportHref,
  onOpenReport,
  selectedReportId,
  onOpenLake,
}: FeedColumnProps) {
  const lastSection = sections.length - 1;
  return (
    <>
      <PastSeasonNotice firstPostEnd={firstPostEnd} now={now} />
      {sections.map((section, s) => (
        <Section key={sectionKey(section)} title={section.label} className="gap-(--space-8)">
          {section.items.map((row: LatestRow, i) =>
            row.kind === 'report' ? (
              <FeedCard
                key={row.data.postId}
                post={row.data as PostCardData}
                now={now}
                reportHref={reportHref}
                onOpenReport={onOpenReport}
                selectedReportId={selectedReportId}
                last={s === lastSection && i === section.items.length - 1}
              />
            ) : (
              <WeatherMatchCard
                key={`body:${row.data.waterBodyId}`}
                data={row.data}
                now={now}
                onOpen={onOpenLake}
              />
            ),
          )}
        </Section>
      ))}
      <div className="flex flex-col items-center gap-(--space-3_5)">
        {bodiesShown !== null && (
          <p className="m-0 text-assist text-fg3">
            Showing the {bodiesShown} most recently matched lakes. Narrow the drive time to see
            others.
          </p>
        )}
        {loadingMore ? (
          <Skeleton className="h-28 w-full" />
        ) : canLoadMore ? (
          <Button className="min-w-[13.75rem]" data-attr="latest-load-more" onClick={onLoadMore}>
            Load more
          </Button>
        ) : null}
      </div>
      {exhausted && <ListEnd>That’s everything</ListEnd>}
    </>
  );
}

/** A section's key: its bucket and its first row, so a bucket seen twice still keys apart. */
function sectionKey(section: FeedSection<LatestRow>): string {
  const first = section.items[0];
  const id =
    first === undefined ? '' : first.kind === 'report' ? first.data.postId : first.data.waterBodyId;
  return `${section.key}:${id}`;
}

/**
 * D63's labeled fallback: before a season's first report, the server serves the last season that
 * had any, and the page says so instead of passing February off as today.
 */
function PastSeasonNotice({ firstPostEnd, now }: { firstPostEnd: number | null; now: number }) {
  if (firstPostEnd === null) return null;
  const season = seasonOf(firstPostEnd);
  if (season === seasonOf(now)) return null;
  return (
    <div
      data-slot="past-season"
      className="flex flex-col gap-(--space-2) bg-raise px-(--space-4) py-(--space-3_5)"
    >
      <b className="font-semibold text-fg">From the {formatSeason(season)} season</b>
      <p className="m-0 text-assist leading-body text-fg1 [text-wrap:pretty]">
        Nothing has been reported yet this season, so this is the last one anybody skated. Open a
        lake to see what it looked like, or post the first report of the winter.
      </p>
    </div>
  );
}

/** The empty states, each in the old page's words, on its board. */
function FeedEmpty({
  state,
  canLoadMore,
  loadingMore,
  onLoadMore,
  recentCold,
  now,
  onOpenLake,
  onClearFilters,
  onWeatherOff,
  onOpenMap,
  onClearSearch,
  onClearSkater,
}: FeedColumnProps) {
  const loadMore =
    canLoadMore || loadingMore ? (
      <Button data-attr="latest-load-more" loading={loadingMore} onClick={onLoadMore}>
        Load more
      </Button>
    ) : null;
  const clearAll = (
    <Button data-attr="latest-empty-clear" onClick={onClearFilters}>
      Clear all filters
    </Button>
  );
  const weatherOff = (
    <Button data-attr="latest-empty-weather-off" onClick={onWeatherOff}>
      Turn off the weather filter
    </Button>
  );

  switch (state) {
    case 'skater-unavailable':
      return (
        <EmptyPlate
          line="This skater’s reports aren’t available here. Their profile may be private, or the link may be old."
          actions={
            <Button data-attr="latest-skater-clear" onClick={onClearSkater}>
              Show everyone’s reports
            </Button>
          }
        />
      );
    case 'search-empty':
      return (
        <EmptyPlate
          line="No reports mention that. Try fewer words, or check the filters."
          actions={
            <Button data-attr="latest-search-clear-empty" onClick={onClearSearch}>
              Clear search
            </Button>
          }
        />
      );
    case 'no-weather-data':
      return (
        <EmptyPlate
          line="No weather data yet this season, so the weather filter cannot match any lake. It fills in once the region freezes."
          actions={weatherOff}
        />
      );
    case 'no-lake-match':
      return (
        <EmptyPlate
          line="No lake matches that weather yet, and no matching reports on this page."
          actions={
            <>
              {loadMore}
              {weatherOff}
            </>
          }
        />
      );
    case 'nothing-on-page':
      return (
        <EmptyPlate
          line="No matching reports on this page. Load more to keep looking further back."
          actions={
            <>
              {loadMore}
              {clearAll}
            </>
          }
        />
      );
    case 'nothing-matches':
      return <EmptyPlate line="No reports this season match these filters." actions={clearAll} />;
    default: {
      const cold = recentCold ?? [];
      const none = recentCold !== undefined && cold.length === 0;
      return (
        <>
          <EmptyPlate
            line={
              none
                ? 'No reports yet, and no lake has had a run of cold nights this season. Reports show up here, newest first, as skaters post them with New report in the top bar.'
                : 'No reports yet. They show up here, newest first, as skaters post them with New report in the top bar.'
            }
            actions={
              <Button data-attr="latest-open-map" onClick={onOpenMap}>
                <FontAwesomeIcon icon={faMap} aria-hidden="true" className="h-3" />
                Open the map
              </Button>
            }
          />
          {cold.length > 0 && (
            <Section
              title="Recent cold weather"
              end={
                <span className="font-(family-name:--family-mono) text-[0.75rem] text-fg2">
                  {RECENT_COLD.minNights} nights below {thresholdLabel(RECENT_COLD.thresholdF)}
                </span>
              }
            >
              {cold.map((lake) => (
                <WeatherMatchCard
                  key={lake.waterBodyId}
                  data={lake}
                  now={now}
                  onOpen={onOpenLake}
                />
              ))}
            </Section>
          )}
        </>
      );
    }
  }
}

/** An empty feed's plate: the page's kicker, the sentence, the ways out. Square — it's a plate. */
function EmptyPlate({ line, actions }: { line: string; actions: ReactNode }) {
  return (
    <div
      data-slot="latest-empty"
      className="flex flex-col gap-(--space-3_5) border border-solid border-line2 px-(--space-7) py-(--space-6)"
    >
      <span className="text-kick leading-none font-medium tracking-head text-fg3 uppercase">
        Latest
      </span>
      <p className="m-0 text-body leading-body text-fg [text-wrap:pretty]">{line}</p>
      <div className="flex flex-wrap gap-(--space-2)">{actions}</div>
    </div>
  );
}
