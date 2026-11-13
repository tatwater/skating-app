import { describe, expect, it } from 'vitest';

import { answerHeld, groupOthers } from './bodiesData';
import { HELD } from './bodiesFixtures';
import type { BodyRow } from './bodiesModel';
import {
  type BodyDoc,
  heldFromLane,
  type LaneRows,
  laneCountFrom,
  listFromLane,
  listFromSearch,
  polygonsOf,
  previewFrom,
  rowFromHit,
  SEARCH_LIMIT,
  type SearchHits,
  standingKey,
} from './bodiesReads';
import { queryOf } from './bodiesSearch';
import { laneById } from './bodyLanes';

const ACRE = 4046.8564224;

const laneRow = (over: Partial<LaneRows['rows'][number]> = {}): LaneRows['rows'][number] =>
  ({
    _id: 'b1',
    name: 'Echo Lake',
    type: 'lakePond',
    states: ['VT'],
    surfaceAreaSqM: 550 * ACRE,
    centroid: { lat: 44, lng: -72 },
    standing: { standing: 'dormant', since: 1, reason: 'moderator' },
    lastActivityAt: null,
    includedByRequest: false,
    curatedBoost: 0,
    ...over,
  }) as LaneRows['rows'][number];

const hit = (over: Partial<SearchHits[number]> = {}): SearchHits[number] =>
  ({
    kind: 'body',
    _id: 'h1',
    waterBodyId: 'h1',
    name: 'Lake Morey',
    type: 'lakePond',
    centroid: { lat: 43.92, lng: -72.15 },
    bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
    states: ['VT'],
    surfaceAreaSqM: 545 * ACRE,
    ...over,
  }) as SearchHits[number];

describe('standing', () => {
  it('maps every standing to a library key', () => {
    expect(standingKey({ standing: 'active' })).toBe('active');
    expect(standingKey({ standing: 'unlisted' })).toBe('rejected');
    expect(standingKey({ standing: 'removed', since: 1, reason: 'junk' })).toBe('removed');
    expect(standingKey({ standing: 'dormant', since: 1, reason: 'no_public_access' })).toBe(
      'no_public_access',
    );
  });
});

describe('a lane read held whole', () => {
  it('carries what the read has and leaves the rest unrecorded', () => {
    const held = heldFromLane(laneRow({ curatedBoost: 0.2, surfaceAreaSqM: 0 }));
    expect(held.row).toMatchObject({
      id: 'b1',
      bodyClass: 'lakePond',
      areaSqM: null,
      complete: null,
      asks: null,
      reports: null,
      changedAt: null,
      standing: 'moderator',
    });
    expect(held.facts).toEqual({
      outline: null,
      putIns: null,
      curated: true,
      intake: null,
      awaitingEnrichment: null,
    });
  });
  it('is answered exactly here when the read came back whole', () => {
    const rows = [
      laneRow({
        _id: 'a' as never,
        name: 'Morrison Lake',
        states: ['VT'],
        surfaceAreaSqM: 12 * ACRE,
      }),
      laneRow({
        _id: 'b' as never,
        name: 'Echo Lake',
        states: ['NH'],
        surfaceAreaSqM: 1500 * ACRE,
      }),
      laneRow({ _id: 'c' as never, name: 'Morey Pond', states: ['NH'], surfaceAreaSqM: 41 * ACRE }),
    ];
    const list = listFromLane(
      { rows, truncated: false },
      queryOf({ lane: 'moderator', q: 'mor', state: 'NH' }),
    );
    expect(list.status).toBe('done');
    expect(list.rows.map((r) => r.id)).toEqual(['c']);
    expect(list.total).toEqual({ count: 1, capped: false });
    // The tabs follow the search, before the state narrows: most bodies first.
    expect(list.states).toEqual(['NH', 'VT']);
  });
  it('keeps the read’s order for a column its rows don’t carry, and ignores a facet they can’t answer', () => {
    const rows = [
      laneRow({ _id: 'z' as never, name: 'Zed' }),
      laneRow({ _id: 'a' as never, name: 'Abe' }),
    ];
    const byChange = listFromLane({ rows, truncated: false }, queryOf({ lane: 'moderator' }));
    expect(byChange.rows.map((r) => r.id)).toEqual(['z', 'a']);
    const byName = listFromLane(
      { rows, truncated: false },
      queryOf({ lane: 'moderator', sort: 'name', outline: 'drawn' }),
    );
    expect(byName.rows.map((r) => r.id)).toEqual(['a', 'z']);
  });
  it('answers nothing locally when the read stopped at its cap', () => {
    const list = listFromLane(
      { rows: [laneRow({ _id: 'z' as never }), laneRow({ _id: 'a' as never })], truncated: true },
      queryOf({ lane: 'inactive', sort: 'name' }),
    );
    expect(list.status).toBe('capped');
    expect(list.rows.map((r) => r.id)).toEqual(['z', 'a']);
    expect(list.serves).toEqual({ sort: [], facets: [], states: false, search: false });
    expect(list.total).toEqual({ count: 2, capped: true });
  });
  it('is loading until the read lands, and counts the lane from it', () => {
    expect(listFromLane(undefined, queryOf({ lane: 'moderator' })).status).toBe('loading');
    expect(laneCountFrom(undefined)).toBeNull();
    expect(laneCountFrom({ rows: [laneRow()], truncated: true })).toEqual({
      count: 1,
      capped: true,
    });
  });
});

