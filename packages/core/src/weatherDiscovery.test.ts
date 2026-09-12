import { describe, expect, it } from 'vitest';
import type { ColdChainDay } from './coldChain';
import { hasWeatherFilter, mapFilters, matchesFilters, sanitizeFeedFilters } from './feedFilters';
import { weatherCellFor } from './weatherCell';
import {
  type BodyResultData,
  buildBodyResultView,
  buildWeatherCellDigest,
  describeWeatherFilter,
  eventInstantMs,
  interleaveLatest,
  type LatestItem,
  matchWeatherFilter,
  nightsFieldFor,
  ONE_SAMPLE_CAVEAT,
  sanitizeWeatherFilter,
  WEATHER_FILTER_MAX_NIGHTS,
  weatherDimmedBodyIds,
} from './weatherDiscovery';

const DAY = 86_400_000;
const d0 = Date.UTC(2026, 0, 10);
const day = (i: number) => d0 + i * DAY;

/** `c` = −14 °C (below 10°F, not 0°F), `f` = −2 °C (below 32 only), `m` = +2 °C, `?` unobserved. */
function nights(pattern: string, snow: Record<number, number | null> = {}): ColdChainDay[] {
  return [...pattern].map((ch, i) => ({
    dayMs: day(i),
    nightMinTempC: ch === 'c' ? -14 : ch === 'f' ? -2 : ch === 'm' ? 2 : null,
    snowfallCm: i in snow ? (snow[i] as number | null) : 0,
  }));
}

describe('buildWeatherCellDigest', () => {
  it('stores one alive chain per threshold and flattens the lengths for the indexes', () => {
    const digest = buildWeatherCellDigest(nights('mfccc'), day(4));
    expect(digest.asOfDayMs).toBe(day(4));
    expect(digest.daysKnown).toBe(5);
    // −14 °C clears every threshold except 0°F (−17.8 °C); −2 °C clears only 32°F.
    expect(digest.nightsBelow32F).toBe(4);
    expect(digest.nightsBelow20F).toBe(3);
    expect(digest.nightsBelow10F).toBe(3);
    expect(digest.nightsBelow0F).toBe(0);
    expect(digest.chains.map((c) => c.thresholdF)).toEqual([32, 20, 10]);
  });

  it('ignores days newer than as-of, so today’s partial row never reaches a filter', () => {
    const digest = buildWeatherCellDigest(nights('mccc'), day(2));
    expect(digest.nightsBelow20F).toBe(2);
    expect(digest.daysKnown).toBe(3);
  });

  it('stores nothing for a dead chain — a filter never matches one', () => {
    const digest = buildWeatherCellDigest(nights('cccmm'), day(4));
    expect(digest.chains).toEqual([]);
    expect(digest.nightsBelow20F).toBe(0);
  });

  it('names the index field per threshold', () => {
    expect(nightsFieldFor(32)).toBe('nightsBelow32F');
    expect(nightsFieldFor(0)).toBe('nightsBelow0F');
  });
});

describe('matchWeatherFilter — the event day (D165)', () => {
  const digest = buildWeatherCellDigest(nights('mccmcc', { 4: 3 }), day(5));

  it('matches at or above the requested length and dates the crossing', () => {
    const m = matchWeatherFilter(digest, { thresholdF: 20, minNights: 3 });
    expect(m?.eventDayMs).toBe(day(4)); // the bridged 3rd night is not the third cold one
    expect(matchWeatherFilter(digest, { thresholdF: 20, minNights: 5 })).toBeNull();
  });

  it('refuses "no snow since" when snow fell inside the chain', () => {
    expect(
      matchWeatherFilter(digest, { thresholdF: 20, minNights: 3, noSnowSince: true }),
    ).toBeNull();
    const clean = buildWeatherCellDigest(nights('mccmcc'), day(5));
    expect(
      matchWeatherFilter(clean, { thresholdF: 20, minNights: 3, noSnowSince: true })?.eventDayMs,
    ).toBe(day(4));
  });

  it('refuses "no snow since" when a day since the first night has no snow figure', () => {
    const unknown = buildWeatherCellDigest(nights('mccc', { 2: null }), day(3));
    expect(matchWeatherFilter(unknown, { thresholdF: 20, minNights: 2 })).not.toBeNull();
    expect(
      matchWeatherFilter(unknown, { thresholdF: 20, minNights: 2, noSnowSince: true }),
    ).toBeNull();
  });

  it('places the event at noon UTC of its day', () => {
    expect(eventInstantMs(day(4))).toBe(day(4) + 12 * 60 * 60 * 1000);
  });
});

