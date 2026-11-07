import type { BodyResultData, FeedFilters, PostCardData } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  answeredLabel,
  changedFilters,
  expiresLabel,
  groupWanted,
  latestFeedState,
  latestSections,
  mapBannerLine,
  type OpenBountyRow,
  patchFilters,
  searchSummary,
} from './latestModel';
import { latestSearchSchema } from './latestSearch';

const HOUR = 3_600_000;
const NOW = Date.UTC(2027, 0, 16, 17);

function post(id: string, ageHours: number, reportIds = [`${id}-r`]): PostCardData {
  const t = NOW - ageHours * HOUR;
  return {
    postId: id,
    latestSkateEndTime: t,
    reports: reportIds.map((reportId) => ({ reportId, skateEndTime: t })),
  } as unknown as PostCardData;
}

function body(id: string, ageHours: number): BodyResultData {
  return { waterBodyId: id, eventMs: NOW - ageHours * HOUR } as unknown as BodyResultData;
}

describe('latestSections', () => {
  it('drops recommended reports, slots matched lakes in by time, and sections by recency', () => {
    const sections = latestSections(
      [post('a', 1), post('b', 30, ['b1', 'b2']), post('c', 100)],
      new Set(['a-r', 'b1']),
      [body('w1', 20), body('w2', 500)],
      false,
      NOW,
    );
    expect(sections.map((s) => s.key)).toEqual(['today', 'yesterday', 'this-week']);
    const rows = sections.flatMap((s) => s.items);
    expect(rows.map((r) => (r.kind === 'report' ? r.data.postId : r.data.waterBodyId))).toEqual([
      'w1',
      'b',
      'c',
    ]);
    // The recommended member left the post; the other stayed.
    const b = rows[1];
    expect(b?.kind === 'report' && b.data.reports.map((r) => r.reportId)).toEqual(['b2']);
  });

  it('lets an older lake in once the pages are exhausted', () => {
    const rows = latestSections([post('a', 1)], new Set(), [body('w', 500)], true, NOW).flatMap(
      (s) => s.items,
    );
    expect(rows).toHaveLength(2);
  });
});

describe('latestFeedState', () => {
  const base = {
    status: 'Exhausted' as const,
    rowCount: 0,
    filters: {} as FeedFilters,
    weatherAvailable: true,
    searching: false,
    skaterUnavailable: false,
  };
  const weather: FeedFilters = { weather: { thresholdF: 20, minNights: 3 } };

  it.each([
    [{ skaterUnavailable: true, rowCount: 3 }, 'skater-unavailable'],
    [{ status: 'LoadingFirstPage' }, 'loading'],
    [{ rowCount: 2 }, 'feed'],
    [{ searching: true, filters: weather }, 'search-empty'],
    [{ filters: weather, weatherAvailable: false }, 'no-weather-data'],
    [{ filters: weather, weatherAvailable: undefined }, 'no-lake-match'],
    [{ filters: weather, status: 'CanLoadMore' }, 'no-lake-match'],
    [{ status: 'CanLoadMore', filters: { qualityFloor: 'good' } }, 'nothing-on-page'],
    [{ status: 'LoadingMore' }, 'nothing-on-page'],
    [{ filters: { noSnow: true } }, 'nothing-matches'],
    [{}, 'no-reports'],
  ] as const)('%o → %s', (over, state) => {
    expect(latestFeedState({ ...base, ...(over as object) })).toBe(state);
  });
});

describe('changedFilters', () => {
  it('names each control a change touched, once, never the value', () => {
    expect(
      changedFilters(
        { radiusMinutes: 30, iceTypes: ['black_ice'] },
        { radiusMinutes: 60, surfaceTags: ['glass'], onlyReports: true },
      ),
    ).toEqual(['drive_time', 'ice_type', 'weather_match']);
  });

  it('counts nothing for an unchanged row or the snow box (no taxonomy value yet)', () => {
    expect(changedFilters({ qualityFloor: 'good' }, { qualityFloor: 'good' })).toEqual([]);
    expect(changedFilters({}, { noSnow: true })).toEqual([]);
  });

  it('reports every control a clear-all turns off', () => {
    expect(
      changedFilters(
        {
          recencyHours: 24,
          thicknessFloorCm: 10,
          qualityFloor: 'great',
          weather: { thresholdF: 20, minNights: 3 },
        },
        {},
      ),
    ).toEqual(['posted', 'quality', 'thickness', 'weather_match']);
  });
});

describe('patchFilters', () => {
  it('sets a key, and drops it on undefined, never mutating', () => {
    const before: FeedFilters = { qualityFloor: 'good' };
    expect(patchFilters(before, 'recencyHours', 24)).toEqual({
      qualityFloor: 'good',
      recencyHours: 24,
    });
    expect(patchFilters(before, 'qualityFloor', undefined)).toEqual({});
    expect(before).toEqual({ qualityFloor: 'good' });
  });
});

describe('searchSummary', () => {
  it('counts only when no filter is on, and says when it is the closest hundred', () => {
    expect(
      searchSummary({ query: 'narrows', matched: 3, truncated: false, filtersOn: false }),
    ).toBe('3 reports mention “narrows”, newest first');
    expect(searchSummary({ query: 'x', matched: 1, truncated: false, filtersOn: false })).toBe(
      '1 report mentions “x”, newest first',
    );
    expect(searchSummary({ query: 'x', matched: 9, truncated: false, filtersOn: true })).toBe(
      'Reports that mention “x” under your filters, newest first',
    );
    expect(
      searchSummary({ query: 'x', matched: undefined, truncated: false, filtersOn: false }),
    ).toMatch(/^Reports that mention/);
    expect(searchSummary({ query: 'ice', matched: 100, truncated: true, filtersOn: false })).toBe(
      'Showing the closest 100 reports that mention “ice” — narrow the search',
    );
  });
});

