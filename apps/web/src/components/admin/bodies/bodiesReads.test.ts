import { describe, expect, it } from 'vitest';

import {
  allTimeCount,
  askFrom,
  type BodyDoc,
  type BodyHistory,
  type LibraryRow,
  type ListSummary,
  laneCountsFrom,
  libraryLaneOf,
  listArgsOf,
  listFrom,
  listStatusOf,
  type PreviewFacts,
  polygonsOf,
  previewFrom,
  rowFromLibrary,
  seasonCount,
  servesFrom,
  vantageWords,
} from './bodiesReads';
import { queryOf } from './bodiesSearch';
import { BODY_LANES } from './bodyLanes';

const ACRE = 4046.8564224;
/** The list's clock: any instant will do, the reads only pass it on. */
const NOW = Date.UTC(2027, 0, 16, 17);

const libraryRow = (over: Partial<LibraryRow> = {}): LibraryRow =>
  ({
    id: 'm1',
    name: 'Mascoma Lake',
    bodyClass: 'reservoir',
    states: ['NH'],
    areaSqM: 1143 * ACRE,
    complete: { have: 9, of: 10, missing: ['bathymetry'] },
    asks: 3,
    asksCapped: false,
    asksWaiting: true,
    reports: 3,
    reportsCapped: false,
    changedAt: NOW - 60_000,
    standing: 'active',
    ...over,
  }) as LibraryRow;

const count = (n: number, capped = false) => ({ count: n, capped });

const summary = (over: Partial<ListSummary> = {}): ListSummary =>
  ({
    laneCounts: {
      all: count(24871),
      active: count(1412),
      inactive: count(22901),
      not_in_campaign: count(411),
      moderator: count(14),
      no_public_access: count(72),
      removed: count(61),
      changed: count(500, true),
    },
    corpus: count(24871),
    states: ['NH', 'VT'],
    total: count(1412),
    facetCounts: { size: { 'under-10': 412, '1000-up': 187 } },
    serves: {
      sort: ['name', 'class', 'state', 'acres', 'complete', 'asks', 'reports', 'changed'],
      facets: ['class', 'size', 'outline', 'putins', 'reports', 'complete', 'curation'],
      states: true,
      search: true,
    },
    ...over,
  }) as ListSummary;

describe('the list read’s arguments', () => {
  it('ask the server for the lane, the tab, the search, the facets and the order', () => {
    const args = listArgsOf(
      queryOf({
        lane: 'not-in-campaign',
        state: 'VT',
        q: '  mor ',
        size: '1000-up',
        sort: 'acres',
        dir: 'asc',
      }),
      NOW,
    );
    expect(args).toEqual({
      lane: 'not_in_campaign',
      state: 'VT',
      q: 'mor',
      facets: { size: ['1000-up'] },
      sort: { column: 'acres', dir: 'asc' },
      now: NOW,
    });
  });

  it('leave out what isn’t chosen, and the order while a search ranks the list', () => {
    expect(listArgsOf(queryOf({}), NOW)).toEqual({
      lane: 'active',
      sort: { column: 'reports', dir: 'desc' },
      now: NOW,
    });
    expect(listArgsOf(queryOf({ q: 'mor' }), NOW)).toEqual({ lane: 'active', q: 'mor', now: NOW });
  });

  it('leave a short search to the server, and keep the lane’s own order for it', () => {
    expect(listArgsOf(queryOf({ q: 'm' }), NOW)).toEqual({
      lane: 'active',
      q: 'm',
      sort: { column: 'reports', dir: 'desc' },
      now: NOW,
    });
    // A heading pressed during a short search is still that heading's order.
    expect(listArgsOf(queryOf({ q: 'm', sort: 'name' }), NOW)).toEqual({
      lane: 'active',
      q: 'm',
      sort: { column: 'name', dir: 'asc' },
      now: NOW,
    });
  });

  it('are none for a lane no server read lists', () => {
    expect(listArgsOf(queryOf({ lane: 'opened' }), NOW)).toBeNull();
    expect(libraryLaneOf(BODY_LANES[0] as (typeof BODY_LANES)[number])).toBeNull();
  });
});