describe('a search where no lane read serves', () => {
  const active = laneById('active');
  it('is unread under two letters, loading until the hits land', () => {
    expect(listFromSearch(undefined, active, 'm')).toMatchObject({
      status: 'unread',
      serves: { search: true },
    });
    expect(listFromSearch(undefined, active, 'mor').status).toBe('loading');
  });
  it('lists the active matches, the dormant under their divider', () => {
    const list = listFromSearch(
      [
        hit({ waterBodyId: 'a' as never, name: 'Lake Morey' }),
        hit({ waterBodyId: 'b' as never, name: 'Morey Pond', inactive: true }),
        hit({ kind: 'subArea', waterBodyId: 'c' as never, name: 'Morey Bay' }),
      ],
      active,
      'mor',
    );
    expect(list.rows.map((r) => r.id)).toEqual(['a']);
    expect(list.others.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ['Dormant', ['b']],
    ]);
    expect(list.status).toBe('done');
  });
  it('keeps every match in a lane of every standing', () => {
    const list = listFromSearch(
      [hit({ waterBodyId: 'a' as never }), hit({ waterBodyId: 'b' as never, inactive: true })],
      laneById('all'),
      'mor',
    );
    expect(list.rows.map((r) => r.standing)).toEqual(['active', 'dormant']);
    expect(list.others).toEqual([]);
  });
  it('says when it stopped at its limit', () => {
    const hits = Array.from({ length: SEARCH_LIMIT }, (_, i) =>
      hit({ waterBodyId: `h${i}` as never }),
    );
    expect(listFromSearch(hits, active, 'mor')).toMatchObject({
      status: 'capped',
      total: { count: SEARCH_LIMIT, capped: true },
    });
  });
  it('maps a hit, an unmeasured area unrecorded', () => {
    expect(rowFromHit(hit({ surfaceAreaSqM: undefined }))).toMatchObject({
      areaSqM: null,
      standing: 'active',
    });
  });
});

describe('answerHeld', () => {
  it('searches aliases too and says which one matched', () => {
    const { rows } = answerHeld(HELD, {
      q: 'fairlee p',
      state: null,
      facets: {},
      sort: { column: 'match' },
    });
    expect(rows.map((r) => [r.name, r.matchedAlias])).toEqual([['Lake Morey', 'Fairlee Pond']]);
  });
  it('counts each option against the other facets as they are', () => {
    const { facetCounts, total } = answerHeld(HELD, {
      q: '',
      state: null,
      facets: { size: ['1000-up'] },
      sort: { column: 'reports', dir: 'desc' },
    });
    const all = answerHeld(HELD, { q: '', state: null, facets: {}, sort: { column: 'match' } });
    expect(facetCounts?.size?.['1000-up']).toBe(total?.count);
    // The size facet's own counts ignore the size chosen; another facet's honor it.
    expect(facetCounts?.size?.['under-10'] ?? 0).toBe(all.facetCounts?.size?.['under-10'] ?? 0);
    const classes = Object.values(facetCounts?.class ?? {}).reduce((a = 0, b = 0) => a + b, 0);
    expect(classes).toBe(total?.count);
  });
  it('groups other standings under one divider per word', () => {
    const r = (id: string, standing: BodyRow['standing']) => ({
      ...(HELD[0]?.row as BodyRow),
      id,
      standing,
    });
    expect(
      groupOthers([r('a', 'inactive'), r('b', 'removed'), r('c', 'moderator')]).map((g) => [
        g.label,
        g.rows.map((x) => x.id),
      ]),
    ).toEqual([
      ['Dormant', ['a', 'c']],
      ['Removed', ['b']],
    ]);
  });
});

describe('the preview from the reads that exist', () => {
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

  it('draws what each read returned and leaves the reads that don’t exist out', () => {
    const p = previewFrom({
      body,
      putIns: [{ coord: { lat: 43.63, lng: -72.15 }, source: 'osm' }] as never,
      subAreas: [{}, {}] as never,
      history: [
        {
          id: 'r1',
          createdAt: 5,
          actor: { displayName: 'Sarah Berman', username: 'sarah' },
          action: 'hide',
          targetType: 'report',
        },
        { id: 'r2', createdAt: 4, actor: null, action: 'activate_body', targetType: 'waterbody' },
      ] as never,
    });
    expect(p).toMatchObject({
      id: 'm1',
      bays: 2,
      putIns: [{ lat: 43.63, lng: -72.15 }],
      meanDepthM: null,
      maxDepthM: 24,
      elevationM: null,
      town: null,
      season: null,
      allTime: null,
      complete: null,
      asks: null,
      standing: 'active',
    });
    expect(p.outline?.bbox).toEqual([-72.18, 43.6, -72.12, 43.65]);
    expect(p.history?.map((h) => h.actor)).toEqual(['Sarah', null]);
    expect(p.history?.[0]?.words).toBe('Hid a report');
  });
  it('leaves a block out while its read loads, and history out for a viewer who can’t read it', () => {
    const p = previewFrom({ body, putIns: undefined, subAreas: undefined, history: null });
    expect(p).toMatchObject({ putIns: null, bays: null, history: null });
  });
  it('reads polygons and multipolygons, nothing else', () => {
    expect(polygonsOf(body.polygon)).toHaveLength(1);
    expect(
      polygonsOf({ type: 'MultiPolygon', coordinates: [[[[0, 0]]], [[[1, 1]]]] } as never),
    ).toEqual([[[[0, 0]]], [[[1, 1]]]]);
    expect(polygonsOf({ type: 'Point', coordinates: [0, 0] } as never)).toEqual([]);
  });
});
