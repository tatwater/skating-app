import { DEFAULT_SEASON_WATCH_SETTINGS } from '@skating/core';
import { describe, expect, it } from 'vitest';
import {
  chartRows,
  fromForm,
  lowF,
  previewSeasons,
  rosterEntries,
  rosterOf,
  type SeriesDoc,
  sameSettings,
  seasonsIn,
  sentinelCrossings,
  shortDay,
  siteSeriesFor,
  toForm,
} from './seasonPreview';

const doc = (
  season: string,
  id: string,
  firstDate: string,
  lows: (number | null)[],
  source: SeriesDoc['source'] = 'archive',
): SeriesDoc => ({
  season,
  waterBodyId: id,
  name: id === 'clouds' ? 'Upper Lake of the Clouds' : id,
  state: 'NH',
  source,
  firstDate,
  lows,
});

const docs: SeriesDoc[] = [
  // 2025-26: the summit dips in September (before the floor), freezes 1 Oct, 20 °F on 9 Oct.
  doc('winter-2025-26', 'clouds', '2025-09-29', [-1, 3, -2.5, -4.3, 1, 2, 3, 4, 5, -2, -7.2]),
  doc('winter-2025-26', 'valley', '2025-09-29', [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]),
  doc('winter-2025-26', 'stale', '2025-09-29', [-9, -9, -9]),
  doc('winter-2026-27', 'clouds', '2026-10-01', [7, 3.5, -0.4, -0.2], 'forecast'),
  doc('winter-2026-27', 'valley', '2026-10-01', [12, 12, 6, 2], 'archive'),
];
const roster = { sentinelIds: ['clouds'], ordinaryIds: ['valley'] };

describe('the replay', () => {
  it('lists seasons newest first and leaves out sites in neither list', () => {
    expect(seasonsIn(docs)).toEqual(['winter-2026-27', 'winter-2025-26']);
    const series = siteSeriesFor('winter-2025-26', docs, roster);
    expect(series.map((s) => [s.siteId, s.sentinel ?? false])).toEqual([
      ['clouds', true],
      ['valley', false],
    ]);
  });

  it('replays each season under the settings, beside the field dates', () => {
    const rows = previewSeasons(docs, roster, DEFAULT_SEASON_WATCH_SETTINGS, [
      { season: 'winter-2025-26', kind: 'first_skated', date: '2025-12-01' },
      { season: 'winter-2025-26', kind: 'first_skated', date: '2025-11-28' },
      { season: 'winter-2025-26', kind: 'last_skated', date: '2026-03-10' },
      { season: 'winter-2025-26', kind: 'last_skated', date: '2026-03-20' },
    ]);
    expect(rows[0]).toMatchObject({
      season: 'winter-2026-27',
      source: 'mixed',
      firstSkated: null,
      leadDays: null,
    });
    expect(rows[0]?.evaluation.opensOn).toBe('2026-10-03');
    expect(rows[1]).toMatchObject({
      season: 'winter-2025-26',
      source: 'archive',
      firstSkated: '2025-11-28',
      lastSkated: '2026-03-20',
      leadDays: 58,
    });
    expect(rows[1]?.evaluation.opensOn).toBe('2025-10-01');
    expect(rows[1]?.evaluation.imageryNudge?.date).toBe('2025-10-09');
  });

  it('counts the watched lakes a season has no lows for, rather than replaying fewer silently', () => {
    const rows = previewSeasons(
      docs,
      { sentinelIds: ['clouds'], ordinaryIds: ['valley', 'new-sample'] },
      DEFAULT_SEASON_WATCH_SETTINGS,
      [],
    );
    expect(rows.map((r) => [r.watched, r.missingLows])).toEqual([
      [3, 1],
      [3, 1],
    ]);
    expect(previewSeasons(docs, roster, DEFAULT_SEASON_WATCH_SETTINGS, [])[0]?.missingLows).toBe(0);
  });

  it('builds the roster from the resolved sites, not the ids a version stored', () => {
    // `clouds-old` was merged into `clouds`: the server resolved it, so the replay reads `clouds`.
    const sites = [
      {
        siteId: 'clouds',
        role: 'sentinel' as const,
        name: 'Upper Lake of the Clouds',
        state: 'NH',
      },
      { siteId: 'low-plains', role: 'pinned' as const, name: 'Low Plains' },
      { siteId: 'valley', role: 'sample' as const, name: 'Valley' },
    ];
    expect(rosterOf(sites)).toEqual({
      sentinelIds: ['clouds'],
      ordinaryIds: ['low-plains', 'valley'],
    });
    expect(rosterEntries(sites, 'sentinel')).toEqual([
      { waterBodyId: 'clouds', name: 'Upper Lake of the Clouds', state: 'NH' },
    ]);
    expect(rosterEntries(sites, 'pinned')).toEqual([
      { waterBodyId: 'low-plains', name: 'Low Plains' },
    ]);
  });

  it('a November floor postpones every season it can', () => {
    const rows = previewSeasons(
      docs,
      roster,
      { ...DEFAULT_SEASON_WATCH_SETTINGS, startMonthDay: '11-01' },
      [],
    );
    expect(rows.map((r) => r.evaluation.opensOn)).toEqual([null, null]);
  });

  it('names each sentinel’s first freezing night, first imagery night and coldest, from the floor', () => {
    expect(
      sentinelCrossings(
        'winter-2025-26',
        docs,
        ['clouds', 'missing'],
        DEFAULT_SEASON_WATCH_SETTINGS,
      ),
    ).toEqual([
      {
        waterBodyId: 'clouds',
        name: 'Upper Lake of the Clouds',
        state: 'NH',
        firstFreeze: { date: '2025-10-01', minTempC: -2.5 },
        firstImageryNight: { date: '2025-10-09', minTempC: -7.2 },
        coldest: { date: '2025-10-09', minTempC: -7.2 },
      },
    ]);
  });

  it('charts sentinel lows in °F from a date', () => {
    expect(chartRows('winter-2026-27', docs, ['clouds', 'missing'], '2026-10-03')).toEqual([
      { date: '2026-10-03', clouds: 31.3 },
      { date: '2026-10-04', clouds: 31.6 },
    ]);
  });
});