describe('a library row', () => {
  it('is drawn as stored, completeness as core states it', () => {
    expect(rowFromLibrary(libraryRow())).toEqual({
      id: 'm1',
      name: 'Mascoma Lake',
      bodyClass: 'reservoir',
      states: ['NH'],
      areaSqM: 1143 * ACRE,
      complete: { have: 9, of: 10, missing: ['bathymetry'] },
      asks: 3,
      asksWaiting: true,
      reports: 3,
      changedAt: NOW - 60_000,
      standing: 'active',
    });
  });

  it('carries the alias a search matched, and says a count is a floor', () => {
    const r = rowFromLibrary(
      libraryRow({
        matchedAlias: 'Morgan Pond',
        asksCapped: true,
        reportsCapped: true,
        areaSqM: null,
        changedAt: null,
      }),
    );
    expect(r).toMatchObject({
      matchedAlias: 'Morgan Pond',
      asksCapped: true,
      reportsCapped: true,
      areaSqM: null,
      changedAt: null,
    });
  });
});

describe('the list from its pages', () => {
  it('follows the paginated hook: loading, more to come, fetching, done', () => {
    expect(listStatusOf('LoadingFirstPage')).toBe('loading');
    expect(listStatusOf('CanLoadMore')).toBe('more');
    expect(listStatusOf('LoadingMore')).toBe('fetching');
    expect(listStatusOf('Exhausted')).toBe('done');
  });

  it('takes its total and facet counts from this query’s summary only, never a stale one', () => {
    const rows = [libraryRow()];
    const now = listFrom({ rows, status: 'CanLoadMore', current: summary(), held: summary() });
    expect(now).toMatchObject({
      status: 'more',
      total: count(1412),
      facetCounts: { size: { 'under-10': 412, '1000-up': 187 } },
      states: ['NH', 'VT'],
      others: [],
    });
    expect(now.rows).toHaveLength(1);
    // The query moved on; its summary hasn't landed. The tabs and the controls hold; no count does.
    const moved = listFrom({ rows, status: 'CanLoadMore', current: undefined, held: summary() });
    expect(moved).toMatchObject({ total: null, facetCounts: null, states: ['NH', 'VT'] });
    expect(moved.serves.sort).toContain('acres');
  });

  it('draws no count the read can’t answer — a search, or two facets', () => {
    const searching = summary({ total: null, facetCounts: null, serves: { ...summary().serves } });
    const list = listFrom({ rows: [], status: 'Exhausted', current: searching, held: undefined });
    expect(list).toMatchObject({ status: 'done', total: null, facetCounts: null });
  });

  it('honors no order it can’t ask for until the summary says what the read can', () => {
    expect(servesFrom(undefined)).toEqual({
      sort: [],
      facets: ['class', 'size', 'outline', 'putins', 'reports', 'complete', 'curation'],
      states: true,
      search: true,
    });
    expect(servesFrom(summary({ serves: { ...summary().serves, sort: [] } })).sort).toEqual([]);
  });
});

describe('the lanes’ counts', () => {
  it('map the server’s lanes to the page’s, the capped Changed count kept capped', () => {
    expect(laneCountsFrom(summary(), BODY_LANES)).toEqual({
      opened: null,
      changed: count(500, true),
      all: count(24871),
      active: count(1412),
      inactive: count(22901),
      'not-in-campaign': count(411),
      moderator: count(14),
      'no-public-access': count(72),
      removed: count(61),
    });
  });

  it('are none before the summary lands', () => {
    expect(Object.values(laneCountsFrom(undefined, BODY_LANES)).every((c) => c === null)).toBe(
      true,
    );
  });
});

// ── The preview ──────────────────────────────────────────────────────────────────────────────

