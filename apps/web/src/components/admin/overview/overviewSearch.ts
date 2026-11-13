/**
 * The Overview's search: which tab is open, in the URL so a reload, a link and the back button all
 * keep it. Home is the default and is written as no param at all, so `/admin` is Home.
 *
 * Validated, never trusted: an unknown or misspelled tab reads as Home rather than an empty page.
 * The tabs are a list, so a third (Seasons, if it folds in) is one entry here and one in the page.
 */

export const OVERVIEW_TABS = ['home', 'metrics'] as const;
export type OverviewTabValue = (typeof OVERVIEW_TABS)[number];

/** What the route keeps: a tab other than Home, or nothing. */
export type OverviewSearch = { tab?: Exclude<OverviewTabValue, 'home'> };

function isOverviewTab(value: unknown): value is OverviewTabValue {
  return typeof value === 'string' && (OVERVIEW_TABS as readonly string[]).includes(value);
}

/** The route's `validateSearch`: keeps a known tab other than Home, drops everything else. */
export function validateOverviewSearch(raw: Record<string, unknown>): OverviewSearch {
  const tab = raw.tab;
  return isOverviewTab(tab) && tab !== 'home' ? { tab } : {};
}

/** The open tab. */
export function overviewTabOf(search: OverviewSearch): OverviewTabValue {
  return search.tab ?? 'home';
}

/** The search that opens `tab` — Home as no param. */
export function searchForTab(tab: OverviewTabValue): OverviewSearch {
  return tab === 'home' ? {} : { tab };
}
