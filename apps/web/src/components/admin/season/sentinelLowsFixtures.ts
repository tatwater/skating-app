import { fahrenheitToCelsius } from '@skating/core';

import type { SentinelLowsRead } from './sentinelLowsModel';

/**
 * The Seasons board's sentinel row (7.1 Seasons | Winter 2026–27), as `sentinelLows.forSeason` would
 * send it — for stories and tests only (`fixturesStayInStories`): the board's numbers are made up.
 * Stored lows are °C, so the board's °F go back through the watch's own conversion.
 */

type Valued = Extract<SentinelLowsRead, { state: 'value' }>;

const c = (fs: ReadonlyArray<number | null>) =>
  fs.map((f) => (f === null ? null : fahrenheitToCelsius(f)));

const CLOUDS = [34, 31, 27, 30, 24, 29, 19, 25, 28, 33, 30, 31];
const EAGLE = [36, 33, 30, 31, 27, 31, 19, 26, 30, 35, 32, 33];
const KINSMAN = [40, 38, 35, 36, 33, 35, 27, 32, 34, 38, 36, 37];

const site = (key: string, name: string, lows: ReadonlyArray<number | null>) =>
  ({ key, bodyId: key, name, status: 'read', lows: c(lows) }) as const;

export const LOWS_BOARD: Valued = {
  state: 'value',
  season: 2026,
  countsFrom: '2026-10-01',
  firstDate: '2026-10-01',
  lastDate: '2026-10-12',
  sentinels: [
    site('clouds', 'Upper Lake of the Clouds', CLOUDS),
    site('eagle', 'Eagle Lake', EAGLE),
    site('kinsman', 'Kinsman Pond', KINSMAN),
  ] as Valued['sentinels'],
  lines: { watchC: 0, imageryC: fahrenheitToCelsius(20) },
  opened: {
    on: '2026-10-03',
    of: 3,
    sites: [
      { key: 'clouds', name: 'Upper Lake of the Clouds', lowC: fahrenheitToCelsius(27) },
      { key: 'eagle', name: 'Eagle Lake', lowC: fahrenheitToCelsius(30) },
    ],
  } as Valued['opened'],
  imageryLine: {
    on: '2026-10-07',
    sites: [
      { key: 'clouds', name: 'Upper Lake of the Clouds', lowC: fahrenheitToCelsius(19) },
      { key: 'eagle', name: 'Eagle Lake', lowC: fahrenheitToCelsius(19) },
    ],
  } as Valued['imageryLine'],
};

/** The board with gaps: Clouds missed the opening night, Eagle's last three, Kinsman stored none. */
export const LOWS_GAPPY: Valued = {
  ...LOWS_BOARD,
  sentinels: [
    site('clouds', 'Upper Lake of the Clouds', [34, 31, null, 30, 24, 29, 19, 25, 28, 33, 30, 31]),
    site('eagle', 'Eagle Lake', [...EAGLE.slice(0, 9), null, null, null]),
    site('kinsman', 'Kinsman Pond', new Array(12).fill(null)),
  ] as Valued['sentinels'],
};

/** A long season: every night from 1 October to 31 January, in a cold-warm wave with a few gaps. */
export const LOWS_WINTER: Valued = (() => {
  const nights = 123;
  const wave = (shift: number) =>
    Array.from({ length: nights }, (_, i) =>
      i % 37 === 11 ? null : Math.round(30 - i / 6 + 8 * Math.sin((i + shift) / 5)),
    );
  return {
    ...LOWS_BOARD,
    lastDate: '2027-01-31',
    sentinels: [
      site('clouds', 'Upper Lake of the Clouds', wave(0)),
      site(
        'eagle',
        'Eagle Lake',
        wave(2).map((v) => (v === null ? null : v + 2)),
      ),
      site(
        'kinsman',
        'Kinsman Pond',
        wave(4).map((v) => (v === null ? null : v + 5)),
      ),
    ] as Valued['sentinels'],
  };
})();
