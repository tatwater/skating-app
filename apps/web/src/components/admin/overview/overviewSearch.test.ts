import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  OVERVIEW_TABS,
  overviewTabOf,
  searchForTab,
  seasonOfSearch,
  validateOverviewSearch,
} from './overviewSearch';

describe('the Overview’s tab in the URL', () => {
  it('opens Home with no param, and Metrics with ?tab=metrics', () => {
    expect(overviewTabOf(validateOverviewSearch({}))).toBe('home');
    expect(overviewTabOf(validateOverviewSearch({ tab: 'metrics' }))).toBe('metrics');
  });

  it('writes Home as no param at all, so /admin is Home', () => {
    expect(validateOverviewSearch({ tab: 'home' })).toEqual({});
    expect(searchForTab('home')).toEqual({});
    expect(searchForTab('metrics')).toEqual({ tab: 'metrics' });
  });

  it('reads anything it doesn’t know as Home, and keeps no other param', () => {
    for (const tab of ['Metrics', 'seasons', '', 1, null, ['metrics'], { tab: 'metrics' }]) {
      expect(validateOverviewSearch({ tab })).toEqual({});
    }
    expect(validateOverviewSearch({ tab: 'metrics', post: 'abc' })).toEqual({ tab: 'metrics' });
  });

  it('round-trips every tab, and lands on a known tab whatever it is handed', () => {
    for (const tab of OVERVIEW_TABS) {
      expect(overviewTabOf(validateOverviewSearch(searchForTab(tab)))).toBe(tab);
    }
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.anything()), (raw) => {
        expect(OVERVIEW_TABS).toContain(overviewTabOf(validateOverviewSearch(raw)));
      }),
    );
  });
});

describe('the chosen season', () => {
  it('keeps a season anyone could name, and drops nonsense to the current one', () => {
    expect(validateOverviewSearch({ season: '2025' })).toEqual({ season: 2025 });
    expect(validateOverviewSearch({ season: 2025, tab: 'metrics' })).toEqual({
      tab: 'metrics',
      season: 2025,
    });
    expect(validateOverviewSearch({ season: '20.5' })).toEqual({});
    expect(validateOverviewSearch({ season: 'last' })).toEqual({});
    expect(seasonOfSearch({}, 2026)).toBe(2026);
    expect(seasonOfSearch({ season: 2025 }, 2026)).toBe(2025);
  });

  it('keeps the chosen season across a change of tab', () => {
    expect(searchForTab('metrics', 2025)).toEqual({ tab: 'metrics', season: 2025 });
    expect(searchForTab('home', 2025)).toEqual({ season: 2025 });
    expect(searchForTab('home')).toEqual({});
  });
});
