import { isBrowsableSeason } from '@skating/core';

/**
 * The Overview's search: which tab is open and which season is shown, in the URL so a reload, a
 * link and the back button all keep them. Home and the current season are the defaults and are
 * written as no param at all, so `/admin` is Home, now. A past season is shown only when one is
 * chosen (`?season=2025`, D249); a chooser in the page is wiring onto this.
 *
 * Validated, never trusted: an unknown or misspelled tab reads as Home rather than an empty page.
 * The tabs are a list, so a third (Seasons, if it folds in) is one entry here and one in the page.
 */

export const OVERVIEW_TABS = ['home', 'metrics'] as const;
export type OverviewTabValue = (typeof OVERVIEW_TABS)[number];

/** What the route keeps: a tab other than Home, and a chosen season (the year it began). */
export type OverviewSearch = { tab?: Exclude<OverviewTabValue, 'home'>; season?: number };

function isOverviewTab(value: unknown): value is OverviewTabValue {
  return typeof value === 'string' && (OVERVIEW_TABS as readonly string[]).includes(value);
}

/**
 * The route's `validateSearch`: keeps a known tab other than Home and a season anyone could name,
 * drops everything else — a nonsense season reads as the current one, never an empty page.
 */
export function validateOverviewSearch(raw: Record<string, unknown>): OverviewSearch {
  const tab = raw.tab;
  const season = typeof raw.season === 'string' ? Number(raw.season) : raw.season;
  return {
    ...(isOverviewTab(tab) && tab !== 'home' ? { tab } : {}),
    ...(typeof season === 'number' && isBrowsableSeason(season) ? { season } : {}),
  };
}

/** The open tab. */
export function overviewTabOf(search: OverviewSearch): OverviewTabValue {
  return search.tab ?? 'home';
}

/** The search that opens `tab` — Home as no param — keeping a chosen season. */
export function searchForTab(tab: OverviewTabValue, season?: number): OverviewSearch {
  return { ...(tab === 'home' ? {} : { tab }), ...(season !== undefined ? { season } : {}) };
}

/** The season shown: the one chosen, else the one `now` falls in (it flips on 1 July). */
export function seasonOfSearch(search: OverviewSearch, current: number): number {
  return search.season ?? current;
}