const facts = (over: Partial<PreviewFacts> = {}): PreviewFacts =>
  ({
    season: {
      count: 3,
      capped: false,
      recordOpen: true,
      byVantage: { on_ice: 2, shore: 1, secondhand: 0, unstated: 0 },
    },
    allTime: { count: 86, capped: false, firstSeason: 2023 },
    asks: [],
    town: 'Enfield',
    moreTowns: ['Canaan'],
    complete: { have: 9, of: 10, missing: ['bathymetry'] },
    ...over,
  }) as PreviewFacts;

describe('the season’s reports', () => {
  it('say how they were made, the kinds with any, in a fixed order', () => {
    expect(vantageWords({ on_ice: 2, shore: 1, secondhand: 0, unstated: 0 })).toBe(
      '2 on the ice · 1 from shore',
    );
    expect(vantageWords({ on_ice: 0, shore: 0, secondhand: 1, unstated: 1200 })).toBe(
      '1 secondhand · 1,200 not stated',
    );
    expect(vantageWords({ on_ice: 0, shore: 0, secondhand: 0, unstated: 0 })).toBeNull();
  });

  it('are a floor when the read stopped inside the season', () => {
    const { season } = facts();
    expect(seasonCount({ ...season, count: 1000, capped: true }, NOW)).toMatchObject({
      count: 1000,
      capped: true,
    });
  });

  it('are honestly empty before the record opens, and say when it begins', () => {
    const closed = {
      count: 0,
      capped: false,
      recordOpen: false,
      byVantage: facts().season.byVantage,
    };
    expect(seasonCount(closed, Date.UTC(2026, 7, 14, 17))).toEqual({
      count: 0,
      capped: false,
      sub: 'Record begins 1 Oct',
    });
  });

  it('say since when, unless the all-time read stopped short of the first', () => {
    expect(allTimeCount({ count: 86, capped: false, firstSeason: 2023 })).toEqual({
      count: 86,
      capped: false,
      sub: 'Since 2023–24',
    });
    expect(allTimeCount({ count: 1000, capped: true, firstSeason: null })).toEqual({
      count: 1000,
      capped: true,
      sub: null,
    });
  });
});

describe('an ask', () => {
  it('words a request by its kind, its name and its note', () => {
    expect(
      askFrom({
        id: 'r1',
        kind: 'request',
        requestKind: 'name_bay',
        name: 'Shaker cove',
        note: 'Near the Shaker Bridge launch',
        createdAt: 1,
      }),
    ).toEqual({
      id: 'r1',
      kicker: 'Bay name · Inbox',
      title: '“Shaker cove”',
      sub: 'Near the Shaker Bridge launch',
    });
    expect(
      askFrom({
        id: 'r2',
        kind: 'request',
        requestKind: 'activate',
        name: null,
        note: null,
        createdAt: 1,
      }),
    ).toEqual({ id: 'r2', kicker: 'Activation · Inbox', title: 'Make it active', sub: null });
  });

  it('words a place name by its emails, and a flag by its reason', () => {
    expect(
      askFrom({ id: 'p1', kind: 'placeName', name: 'the Narrows', messages: 12, createdAt: 1 }),
    ).toEqual({ id: 'p1', kicker: 'Place name · 12 emails', title: '“the Narrows”', sub: null });
    expect(
      askFrom({ id: 'p2', kind: 'placeName', name: 'the Gut', messages: 1, createdAt: 1 }).kicker,
    ).toBe('Place name · 1 email');
    expect(askFrom({ id: 'f1', kind: 'flag', reason: 'no_public_access', createdAt: 1 })).toEqual({
      id: 'f1',
      kicker: 'Flag · Inbox',
      title: 'No public access',
      sub: null,
    });
  });
});