describe('groupWanted', () => {
  const row = (over: Partial<OpenBountyRow>): OpenBountyRow => ({
    _id: 'b',
    waterBodyId: 'w1',
    waterBodyName: 'Mascoma Lake',
    requester: { displayName: 'Rob Tremblay' },
    fulfillingCount: 0,
    createdAt: 0,
    expiresAt: 0,
    ...over,
  });

  it('gathers asks by place, opening the first-asked, keeping the server order', () => {
    const groups = groupWanted(
      [
        row({
          _id: 'b2',
          subAreaName: 'Mascoma North',
          createdAt: 5,
          expiresAt: 50,
          requester: { displayName: 'Ana' },
        }),
        row({
          _id: 'b1',
          subAreaName: 'Mascoma North',
          createdAt: 1,
          expiresAt: 90,
          fulfillingCount: 1,
        }),
        row({ _id: 'b3', waterBodyId: 'w2', waterBodyName: 'Crystal Lake', createdAt: 2 }),
      ],
      5,
    );
    expect(groups).toEqual([
      {
        key: 'w1|Mascoma North',
        bountyId: 'b1',
        place: 'Mascoma North',
        lake: 'Mascoma Lake',
        count: 2,
        firstAsker: { displayName: 'Rob Tremblay' },
        expiresAt: 90,
        answered: 1,
      },
      expect.objectContaining({ bountyId: 'b3', place: 'Crystal Lake', lake: null, count: 1 }),
    ]);
    expect(groupWanted([row({})], 0)).toEqual([]);
  });

  it('never loses or invents an ask, and always opens the earliest in its place', () => {
    const arb = fc.array(
      fc.record({
        _id: fc.uuid(),
        waterBodyId: fc.constantFrom('w1', 'w2', 'w3'),
        sub: fc.option(fc.constantFrom('North', 'South'), { nil: undefined }),
        createdAt: fc.integer({ min: 0, max: 1e6 }),
        fulfillingCount: fc.nat(3),
      }),
    );
    fc.assert(
      fc.property(arb, (raw) => {
        const rows = raw.map((r) =>
          row({
            _id: r._id,
            waterBodyId: r.waterBodyId,
            ...(r.sub !== undefined ? { subAreaName: r.sub } : {}),
            createdAt: r.createdAt,
            fulfillingCount: r.fulfillingCount,
          }),
        );
        const groups = groupWanted(rows, Number.POSITIVE_INFINITY);
        expect(groups.reduce((n, g) => n + g.count, 0)).toBe(rows.length);
        expect(groups.reduce((n, g) => n + g.answered, 0)).toBe(
          rows.reduce((n, r) => n + r.fulfillingCount, 0),
        );
        for (const g of groups) {
          const members = rows.filter((r) => `${r.waterBodyId}|${r.subAreaName ?? ''}` === g.key);
          const earliest = Math.min(...members.map((r) => r.createdAt));
          expect(members.find((r) => r._id === g.bountyId)?.createdAt).toBe(earliest);
        }
      }),
    );
  });
});

describe('labels', () => {
  it('says how long an ask stays open', () => {
    expect(expiresLabel(NOW + 10 * 60_000, NOW)).toBe('Expires within the hour');
    expect(expiresLabel(NOW + HOUR, NOW)).toBe('Expires in 1 hour');
    expect(expiresLabel(NOW + 5 * HOUR, NOW)).toBe('Expires in 5 hours');
    expect(expiresLabel(NOW + 24 * HOUR, NOW)).toBe('Expires in 1 day');
    expect(expiresLabel(NOW + 5 * 24 * HOUR + 3, NOW)).toBe('Expires in 5 days');
  });

  it('says how many reports already answer', () => {
    expect(answeredLabel(0)).toBe('No reports yet');
    expect(answeredLabel(1)).toBe('1 report so far');
    expect(answeredLabel(4)).toBe('4 reports so far');
  });
});

describe('latestSearchSchema', () => {
  it('keeps the transient view, and a bad link degrades to the plain feed', () => {
    expect(
      latestSearchSchema.parse({ report: 'r1', q: '  narrows ', skater: 'sb', view: 'map' }),
    ).toEqual({
      report: 'r1',
      q: 'narrows',
      skater: 'sb',
      view: 'map',
    });
    expect(latestSearchSchema.parse({ report: '', q: '   ', view: 'list', skater: 7 })).toEqual({
      report: undefined,
      q: undefined,
      skater: undefined,
      view: undefined,
    });
    expect(latestSearchSchema.parse({ q: 'x'.repeat(500) }).q).toHaveLength(200);
    // Filters never ride the URL (D242, Q3): an old filtered link drops them.
    expect(latestSearchSchema.parse({ qualityFloor: 'good' })).not.toHaveProperty('qualityFloor');
  });
});

describe('mapBannerLine', () => {
  it('says what the map is dimming by, in weather words only', () => {
    const asOf = Date.UTC(2027, 0, 15);
    expect(
      mapBannerLine(
        { weather: { thresholdF: 20, minNights: 3, noSnowSince: true }, radiusMinutes: 60 },
        asOf,
      ),
    ).toMatch(
      /^Showing lakes with 3\+ nights below 20°F, no snow since · within 60 min · as of Jan 1[45]$/,
    );
    expect(mapBannerLine({ weather: { thresholdF: 32, minNights: 1 } }, null)).toBe(
      'Showing lakes with 1+ night below 32°F',
    );
    expect(mapBannerLine({ radiusMinutes: 30 }, asOf)).toBe('Showing lakes within 30 min');
    expect(mapBannerLine({ qualityFloor: 'good' }, asOf)).toBe(
      'Every lake — no weather filter is on',
    );
  });
});