describe('the form', () => {
  it('shows the defaults in °F and percent, and an untouched form is the saved settings exactly', () => {
    const form = toForm(DEFAULT_SEASON_WATCH_SETTINGS);
    expect(form).toEqual({
      startMonthDay: '10-01',
      freezeF: '32',
      sentinelNights: '1',
      corpusPct: '10',
      winterPct: '50',
      imageryNudgeF: '20',
      thawF: '32',
      thawRunDays: '10',
      sampleSize: '24',
    });
    const back = fromForm(form, DEFAULT_SEASON_WATCH_SETTINGS);
    expect(back).toEqual(DEFAULT_SEASON_WATCH_SETTINGS);
    expect(sameSettings(back, DEFAULT_SEASON_WATCH_SETTINGS)).toBe(true);
  });

  it('converts an edit, and leaves a blank field as NaN for validation to name', () => {
    const edited = fromForm(
      {
        ...toForm(DEFAULT_SEASON_WATCH_SETTINGS),
        freezeF: '28.4',
        winterPct: '60',
        sentinelNights: '',
        startMonthDay: ' 11-01 ',
      },
      DEFAULT_SEASON_WATCH_SETTINGS,
    );
    expect(edited.freezeC).toBeCloseTo(-2, 10);
    expect(edited.winterFraction).toBe(0.6);
    expect(edited.sentinelNights).toBeNaN();
    expect(edited.startMonthDay).toBe('11-01');
    expect(sameSettings(edited, DEFAULT_SEASON_WATCH_SETTINGS)).toBe(false);
  });

  it('formats days and lows', () => {
    expect(shortDay('2026-10-03')).toBe('Oct 3');
    expect(shortDay(null)).toBe('—');
    expect(lowF(-0.4)).toBe('31.3°F');
    expect(lowF(-25)).toBe('−13.0°F');
  });
});
