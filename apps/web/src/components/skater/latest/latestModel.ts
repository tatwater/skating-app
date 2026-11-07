import {
  asOfLabel,
  type BodyResultData,
  type FeedFilters,
  type FeedSection,
  groupFeedSections,
  hasWeatherFilter,
  interleaveLatest,
  type LatestItem,
  type PostCardData,
  thresholdLabel,
  type WeatherDiscoveryFilter,
  withoutRecommended,
} from '@skating/core';

import type { LatestFilter } from '@/lib/analytics';
import { activeFilterCount } from '@/lib/feedFilters';

/**
 * Latest's pure model (B03 §1.2, boards 4.1–4.18): what the page draws from what Convex and the
 * saved filters say. No React, no Convex — the page and its stories feed it plain values.
 */

// ── The feed ────────────────────────────────────────────────────────────────────────────────────

/** One row of the feed column: a post, or a lake the weather filter matched (D165). */
export type LatestRow = LatestItem<PostCardData>;

/**
 * The feed column's sections — the old page's composition, unchanged: recommended reports come out
 * of the filtered feed (a permissive viewer never sees one twice, D50), matched lakes slot in among
 * the posts by the day each crossed the asked-for nights (`interleaveLatest`), and the list breaks
 * into recency sections. Core owns and tests each step; this only names the order they run in.
 */
export function latestSections(
  posts: readonly PostCardData[],
  recommendedIds: ReadonlySet<string>,
  bodies: readonly BodyResultData[],
  exhausted: boolean,
  now: number,
): FeedSection<LatestRow>[] {
  return groupFeedSections(
    interleaveLatest(
      withoutRecommended(posts, recommendedIds),
      (post) => post.latestSkateEndTime,
      bodies,
      exhausted,
    ),
    (row) => (row.kind === 'report' ? row.data.latestSkateEndTime : row.data.eventMs),
    now,
  );
}

/** `usePaginatedQuery`'s status, as the feed reads it. */
export type PageStatus = 'LoadingFirstPage' | 'CanLoadMore' | 'LoadingMore' | 'Exhausted';

/**
 * What the feed column draws. The empty states are the old page's ladder, each on its board, plus
 * the rungs search and the skater filter add:
 *
 * - `skater-unavailable` — the skater filter named someone whose reports can't be shown (private,
 *   gone, blocked, or a bad link): the server's `skaterUnavailable`, never guessed at.
 * - `search-empty` — a search found nothing (4.9's own empty).
 * - `no-weather-data` (4.13) — a weather filter, but no digest this season: it can't match anything.
 * - `no-lake-match` (4.12) — a weather filter matched no lake and this page had no report.
 * - `nothing-on-page` (4.11) — the filters emptied this page, but there are older pages to look in.
 * - `nothing-matches` — the filters emptied every page this season (the old page said "No reports
 *   yet" here, which was untrue under a filter).
 * - `no-reports` (4.10 / 4.18) — nothing posted this season at all.
 */
export type FeedState =
  | 'loading'
  | 'feed'
  | 'skater-unavailable'
  | 'search-empty'
  | 'no-weather-data'
  | 'no-lake-match'
  | 'nothing-on-page'
  | 'nothing-matches'
  | 'no-reports';

export interface FeedStateInput {
  status: PageStatus;
  /** Rows the column would draw: posts after the recommended dedupe, plus matched lakes. */
  rowCount: number;
  filters: FeedFilters;
  /** `weatherDiscovery.status().available`; `undefined` while it loads. */
  weatherAvailable: boolean | undefined;
  searching: boolean;
  skaterUnavailable: boolean;
}

export function latestFeedState(input: FeedStateInput): FeedState {
  if (input.skaterUnavailable) return 'skater-unavailable';
  if (input.status === 'LoadingFirstPage') return 'loading';
  if (input.rowCount > 0) return 'feed';
  if (input.searching) return 'search-empty';
  if (hasWeatherFilter(input.filters)) {
    return input.weatherAvailable === false ? 'no-weather-data' : 'no-lake-match';
  }
  if (input.status !== 'Exhausted') return 'nothing-on-page';
  return activeFilterCount(input.filters) > 0 ? 'nothing-matches' : 'no-reports';
}

/**
 * 4.10: with nothing reported this season, the lakes that have had a run of cold nights fill the
 * feed under the weather filter's own default knobs — so the page shows the weather, labeled as a
 * weather match, never as a word about the ice. No lake matches ⇒ 4.18, the true empty.
 */
export const RECENT_COLD: WeatherDiscoveryFilter = { thresholdF: 20, minNights: 3 };

// ── The filters ─────────────────────────────────────────────────────────────────────────────────

/**
 * Which `latest_filter_changed` value each saved filter key reports (D240: which control, never
 * the value). `noSnow` has no taxonomy value yet — counting it as something else would mislabel
 * it, so it isn't counted (a seam request for `snow_cover`).
 */
const FILTER_EVENT: Readonly<Record<keyof FeedFilters, LatestFilter | null>> = {
  radiusMinutes: 'drive_time',
  recencyHours: 'posted',
  qualityFloor: 'quality',
  iceTypes: 'ice_type',
  surfaceTags: 'ice_type',
  thicknessFloorCm: 'thickness',
  weather: 'weather_match',
  onlyReports: 'weather_match',
  noSnow: null,
};

/** The controls a change touched, once each, in the taxonomy's order. */
export function changedFilters(prev: FeedFilters, next: FeedFilters): LatestFilter[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<keyof FeedFilters>;
  const hit = new Set<LatestFilter>();
  for (const key of keys) {
    const event = FILTER_EVENT[key];
    if (event === null || event === undefined) continue;
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) hit.add(event);
  }
  const order: readonly LatestFilter[] = [
    'drive_time',
    'posted',
    'quality',
    'ice_type',
    'thickness',
    'weather_match',
  ];
  return order.filter((event) => hit.has(event));
}