describe('sanitizeWeatherFilter', () => {
  it('accepts the pinned thresholds and an integer night count', () => {
    expect(sanitizeWeatherFilter({ thresholdF: 20, minNights: 3 })).toEqual({
      thresholdF: 20,
      minNights: 3,
    });
    expect(sanitizeWeatherFilter({ thresholdF: 20, minNights: 3, noSnowSince: true })).toEqual({
      thresholdF: 20,
      minNights: 3,
      noSnowSince: true,
    });
  });

  it('drops anything off the pinned set', () => {
    expect(sanitizeWeatherFilter({ thresholdF: 25, minNights: 3 })).toBeUndefined();
    expect(sanitizeWeatherFilter({ thresholdF: 20, minNights: 0 })).toBeUndefined();
    expect(sanitizeWeatherFilter({ thresholdF: 20, minNights: 2.5 })).toBeUndefined();
    expect(
      sanitizeWeatherFilter({ thresholdF: 20, minNights: WEATHER_FILTER_MAX_NIGHTS + 1 }),
    ).toBeUndefined();
    expect(sanitizeWeatherFilter(null)).toBeUndefined();
    expect(sanitizeWeatherFilter('20/3')).toBeUndefined();
  });
});

describe('FeedFilters — the weather knob and the escape hatch', () => {
  it('sanitizes through the shared row', () => {
    const f = sanitizeFeedFilters({
      radiusMinutes: 60,
      weather: { thresholdF: 20, minNights: 3 },
      onlyReports: true,
    });
    expect(f.weather).toEqual({ thresholdF: 20, minNights: 3 });
    expect(f.onlyReports).toBe(true);
    expect(hasWeatherFilter(f)).toBe(true);
    expect(hasWeatherFilter(sanitizeFeedFilters({ onlyReports: true }))).toBe(false);
  });

  it('is a hard narrow on reports, favorites included', () => {
    const report = { skateEndTime: 1_000 };
    const filters = sanitizeFeedFilters({ weather: { thresholdF: 20, minNights: 3 } });
    const base = { band: null, isFavorite: true, now: 2_000 };
    expect(matchesFilters(report, filters, { ...base, weatherMatched: true })).toBe(true);
    expect(matchesFilters(report, filters, { ...base, weatherMatched: false })).toBe(false);
    // Unresolved under a weather filter is not a match.
    expect(matchesFilters(report, filters, base)).toBe(false);
    // And without a weather filter the flag is ignored.
    expect(matchesFilters(report, {}, { ...base, weatherMatched: false })).toBe(true);
  });

  it('gives the map only what describes a place (D166)', () => {
    const f = sanitizeFeedFilters({
      radiusMinutes: 30,
      qualityFloor: 'great',
      weather: { thresholdF: 20, minNights: 3 },
      recencyHours: 24,
    });
    expect(mapFilters(f)).toEqual({ radiusMinutes: 30, weather: { thresholdF: 20, minNights: 3 } });
    expect(mapFilters({})).toEqual({});
  });
});

describe('buildBodyResultView — the card (D165)', () => {
  const chain = buildWeatherCellDigest(nights('mccc'), day(3)).chains.find(
    (c) => c.thresholdF === 20,
  );
  const base = {
    waterBodyId: 'b1',
    name: 'Lake Champlain',
    type: 'lakePond',
    states: ['VT', 'NY'],
    eventMs: day(3) + 12 * 3_600_000,
    eventDayMs: day(3),
    asOfDayMs: day(3),
    chain: chain as NonNullable<typeof chain>,
    otherBayNames: [],
    oneSampleForALargeBody: false,
    noPublicAccess: false,
    isFavorite: false,
  };

  it('leads with the lake, then class and state, and names its anchor and its date', () => {
    const view = buildBodyResultView({ ...base, place: { kind: 'body' } }, day(3) + 13 * 3_600_000);
    expect(view.locationPrimary).toBe('Lake Champlain');
    expect(view.locationSecondary).toBe('Lake or pond · VT, NY');
    expect(view.headline).toBe('3 nights below 20°F, no snow since the first');
    expect(view.asOfLabel).toBe('as of Jan 13');
    expect(view.relativeTime).toBe('1h ago');
    expect(view.focusSubAreaId).toBeNull();
    expect(view.alsoAtLabel).toBeNull();
    expect(view.caveat).toBeNull();
  });

  it('leads with the bay when the reading was taken there, and lists the others', () => {
    const view = buildBodyResultView(
      {
        ...base,
        place: { kind: 'subArea', subAreaId: 's1', name: 'Malletts Bay' },
        otherBayNames: ['Shelburne Bay', 'Burlington Bay'],
      },
      day(4),
    );
    expect(view.locationPrimary).toBe('Malletts Bay');
    expect(view.locationSecondary).toBe('Lake Champlain · Lake or pond · VT, NY');
    expect(view.alsoAtLabel).toBe('Also at Shelburne Bay, Burlington Bay');
    expect(view.focusSubAreaId).toBe('s1');
  });

  it('carries the size caveat and the access mark', () => {
    const view = buildBodyResultView(
      { ...base, place: { kind: 'body' }, oneSampleForALargeBody: true, noPublicAccess: true },
      day(4),
    );
    expect(view.caveat).toBe(ONE_SAMPLE_CAVEAT);
    expect(view.noPublicAccess).toBe(true);
  });
});

