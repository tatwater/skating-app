import type { FeedCardData } from '@skating/core';
import { describe, expect, it } from 'vitest';
import {
  type CachedReportRow,
  cachedReportsFromRows,
  fromCachedRow,
  toCachedRow,
} from './reportCacheModel';

const CARD: FeedCardData = {
  reportId: 'r1',
  waterBodyId: 'wb1',
  bodyName: 'Lake Morey',
  place: { town: 'Fairlee', state: 'VT' },
  skateEndTime: Date.UTC(2026, 0, 5, 11, 0),
  iceTypes: ['black_ice'],
  surfaceTags: ['glass'],
  skateQuality: 'great',
  photoThumbUrls: ['https://x/thumb1.jpg'],
  author: { displayName: 'Ada', username: 'ada' },
  blocked: false,
  isFavorite: true,
};

describe('toCachedRow / fromCachedRow', () => {
  it('round-trips a feed card losslessly', () => {
    const row = toCachedRow(CARD, 1000);
    expect(row.reportId).toBe('r1');
    expect(row.waterBodyId).toBe('wb1');
    expect(row.cachedAt).toBe(1000);
    expect(fromCachedRow(row)).toEqual(CARD);
  });

  it('returns null for corrupt JSON', () => {
    expect(fromCachedRow({ data: 'not json' })).toBeNull();
  });

  it('returns null for a non-object or shape-mismatched blob', () => {
    expect(fromCachedRow({ data: '42' })).toBeNull();
    expect(fromCachedRow({ data: JSON.stringify({ reportId: 5 }) })).toBeNull();
  });
});

describe('cachedReportsFromRows', () => {
  it('orders newest-first and drops corrupt rows', () => {
    const rows: CachedReportRow[] = [
      toCachedRow({ ...CARD, reportId: 'old' }, 100),
      toCachedRow({ ...CARD, reportId: 'new' }, 300),
      { reportId: 'bad', waterBodyId: 'x', cachedAt: 200, data: '{{' },
    ];
    const cards = cachedReportsFromRows(rows);
    expect(cards.map((c) => c.reportId)).toEqual(['new', 'old']);
  });

  it('is empty for no rows', () => {
    expect(cachedReportsFromRows([])).toEqual([]);
  });
});