describe('the preview from its reads', () => {
  const body = {
    _id: 'm1',
    name: 'Mascoma Lake',
    type: 'reservoir',
    states: ['NH'],
    centroid: { lat: 43.63, lng: -72.15 },
    bbox: { minLng: -72.18, minLat: 43.6, maxLng: -72.12, maxLat: 43.65 },
    polygon: {
      type: 'Polygon',
      coordinates: [
        [
          [-72.18, 43.6],
          [-72.12, 43.6],
          [-72.12, 43.65],
          [-72.18, 43.6],
        ],
      ],
    },
    surfaceAreaSqM: 1143 * ACRE,
    maxDepthM: 24,
    dedupStatus: 'clean',
  } as unknown as BodyDoc;

  const history = {
    entries: [
      {
        id: 'r1',
        createdAt: 5,
        actor: { userId: 'u1', displayName: 'Sarah Berman', username: 'sarah' },
        action: 'hide',
        targetType: 'report',
      },
      { id: 'r2', createdAt: 4, actor: null, action: 'activate_body', targetType: 'waterbody' },
    ],
    capped: false,
  } as unknown as BodyHistory;

  it('draws each read, the facts worded and completeness as stored', () => {
    const p = previewFrom({
      body,
      putIns: [{ coord: { lat: 43.63, lng: -72.15 }, source: 'osm' }] as never,
      subAreas: [{}, {}] as never,
      history,
      facts: facts({
        asks: [{ id: 'f1', kind: 'flag', reason: 'spam', createdAt: 1 }],
      }),
      now: NOW,
    });
    expect(p).toMatchObject({
      id: 'm1',
      bays: 2,
      putIns: [{ lat: 43.63, lng: -72.15 }],
      meanDepthM: null,
      maxDepthM: 24,
      elevationM: null,
      town: 'Enfield',
      moreTowns: ['Canaan'],
      facts: 'ready',
      season: { count: 3, capped: false, sub: '2 on the ice · 1 from shore' },
      allTime: { count: 86, capped: false, sub: 'Since 2023–24' },
      complete: { have: 9, of: 10, missing: ['bathymetry'] },
      asks: [{ kicker: 'Flag · Inbox', title: 'Spam' }],
    });
    expect(p.outline?.bbox).toEqual([-72.18, 43.6, -72.12, 43.65]);
    expect(p.history).toEqual([
      { id: 'r1', at: 5, actor: 'Sarah', words: 'Hid a report' },
      { id: 'r2', at: 4, actor: null, words: expect.any(String) },
    ]);
  });

  it('holds the facts’ blocks while they load, and says when they failed — never zeros', () => {
    const loading = previewFrom({
      body,
      putIns: undefined,
      subAreas: undefined,
      history: undefined,
      facts: undefined,
      now: NOW,
    });
    expect(loading).toMatchObject({
      facts: 'loading',
      putIns: null,
      bays: null,
      history: null,
      season: null,
      allTime: null,
      complete: null,
      asks: null,
      town: null,
      moreTowns: [],
    });
    const failed = previewFrom({
      body,
      putIns: undefined,
      subAreas: undefined,
      history: new Error('nope'),
      facts: new Error('nope'),
      now: NOW,
    });
    expect(failed).toMatchObject({ facts: 'error', season: null, history: 'error' });
  });

  it('leaves completeness unrecorded for a body with no library row yet, and history out unread', () => {
    const p = previewFrom({
      body,
      putIns: [],
      subAreas: [],
      history: null,
      facts: facts({ complete: null, town: null, moreTowns: [] }),
      now: NOW,
    });
    expect(p).toMatchObject({ complete: null, history: null, town: null, putIns: [], bays: 0 });
  });

  it('reads polygons and multipolygons, nothing else', () => {
    expect(polygonsOf(body.polygon)).toHaveLength(1);
    expect(
      polygonsOf({ type: 'MultiPolygon', coordinates: [[[[0, 0]]], [[[1, 1]]]] } as never),
    ).toEqual([[[[0, 0]]], [[[1, 1]]]]);
    expect(polygonsOf({ type: 'Point', coordinates: [0, 0] } as never)).toEqual([]);
  });
});