describe('interleaveLatest — bodies among reports, newest first (D165)', () => {
  const body = (id: string, eventMs: number): BodyResultData => ({
    waterBodyId: id,
    name: id,
    type: 'lakePond',
    eventMs,
    eventDayMs: eventMs,
    asOfDayMs: eventMs,
    chain: {
      thresholdF: 20,
      nights: 3,
      startDayMs: 0,
      coldNightMask: 7,
      openEnded: false,
      snowSinceStartCm: 0,
      snowUnknownDays: 0,
    },
    place: { kind: 'body' },
    otherBayNames: [],
    oneSampleForALargeBody: false,
    noPublicAccess: false,
    isFavorite: false,
  });
  const report = (id: string, t: number) => ({ id, t });
  const kinds = (items: LatestItem<{ id: string; t: number }>[]) =>
    items.map((i) => (i.kind === 'report' ? `r:${i.data.id}` : `b:${i.data.waterBodyId}`));

  it('slots each body above the first report older than it', () => {
    const items = interleaveLatest(
      [report('r1', 100), report('r2', 60), report('r3', 20)],
      (r) => r.t,
      [body('b1', 80), body('b2', 30)],
      true,
    );
    expect(kinds(items)).toEqual(['r:r1', 'b:b1', 'r:r2', 'b:b2', 'r:r3']);
  });

  it('holds back a body older than the oldest loaded report until the reports catch up', () => {
    const notExhausted = interleaveLatest(
      [report('r1', 100), report('r2', 60)],
      (r) => r.t,
      [body('b1', 80), body('b2', 30)],
      false,
    );
    expect(kinds(notExhausted)).toEqual(['r:r1', 'b:b1', 'r:r2']);
    const exhausted = interleaveLatest(
      [report('r1', 100), report('r2', 60)],
      (r) => r.t,
      [body('b1', 80), body('b2', 30)],
      true,
    );
    expect(kinds(exhausted)).toEqual(['r:r1', 'b:b1', 'r:r2', 'b:b2']);
  });

  it('lists every body when there are no reports at all', () => {
    expect(
      kinds(
        interleaveLatest(
          [] as { id: string; t: number }[],
          (r) => r.t,
          [body('b1', 80), body('b2', 30)],
          false,
        ),
      ),
    ).toEqual(['b:b1', 'b:b2']);
  });
});

describe('weatherDimmedBodyIds — the map dim (D166)', () => {
  const A = { lat: 44.05, lng: -72.05 };
  const B = { lat: 44.55, lng: -72.55 };
  const bodies = [
    { _id: 'a', centroid: A, interiorPoint: A },
    { _id: 'b', centroid: B },
    { _id: 'giant', centroid: { lat: 44.25, lng: -73.35 } },
  ];
  const matched = {
    cellKeys: [weatherCellFor('filter', A.lat, A.lng).key],
    bayBodyIds: ['giant'],
  };
  const viewer = { bands: {}, favorites: new Set<string>() };
  const weather = { thresholdF: 20 as const, minNights: 3 };

  it('dims nothing without a weather filter, radius or not', () => {
    expect(weatherDimmedBodyIds(bodies, { radiusMinutes: 30 }, matched, viewer).size).toBe(0);
  });

  it('dims bodies whose cell did not match, keeping a giant matched through a bay', () => {
    expect([...weatherDimmedBodyIds(bodies, { weather }, matched, viewer)]).toEqual(['b']);
  });

  it('dims nothing until the matched cells arrive — a loading map is not a dimmed one', () => {
    expect(weatherDimmedBodyIds(bodies, { weather }, undefined, viewer).size).toBe(0);
  });

  it('applies the radius to matches, favorites exempt', () => {
    const outerOnly = {
      bands: { outerRadiusMeters: 1_000 },
      home: B,
      favorites: new Set<string>(),
    };
    // A matches by cell but is ~55 km from home, beyond a 1 km outer ring: dimmed. The giant is
    // even further and matched through a bay: dimmed too.
    expect(
      [...weatherDimmedBodyIds(bodies, { weather, radiusMinutes: 90 }, matched, outerOnly)].sort(),
    ).toEqual(['a', 'b', 'giant']);
    expect(
      [
        ...weatherDimmedBodyIds(bodies, { weather, radiusMinutes: 90 }, matched, {
          ...outerOnly,
          favorites: new Set(['a']),
        }),
      ].sort(),
    ).toEqual(['b', 'giant']);
  });
});

describe('describeWeatherFilter — the map chip (D166)', () => {
  it('names the knob, the radius and the date', () => {
    expect(
      describeWeatherFilter(
        { weather: { thresholdF: 20, minNights: 3, noSnowSince: true }, radiusMinutes: 60 },
        day(4),
      ),
    ).toBe('Showing lakes with 3+ nights below 20°F, no snow since · within 60 min · as of Jan 14');
    expect(describeWeatherFilter({ weather: { thresholdF: 32, minNights: 1 } }, null)).toBe(
      'Showing lakes with 1+ night below 32°F',
    );
    expect(describeWeatherFilter({}, day(4))).toBe('');
  });
});