/** Set one key, or drop it when `value` is undefined — the row only ever holds what's on. */
export function patchFilters<K extends keyof FeedFilters>(
  filters: FeedFilters,
  key: K,
  value: FeedFilters[K] | undefined,
): FeedFilters {
  const next = { ...filters };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

// ── On the map (4.4) ────────────────────────────────────────────────────────────────────────────

/**
 * The map banner's sentence: what the dimming is showing — the weather knobs, the drive time, the
 * reading's date. Only the map's own view of the row (D166: weather and drive time; quality and ice
 * describe reports, not places). Weather words only: a match is never a word about the ice (D3).
 */
export function mapBannerLine(filters: FeedFilters, asOfDayMs: number | null): string {
  const weather = filters.weather;
  const within = filters.radiusMinutes !== undefined ? `within ${filters.radiusMinutes} min` : null;
  if (weather === undefined) {
    return within === null ? 'Every lake — no weather filter is on' : `Showing lakes ${within}`;
  }
  const nights = `${weather.minNights}+ ${weather.minNights === 1 ? 'night' : 'nights'}`;
  const parts = [
    `${nights} below ${thresholdLabel(weather.thresholdF)}${weather.noSnowSince ? ', no snow since' : ''}`,
    within,
    asOfDayMs !== null ? asOfLabel(asOfDayMs) : null,
  ].filter((part): part is string => part !== null);
  return `Showing lakes with ${parts.join(' · ')}`;
}

// ── Search ──────────────────────────────────────────────────────────────────────────────────────

/** `posts.searchFeed`'s cap — past it the server says `truncated`. */
export const SEARCH_MATCH_CAP = 100;

/**
 * 4.9's result line. `matched` counts posts *before* the viewer's filters (the server's caveat), so
 * it is a count only when no filter is on; past the cap the line says it is showing the closest
 * ones, never that it is everything (D5).
 */
export function searchSummary({
  query,
  matched,
  truncated,
  filtersOn,
}: {
  query: string;
  matched: number | undefined;
  truncated: boolean;
  filtersOn: boolean;
}): string {
  const term = `“${query}”`;
  if (truncated) {
    return `Showing the closest ${SEARCH_MATCH_CAP} reports that mention ${term} — narrow the search`;
  }
  if (filtersOn || matched === undefined) {
    return `Reports that mention ${term} under your filters, newest first`;
  }
  return `${matched} ${matched === 1 ? 'report mentions' : 'reports mention'} ${term}, newest first`;
}

// ── Wanted near you ─────────────────────────────────────────────────────────────────────────────

/** A `bounties.listOpen` row, as much of it as the column reads. */
export interface OpenBountyRow {
  _id: string;
  waterBodyId: string;
  waterBodyName: string;
  subAreaName?: string;
  requester: { displayName: string; username?: string; profileImageUrl?: string } | null;
  fulfillingCount: number;
  createdAt: number;
  expiresAt: number;
}

/** One place skaters want a look at: every open bounty on that lake (or bay) together. */
export interface WantedPlace {
  key: string;
  /** The first-asked bounty — what the row opens. */
  bountyId: string;
  /** The bay when the asks name one, else the lake. */
  place: string;
  /** The lake, under a bay's name; `null` when the place is the lake. */
  lake: string | null;
  /** "3 open bounties": each person's ask is its own bounty. */
  count: number;
  firstAsker: OpenBountyRow['requester'];
  /** When the last of them lapses: the place stays wanted until then. */
  expiresAt: number;
  /** Reports already answering any of them. */
  answered: number;
}

/**
 * Open bounties gathered by place, in the order the server sent them (nearest the viewer's home
 * first, when they have one). A place's row opens its first-asked bounty and names that asker.
 */
export function groupWanted(rows: readonly OpenBountyRow[], limit: number): WantedPlace[] {
  const groups = new Map<string, WantedPlace & { firstAt: number }>();
  for (const row of rows) {
    const key = `${row.waterBodyId}|${row.subAreaName ?? ''}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        key,
        bountyId: row._id,
        place: row.subAreaName ?? row.waterBodyName,
        lake: row.subAreaName !== undefined ? row.waterBodyName : null,
        count: 1,
        firstAsker: row.requester,
        expiresAt: row.expiresAt,
        answered: row.fulfillingCount,
        firstAt: row.createdAt,
      });
      continue;
    }
    group.count += 1;
    group.answered += row.fulfillingCount;
    group.expiresAt = Math.max(group.expiresAt, row.expiresAt);
    if (row.createdAt < group.firstAt) {
      group.firstAt = row.createdAt;
      group.bountyId = row._id;
      group.firstAsker = row.requester;
    }
  }
  return [...groups.values()].slice(0, Math.max(0, limit)).map(({ firstAt: _f, ...g }) => g);
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** "Expires in 5 days" — how long the ask stays open, said plainly. */
export function expiresLabel(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left < HOUR) return 'Expires within the hour';
  if (left < DAY) {
    const hours = Math.floor(left / HOUR);
    return `Expires in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  const days = Math.floor(left / DAY);
  return `Expires in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** "No reports yet" · "1 report so far" — reports already answering the place's asks. */
export function answeredLabel(answered: number): string {
  if (answered === 0) return 'No reports yet';
  return `${answered} ${answered === 1 ? 'report' : 'reports'} so far`;
}
